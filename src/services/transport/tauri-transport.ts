/**
 * Tauri 桌面端串口传输驱动实现 (TauriTransport)
 * 封装 Rust 后端 IPC，实现 ISerialTransport 契约规范
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ISerialTransport,
  TransportKind,
  TransportCapabilities,
  SerialPortInfo,
  SerialOpenOptions,
  ParsedBatch,
  TransportStatus,
  TransportErrorCode,
  Unsubscribe,
  WriteReceipt,
  WriteResultEvent,
} from './types';
import { TransportError } from './types';
import type { WaveformBatch, LogLine, SerialStatusEvent } from '../../types/ipc';
import type { ProtocolConfig } from '../../core/protocol/types';

interface RustSerialPort {
  port_name: string;
  port_type: string;
  description: string | null;
  manufacturer: string | null;
  vid?: number | null;
  pid?: number | null;
}

export class TauriTransport implements ISerialTransport {
  readonly kind: TransportKind = 'tauri';
  readonly capabilities: TransportCapabilities = {
    canEnumerateAllPorts: true,
    requiresUserGestureToAddPort: false,
    globalEmergencyStop: true,
    fileSystemLogging: true,
  };

  private currentStatus: TransportStatus = 'idle';
  private connectedPortId: string | null = null;
  private activeSessionId: string | null = null;
  private activeChannelEpoch = 0;
  private isDisposed = false;
  private initPromise: Promise<void> | null = null;

  /** 获取当前连接的端口 ID */
  getConnectedPortId(): string | null {
    return this.connectedPortId;
  }

  /** 获取当前传输层状态 */
  getCurrentStatus(): TransportStatus {
    return this.currentStatus;
  }

  // 监听器集合
  private batchListeners = new Set<(batch: ParsedBatch) => void>();
  private errorListeners = new Set<(err: TransportError) => void>();
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private writeResultListeners = new Set<(result: WriteResultEvent) => void>();

  // 专门给需要原生批次视图（如 uPlot 高效直通）的观察者
  private waveformBatchListeners = new Set<(batch: WaveformBatch) => void>();
  private logsBatchListeners = new Set<(logs: LogLine[]) => void>();

  // Tauri IPC 事件退订句柄
  private unlisteners: UnlistenFn[] = [];
  private isEventListeningActive = false;
  private isChannelActive = false;
  private waveformChannel: Channel<WaveformBatch> | null = null;

  constructor() {
    this.initPromise = this.initTauriListeners().catch((err) => {
      console.warn('[TauriTransport] 初始化 Tauri 事件监听失败 (可能非 Tauri 宿主):', err);
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // 捕获环境初始化失败，不阻断后续调用尝试
      }
    }
  }

  /**
   * `connect_serial` returns before the IPC status event is necessarily
   * delivered to WebView. Do not send bytes in that small window: without the
   * active session identity a later write-result event would be indistinguish-
   * able from a stale request and would be discarded by the safety filter.
   */
  private async waitForSessionIdentity(timeoutMs = 2000): Promise<void> {
    if (this.activeSessionId) return;
    const deadline = Date.now() + timeoutMs;
    while (this.currentStatus === 'connected' && Date.now() < deadline) {
      if (this.activeSessionId) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!this.activeSessionId) {
      throw new TransportError('串口会话身份尚未确认，已阻止发送以避免把回执归入错误会话', 'Timeout');
    }
  }

  private async subscribeWaveformChannel(): Promise<void> {
    if (this.waveformChannel && this.isChannelActive) return;
    try {
      const channel = new Channel<WaveformBatch>();
      channel.onmessage = (batch) => this.handleWaveformBatch(batch);
      await invoke('subscribe_waveform_channel', { channel });
      this.waveformChannel = channel;
      this.isChannelActive = true;
    } catch (channelErr) {
      this.waveformChannel = null;
      this.isChannelActive = false;
      console.debug('[TauriTransport] 未挂载 Channel (将使用 waveform://batch 事件保底):', channelErr);
    }
  }

  private async unsubscribeWaveformChannel(): Promise<void> {
    if (!this.waveformChannel || !this.isChannelActive) return;
    try {
      await invoke('unsubscribe_waveform_channel');
    } catch (err) {
      console.debug('[TauriTransport] 清理波形 Channel 失败:', err);
    } finally {
      this.waveformChannel = null;
      this.isChannelActive = false;
    }
  }

  /**
   * 初始化 Tauri 底层事件分流监听
   */
  private async initTauriListeners(): Promise<void> {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }
    if (this.isEventListeningActive) return;
    this.isEventListeningActive = true;

    try {
      // 首次连接前注册高频通道。后端停止管线时会清除该 Channel，重连时重新订阅。
      await this.subscribeWaveformChannel();

      if (this.isDisposed) {
        return;
      }

      // 1. 监听 60Hz 波形批次事件 (全局事件保底)
      const uBatch = await listen<WaveformBatch>('waveform://batch', (event) => {
        if (!this.isChannelActive) {
          this.handleWaveformBatch(event.payload);
        }
      });
      this.unlisteners.push(uBatch);

      // 2. 监听 10Hz 格式化日志批次
      const uLogs = await listen<LogLine[]>('logs://batch', (event) => {
        const lines = Array.isArray(event.payload) ? event.payload : (event.payload as any)?.lines;
        if (lines && Array.isArray(lines)) {
          this.handleLogsBatch(lines);
        }
      });
      this.unlisteners.push(uLogs);

      // 3. 监听统一串口状态变更事件 (PRD 2.4.4 serial://status)
      const uStatus = await listen<SerialStatusEvent>('serial://status', (event) => {
        this.handleSerialStatus(event.payload);
      });
      this.unlisteners.push(uStatus);

      // Protocol changes create a new epoch inside the same connection.
      // Ignore delayed batches from the previous parser configuration.
      const uProtocolApplied = await listen<number>('protocol://applied', (event) => {
        this.handleProtocolApplied(Number(event.payload));
      });
      this.unlisteners.push(uProtocolApplied);

      const uWriteResult = await listen<WriteResultEvent>('serial://write-result', (event) => {
        this.handleWriteResult(event.payload);
      });
      this.unlisteners.push(uWriteResult);

      // 4. 监听设备物理断开事件 (向下兼容)
      const uDisconnect = await listen<{ port?: string; reason?: string }>('serial-disconnected', (event) => {
        this.activeSessionId = null;
        this.setStatus('device-lost');
        const reason = event.payload?.reason || '串口硬件异常断开';
        this.notifyError(new TransportError(reason, 'DeviceLost', event.payload));
      });
      this.unlisteners.push(uDisconnect);

      // 若在初始化异步期间已被释放，立即退订全部已注册句柄
      if (this.isDisposed) {
        for (const u of this.unlisteners) {
          try {
            u();
          } catch {}
        }
        this.unlisteners = [];
      }
    } catch (err) {
      this.isEventListeningActive = false;
      throw err;
    }
  }

  /**
   * 枚举系统当前可用物理串口与虚拟串口
   */
  async listPorts(): Promise<SerialPortInfo[]> {
    await this.ensureReady();
    try {
      const rawList = await invoke<RustSerialPort[]>('list_serial_ports');
      return rawList.map((p) => ({
        id: p.port_name,
        port_name: p.port_name,
        label: p.description ? `${p.port_name} (${p.description})` : p.port_name,
        port_type: p.port_type,
        description: p.description ?? undefined,
        manufacturer: p.manufacturer ?? undefined,
        usbVendorId: p.vid ?? undefined,
        usbProductId: p.pid ?? undefined,
      }));
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  /**
   * 打开指定串口并启动后端数据采集管线
   */
  async connect(portId: string, options: SerialOpenOptions): Promise<void> {
    await this.ensureReady();
    if (this.currentStatus === 'connected') {
      const err = new TransportError(`串口已连接至 ${this.connectedPortId}，请先断开当前连接`, 'AlreadyConnected');
      this.notifyError(err);
      throw err;
    }
    await this.subscribeWaveformChannel();
    this.activeSessionId = null;
    this.setStatus('connecting');
    try {
      if (portId === 'mock' || portId === 'VIRTUAL_COM') {
        await invoke('start_mock');
      } else {
        await invoke('connect_serial', {
          port: portId,
          baudRate: options.baudRate,
          baud_rate: options.baudRate,
          serialSettings: {
            dataBits: options.dataBits ?? 8,
            parity: options.parity ?? 'none',
            stopBits: options.stopBits ?? 1,
            flowControl: options.flowControl ?? 'none',
          },
        });
      }
      this.connectedPortId = portId;
      this.setStatus('connected');
    } catch (err) {
      this.activeSessionId = null;
      this.setStatus('error');
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  /**
   * 断开当前连接并停止管线
   */
  async disconnect(): Promise<void> {
    if (this.currentStatus === 'idle') return;
    this.setStatus('disconnecting');
    try {
      if (typeof window !== 'undefined') {
        await invoke('disconnect_serial');
      }
    } catch (err) {
      console.warn('[TauriTransport] 关闭串口管线警告:', err);
    } finally {
      this.connectedPortId = null;
      this.activeSessionId = null;
      await this.unsubscribeWaveformChannel();
      this.setStatus('idle');
    }
  }

  async configureProtocol(config: ProtocolConfig): Promise<void> {
    await this.ensureReady();
    try {
      await invoke('set_protocol_config', { config });
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  async setAcquisitionEnabled(enabled: boolean): Promise<void> {
    await this.ensureReady();
    try {
      await invoke('set_acquisition_enabled', { enabled });
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  /**
   * 向底层串口发送原始字节流
   */
  async write(data: Uint8Array): Promise<WriteReceipt> {
    await this.ensureReady();
    if (this.currentStatus !== 'connected') {
      const err = new TransportError('串口未连接，无法发送数据', 'NotConnected');
      this.notifyError(err);
      throw err;
    }
    await this.waitForSessionIdentity();
    try {
      return await invoke<WriteReceipt>('send_bytes', { bytes: Array.from(data) });
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  /**
   * 最高优先级急停专用通道：绕过普通发送队列直接清空并下发急停报文
   */
  async emergencyStop(frame: Uint8Array): Promise<void> {
    await this.ensureReady();
    try {
      await invoke('software_stop', { bytes: frame.length > 0 ? Array.from(frame) : null });
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  async resumeWrites(): Promise<void> {
    await this.ensureReady();
    try {
      await invoke('resume_writes');
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  /**
   * 订阅统一抽象批次数据（ samples + logLines ）
   */
  onBatch(cb: (batch: ParsedBatch) => void): Unsubscribe {
    this.batchListeners.add(cb);
    return () => {
      this.batchListeners.delete(cb);
    };
  }

  /**
   * 订阅错误通知
   */
  onError(cb: (err: TransportError) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  /**
   * 订阅状态变更通知
   */
  onStatusChange(cb: (status: TransportStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    // 立即通知当前状态
    cb(this.currentStatus);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  onWriteResult(cb: (result: WriteResultEvent) => void): Unsubscribe {
    this.writeResultListeners.add(cb);
    return () => this.writeResultListeners.delete(cb);
  }

  /**
   * 针对 WaveformViewer.vue 等专用组件的高性能直通批次订阅
   */
  onWaveformBatch(cb: (batch: WaveformBatch) => void): Unsubscribe {
    this.waveformBatchListeners.add(cb);
    return () => {
      this.waveformBatchListeners.delete(cb);
    };
  }

  /**
   * 针对 GeneralTerminal.vue 等组件的格式化日志批次订阅
   */
  onLogsBatch(cb: (logs: LogLine[]) => void): Unsubscribe {
    this.logsBatchListeners.add(cb);
    return () => {
      this.logsBatchListeners.delete(cb);
    };
  }

  /**
   * 销毁实例并释放底层监听
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {}
    }
    await this.disconnect();
    await this.unsubscribeWaveformChannel();
    for (const u of this.unlisteners) {
      try {
        u();
      } catch (e) {
        console.warn('[TauriTransport] 卸载事件监听错误:', e);
      }
    }
    this.unlisteners = [];
    this.isEventListeningActive = false;
    this.batchListeners.clear();
    this.errorListeners.clear();
    this.statusListeners.clear();
    this.writeResultListeners.clear();
    this.waveformBatchListeners.clear();
    this.logsBatchListeners.clear();
  }

  // --- 内部事件处理与转换 ---

  private handleWaveformBatch(batch: WaveformBatch): void {
    // IPC can deliver an in-flight batch after disconnect/reconnect or after a
    // protocol switch. Only the currently accepted session+epoch is live data.
    if (
      this.currentStatus !== 'connected' ||
      !this.activeSessionId ||
      batch.session_id !== this.activeSessionId ||
      batch.channel_epoch !== this.activeChannelEpoch
    ) {
      return;
    }

    // 1. 直通派发给专用波形观察者
    for (const listener of this.waveformBatchListeners) {
      try {
        listener(batch);
      } catch (err) {
        console.error('Error in waveformBatchListener:', err);
      }
    }

    // 2. 转换为通用 ParsedBatch 派发给通用观察者
    if (this.batchListeners.size > 0) {
      const parsed = this.convertWaveformBatchToParsed(batch);
      for (const listener of this.batchListeners) {
        try {
          listener(parsed);
        } catch (err) {
          console.error('Error in batchListener:', err);
        }
      }
    }
  }

  private handleProtocolApplied(epoch: number): void {
    if (this.activeSessionId && Number.isSafeInteger(epoch) && epoch > this.activeChannelEpoch) {
      this.activeChannelEpoch = epoch;
    }
  }

  private handleLogsBatch(lines: LogLine[]): void {
    // 1. 直通派发给专用日志观察者
    for (const listener of this.logsBatchListeners) {
      try {
        listener(lines);
      } catch (err) {
        console.error('Error in logsBatchListener:', err);
      }
    }

    // 格式化日志和逐行 raw_hex 都不是无损接收字节流；不得伪装成原始数据。
    // 转换为通用 ParsedBatch 派发给通用观察者
    if (this.batchListeners.size > 0 && lines.length > 0) {
      const parsed: ParsedBatch = {
        samples: [],
        logLines: lines.map((l) => ({
          t: l.timestamp_us / 1_000_000,
          text: l.text,
        })),
        droppedBytes: 0,
      };
      for (const listener of this.batchListeners) {
        try {
          listener(parsed);
        } catch (err) {
          console.error('Error in batchListener for logs:', err);
        }
      }
    }
  }

  private handleSerialStatus(payload: SerialStatusEvent): void {
    if (payload.reappeared) {
      // 串口重新插入，处于等待用户重连或自动重连状态
      this.setStatus('reconnecting');
      return;
    }

    if (payload.is_connected) {
      if (payload.channel_epoch < this.activeChannelEpoch) return;
      if (
        payload.channel_epoch === this.activeChannelEpoch &&
        this.activeSessionId &&
        payload.session_id !== this.activeSessionId
      ) return;
      this.activeSessionId = payload.session_id;
      this.activeChannelEpoch = payload.channel_epoch;
      this.connectedPortId = payload.port;
      this.setStatus('connected');
    } else {
      if (payload.channel_epoch < this.activeChannelEpoch) return;
      this.activeSessionId = null;
      this.activeChannelEpoch = Math.max(this.activeChannelEpoch, payload.channel_epoch);
      this.connectedPortId = null;
      // 后端停止/断线后旧 Channel 已失效；下一次连接时必须重新注册。
      this.waveformChannel = null;
      this.isChannelActive = false;
      if (payload.error) {
        const isDeviceLost =
          payload.error.includes('断开') ||
          payload.error.includes('拔出') ||
          payload.error.includes('Device') ||
          payload.error.includes('NotFound');
        this.setStatus(isDeviceLost ? 'device-lost' : 'error');
        this.notifyError(this.mapToTransportError(payload.error));
      } else {
        this.setStatus('idle');
      }
    }
  }

  private handleWriteResult(result: WriteResultEvent): void {
    // A delayed OS writer callback can arrive after reconnect or a protocol
    // switch. Do not let an old request advance a new tuning trial. Software
    // stop results remain observable after disconnect so the UI can explain
    // which queued requests were canceled.
    if (this.activeSessionId) {
      if (result.session_id !== this.activeSessionId || result.epoch !== this.activeChannelEpoch) return;
    } else if (result.source !== 'software_stop') {
      return;
    }
    for (const listener of this.writeResultListeners) {
      try {
        listener(result);
      } catch (error) {
        console.error('[TauriTransport] 写入结果监听器失败:', error);
      }
    }
  }

  private convertWaveformBatchToParsed(batch: WaveformBatch): ParsedBatch {
    const samples: { channel: string; t: number; v: number }[] = [];
    const channelNames = batch.channel_names || [];
    const timestamps = batch.timestamps || [];
    const series = batch.series || [];

    // 按严格时序推进（外层时间，内层通道），保证时序单调不回跳
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      for (let c = 0; c < channelNames.length; c++) {
        const s = series[c];
        if (!s) continue;
        const v = s[i];
        if (v !== undefined && v !== null && !Number.isNaN(v)) {
          samples.push({ channel: channelNames[c], t, v });
        }
      }
    }

    return {
      samples,
      logLines: [],
      droppedBytes: batch.dropped_bytes || 0,
    };
  }

  private setStatus(status: TransportStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        console.error('Error in statusListener:', err);
      }
    }
  }

  private notifyError(err: TransportError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(err);
      } catch (e) {
        console.error('Error in errorListener:', e);
      }
    }
  }

  private mapToTransportError(err: unknown): TransportError {
    if (err instanceof TransportError) return err;

    const msg = typeof err === 'string' ? err : (err as any)?.message || String(err);
    const lower = msg.toLowerCase();

    let code: TransportErrorCode = 'Unknown';
    if (
      lower.includes('access is denied') ||
      lower.includes('os error 5') ||
      lower.includes('被占用') ||
      lower.includes('port busy') ||
      lower.includes('in use')
    ) {
      code = 'PortBusy';
    } else if (
      lower.includes('permission denied') ||
      lower.includes('securityerror') ||
      lower.includes('not authorized') ||
      lower.includes('权限被拒绝') ||
      lower.includes('权限不足')
    ) {
      code = 'PermissionDenied';
    } else if (
      lower.includes('not found') ||
      lower.includes('找不到') ||
      lower.includes('no such file')
    ) {
      code = 'PortNotFound';
    } else if (lower.includes('timeout') || lower.includes('超时')) {
      code = 'Timeout';
    } else if (
      lower.includes('disconnect') ||
      lower.includes('拔出') ||
      lower.includes('device lost')
    ) {
      code = 'DeviceLost';
    } else if (lower.includes('overflow') || lower.includes('溢出')) {
      code = 'BufferOverflow';
    } else if (lower.includes('parity') || lower.includes('校验')) {
      code = 'ParityError';
    } else if (lower.includes('framing') || lower.includes('帧错误')) {
      code = 'FramingError';
    } else if (
      lower.includes('already connected') ||
      lower.includes('已连接') ||
      lower.includes('已经连接')
    ) {
      code = 'AlreadyConnected';
    } else if (
      lower.includes('not connected') ||
      lower.includes('未连接') ||
      lower.includes('未建立连接')
    ) {
      code = 'NotConnected';
    } else if (lower.includes('not supported') || lower.includes('不支持')) {
      code = 'NotSupported';
    }

    return new TransportError(msg, code, err);
  }
}
