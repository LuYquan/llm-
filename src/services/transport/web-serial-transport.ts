/**
 * Chromium Web Serial API 串口传输驱动实现 (WebSerialTransport)
 * 实现 ISerialTransport 契约规范，对齐 ADR 0006 与 dev-plan 阶段二规范
 */

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
import type { WaveformBatch } from '../../types/ipc';
import { TransportError } from './types';
import type { WorkerInMessage, WorkerOutMessage, RxOrigin, ReceiveContext } from './worker/types';
import { StreamDemuxer } from './worker/stream-demuxer';
import { createProtocolEngine } from '../../core/protocol/ProtocolEngine';
import type { ProtocolConfig } from '../../core/protocol/types';
import { validateProtocolConfig } from '../../core/protocol/types';

let webWriteSequence = 0;
let webSessionSequence = 0;

function makeWebWriteReceipt(byteCount: number, sessionId: string | null, epoch: number, rxDispatch?: WriteReceipt['rx_dispatch']): WriteReceipt {
  webWriteSequence += 1;
  return {
    request_id: `web-tx-${webWriteSequence}`,
    session_id: sessionId ?? undefined,
    epoch,
    byte_count: byteCount,
    status: 'written',
    ...(rxDispatch ? { rx_dispatch: rxDispatch } : {}),
  };
}

/** Web Serial API 原生接口类型辅助 */
interface WebSerialPort {
  open(options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
  }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): {
    usbVendorId?: number;
    usbProductId?: number;
  };
  setSignals?(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
    break?: boolean;
  }): Promise<void>;
}

interface OutboundTask {
  chunk: Uint8Array;
  isEmergency?: boolean;
  resolve: (receipt?: WriteReceipt) => void;
  reject: (err: any) => void;
}

export class WebSerialTransport implements ISerialTransport {
  readonly kind: TransportKind = 'webserial';
  readonly capabilities: TransportCapabilities = {
    canEnumerateAllPorts: false,
    requiresUserGestureToAddPort: true,
    globalEmergencyStop: false,
    fileSystemLogging: false,
  };

  get supportsSignals(): boolean {
    return !!this.activePort && typeof this.activePort.setSignals === 'function';
  }

  private currentStatus: TransportStatus = 'idle';
  private connectedPortId: string | null = null;
  private sessionId: string | null = null;
  private sessionEpoch = 0;
  private receiveEpoch = 0;
  private rxSequence = 0;
  private activePort: WebSerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private worker: Worker | null = null;

  private isClosing = false;
  private isOpen = false;
  private acquisitionEnabled = false;
  private writesLocked = false;

  // 发送队列管理（支持急停高优先级插队与清空待发队列）
  private normalWriteQueue: OutboundTask[] = [];
  private emergencyWriteQueue: OutboundTask[] = [];
  private isDrainingQueue = false;

  // 主线程分流兜底支持（在 Dedicated Web Worker 不可用或初始化失败时自动无缝接管）
  private fallbackDemuxer: StreamDemuxer | null = null;
  private fallbackProtocolEngine = createProtocolEngine({ type: 'firewater' });
  private protocolConfig: ProtocolConfig = { type: 'firewater' };
  private configureRequestId = 0;
  private protocolWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private fallbackBatchTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSamples: ParsedBatch['samples'] = [];
  private pendingFrames: NonNullable<ParsedBatch['frames']> = [];
  private pendingLogs: ParsedBatch['logLines'] = [];
  private droppedBytesCount = 0;
  private pendingProtocolErrors = 0;
  private lastFallbackDemuxErrors = 0;
  private connectTimeMs = 0;
  private fallbackReceiveContext: ReceiveContext | undefined;

  // 内部端口映射池：ID -> SerialPort
  private portMap = new Map<string, WebSerialPort>();
  private portIdMap = new WeakMap<WebSerialPort, string>();
  private nextPortIndex = 1;

  // Mock 虚拟仿真支持
  private mockTimer: any = null;
  private mockT = 0;
  private mockY = 0;
  private mockDy = 0;
  private mockTarget = 10;
  private mockIntegral = 0;
  private mockPrevErr = 0;
  private mockKp = 1.8;
  private mockKi = 0.6;
  private mockKd = 0.25;

  private startMockSimulation(): void {
    this.stopMockSimulation();
    this.mockT = 0;
    this.mockY = 0;
    this.mockDy = 0;
    this.mockTarget = 10;
    this.mockIntegral = 0;
    this.mockPrevErr = 0;
    const dt = 0.02; // 50Hz
    const omega_n = 4.0;
    const zeta = 0.35;

    this.mockTimer = setInterval(() => {
      if (this.currentStatus !== 'connected' || this.isClosing || !this.acquisitionEnabled) return;

      const cycle = Math.floor(this.mockT / 5) % 2;
      this.mockTarget = cycle === 0 ? 10.0 : 20.0;

      const err = this.mockTarget - this.mockY;
      this.mockIntegral += err * dt;
      this.mockIntegral = Math.max(-50, Math.min(50, this.mockIntegral));
      const deriv = (err - this.mockPrevErr) / dt;
      this.mockPrevErr = err;

      const u = this.mockKp * err + this.mockKi * this.mockIntegral + this.mockKd * deriv;
      const ddy = omega_n * omega_n * u - 2 * zeta * omega_n * this.mockDy - omega_n * omega_n * this.mockY;
      this.mockDy += ddy * dt;
      this.mockY += this.mockDy * dt;
      this.mockT += dt;

      const line = `${this.mockTarget.toFixed(3)},${this.mockY.toFixed(3)},${u.toFixed(3)}\n`;
      const chunk = new TextEncoder().encode(line);

      // Keep the mock source on the same raw-byte path as a physical port so
      // browser recording and diagnostics observe exactly what the parser sees.
      if (this.rawDataListeners.size > 0) {
        for (const listener of this.rawDataListeners) {
          try {
            listener(new Uint8Array(chunk));
          } catch (err) {
            console.error('[WebSerialTransport] mock rawDataListener 异常:', err);
          }
        }
      }

      if (this.worker) {
        const copy = new Uint8Array(chunk);
        this.worker.postMessage({ type: 'CHUNK', data: copy }, [copy.buffer]);
      } else {
        this.processChunkOnMainThread(chunk);
      }
    }, 20);
  }

  private stopMockSimulation(): void {
    if (this.mockTimer) {
      clearInterval(this.mockTimer);
      this.mockTimer = null;
    }
  }

  // 监听器集合
  private batchListeners = new Set<(batch: ParsedBatch) => void>();
  private rawDataListeners = new Set<(chunk: Uint8Array) => void>();
  private errorListeners = new Set<(err: TransportError) => void>();
  private statusListeners = new Set<(status: TransportStatus) => void>();

  constructor() {
    this.registerHotplugListeners();
  }

  /** 获取当前连接端口 ID */
  getConnectedPortId(): string | null {
    return this.connectedPortId;
  }

  /** 获取当前状态 */
  getCurrentStatus(): TransportStatus {
    return this.currentStatus;
  }

  /**
   * 注册 Chromium navigator.serial 原生热插拔事件
   */
  private registerHotplugListeners(): void {
    if (
      typeof navigator !== 'undefined' &&
      'serial' in navigator &&
      typeof (navigator as any).serial?.addEventListener === 'function'
    ) {
      (navigator as any).serial.addEventListener('connect', this.handleConnect);
      (navigator as any).serial.addEventListener('disconnect', this.handleDisconnect);
    }
  }

  private handleConnect = (_event: Event): void => {
    // 发现新授权或重新插入的端口，刷新缓存
    this.listPorts().catch(() => {});
  };

  private handleDisconnect = (event: Event): void => {
    const serialEvent = event as any;
    const disconnectedPort = serialEvent?.port as WebSerialPort | undefined;

    if (disconnectedPort && disconnectedPort === this.activePort) {
      // 当前通信中的设备被硬件拔出
      this.setStatus('device-lost');
      const err = new TransportError('串口设备已被拔出 (device-lost)', 'DeviceLost');
      this.notifyError(err);
      this.disconnect('device-lost').catch(() => {});
    }
  };

  /**
   * 生成并维护稳定端口信息映射
   */
  private registerPort(port: WebSerialPort): SerialPortInfo {
    let id = this.portIdMap.get(port);
    if (!id) {
      const info = port.getInfo();
      if (info.usbVendorId && info.usbProductId) {
        id = `webserial-${info.usbVendorId.toString(16).padStart(4, '0')}:${info.usbProductId.toString(16).padStart(4, '0')}-${this.nextPortIndex++}`;
      } else {
        id = `webserial-port-${this.nextPortIndex++}`;
      }
      this.portIdMap.set(port, id);
    }
    this.portMap.set(id, port);

    const info = port.getInfo();
    let label = `Web 串口设备 (${id})`;
    if (info.usbVendorId) {
      const vidHex = info.usbVendorId.toString(16).padStart(4, '0').toUpperCase();
      const pidHex = (info.usbProductId || 0).toString(16).padStart(4, '0').toUpperCase();
      label = `USB 串口 (VID:0x${vidHex} PID:0x${pidHex})`;
    }

    return {
      id,
      port_name: id,
      label,
      port_type: 'WebSerial',
      description: label,
      usbVendorId: info.usbVendorId,
      usbProductId: info.usbProductId,
    };
  }

  /**
   * 枚举浏览器已授权的串口列表（免重复授权）
   */
  async listPorts(): Promise<SerialPortInfo[]> {
    const list: SerialPortInfo[] = [
      {
        id: 'mock',
        port_name: 'mock',
        label: '虚拟仿真设备 (Mock 100Hz)',
        port_type: 'Mock',
        description: '内建二阶系统 PID 阶跃仿真数据源',
      },
    ];
    if (
      typeof navigator === 'undefined' ||
      !('serial' in navigator) ||
      typeof (navigator as any).serial?.getPorts !== 'function'
    ) {
      return list;
    }

    try {
      const ports = (await (navigator as any).serial.getPorts()) as WebSerialPort[];
      list.push(...ports.map((p) => this.registerPort(p)));
      return list;
    } catch (err) {
      console.warn('[WebSerialTransport] 获取已授权串口列表异常:', err);
      return list;
    }
  }

  /**
   * 触发浏览器原生端口授权面板（必须由用户手势点击事件触发）
   */
  async requestPort(filters?: { usbVendorId?: number }[]): Promise<SerialPortInfo | null> {
    if (
      typeof navigator === 'undefined' ||
      !('serial' in navigator) ||
      typeof (navigator as any).serial?.requestPort !== 'function'
    ) {
      const err = new TransportError(
        '当前运行环境不支持 Web Serial 串口通信。',
        'NotSupported'
      );
      this.notifyError(err);
      throw err;
    }

    try {
      const port = (await (navigator as any).serial.requestPort({
        filters,
      })) as WebSerialPort;
      if (!port) return null;
      return this.registerPort(port);
    } catch (err: any) {
      if (err?.name === 'NotFoundError') {
        // 用户主动关闭了选择弹窗，优雅返回 null
        return null;
      }
      if (err?.name === 'SecurityError') {
        const secErr = new TransportError(
          '串口授权被拒绝：必须由直接用户手势（如点击按钮）触发，或页面嵌入了缺少 allow="serial" 的 iframe。',
          'PermissionDenied',
          err
        );
        this.notifyError(secErr);
        throw secErr;
      }
      const transErr = new TransportError(
        `请求串口权限失败: ${err?.message || err}`,
        'Unknown',
        err
      );
      this.notifyError(transErr);
      throw transErr;
    }
  }

  /**
   * 连接并打开指定串口
   */
  async connect(portId: string, options: SerialOpenOptions): Promise<void> {
    if (this.currentStatus === 'connected') {
      const err = new TransportError('串口已处于连接状态，请勿重复操作', 'AlreadyConnected');
      this.notifyError(err);
      throw err;
    }

    if (portId === 'mock' || portId === 'VIRTUAL_COM') {
      this.setStatus('connecting');
      this.connectedPortId = portId;
      this.sessionId = `web-session-${Date.now()}-${++webSessionSequence}`;
      this.sessionEpoch = 1;
      this.receiveEpoch = 1;
      this.rxSequence = 0;
      this.isOpen = true;
      this.acquisitionEnabled = true;
      this.isClosing = false;
      this.connectTimeMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.normalWriteQueue = [];
      this.emergencyWriteQueue = [];
      this.isDrainingQueue = false;
      this.initWorker();
      this.startMockSimulation();
      this.setStatus('connected');
      return;
    }

    const port = this.portMap.get(portId);
    if (!port) {
      const err = new TransportError(
        `未找到端口 [${portId}]。请先点击“添加串口”完成授权。`,
        'PortNotFound'
      );
      this.notifyError(err);
      throw err;
    }

    this.setStatus('connecting');

    try {
      // 显式指定 bufferSize（默认调大至 64KB，防止 921600 高波特率下 BufferOverrunError）
      const bufferSize = options.bufferSize || 65536;

      await port.open({
        baudRate: options.baudRate,
        dataBits: options.dataBits ?? 8,
        stopBits: options.stopBits ?? 1,
        parity: options.parity ?? 'none',
        flowControl: options.flowControl ?? 'none',
        bufferSize,
      });

      this.activePort = port;
      this.connectedPortId = portId;
      this.sessionId = `web-session-${Date.now()}-${++webSessionSequence}`;
      this.sessionEpoch = 1;
      this.receiveEpoch = 1;
      this.rxSequence = 0;
      this.isOpen = true;
      this.acquisitionEnabled = true;
      this.isClosing = false;
      this.connectTimeMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

      // 清空旧队列
      this.normalWriteQueue = [];
      this.emergencyWriteQueue = [];
      this.isDrainingQueue = false;

      // 启动专属 Dedicated Web Worker 或主线程 fallback 分流器
      this.initWorker();

      // 获取写入器
      if (port.writable) {
        this.writer = port.writable.getWriter();
      }

      // 启动流读取循环
      this.readLoopPromise = this.startReadLoop(port);

      this.setStatus('connected');
    } catch (err: any) {
      this.setStatus('error');
      const mapped = this.mapToTransportError(err);
      this.notifyError(mapped);
      await this.disconnect().catch(() => {});
      throw mapped;
    }
  }

  /**
   * 初始化 Dedicated Web Worker 分流器（失败时降级主线程兼容模式）
   */
  private initWorker(): void {
    if (typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(
          new URL('./worker/demuxer.worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.worker = worker;

        this.worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
          const msg = event.data;
          if (!msg || this.worker !== worker) return;

          if (msg.type === 'BATCH') {
            for (const listener of this.batchListeners) {
              try {
                listener(msg.batch);
              } catch (e) {
                console.error('[WebSerialTransport] 派发 ParsedBatch 异常:', e);
              }
            }
          } else if (msg.type === 'CONFIGURED') {
            const waiter = this.protocolWaiters.get(msg.requestId);
            if (waiter) {
              clearTimeout(waiter.timer);
              this.protocolWaiters.delete(msg.requestId);
              if (msg.error) waiter.reject(new Error(msg.error));
              else waiter.resolve();
            }
          }
        };

        this.worker.onerror = (wErr) => {
          console.error('[WebSerialTransport] Worker 分流器运行时异常:', wErr);
          this.rejectProtocolWaiters(new Error(wErr.message || 'Web Worker 发生错误'));
        };
        this.worker.postMessage({
          type: 'CONFIGURE',
          batchIntervalMs: 16,
          protocolConfig: JSON.parse(JSON.stringify(this.protocolConfig)) as ProtocolConfig,
          ...(this.sessionId ? { receiveContext: { session_id: this.sessionId, epoch: this.receiveEpoch } } : {}),
        } satisfies WorkerInMessage);
      } catch (workerInitErr) {
        console.warn(
          '[WebSerialTransport] 创建 Dedicated Web Worker 失败，将采用主线程兼容模式:',
          workerInitErr
        );
        this.worker?.terminate();
        this.worker = null;
      }
    }

    if (!this.worker) {
      // 启动主线程分流器兜底
      this.fallbackDemuxer = new StreamDemuxer();
      this.fallbackProtocolEngine = createProtocolEngine(this.protocolConfig);
      this.pendingSamples = [];
      this.pendingFrames = [];
      this.pendingLogs = [];
      this.droppedBytesCount = 0;
      this.pendingProtocolErrors = 0;
      this.lastFallbackDemuxErrors = 0;
      this.fallbackReceiveContext = this.sessionId ? { session_id: this.sessionId, epoch: this.receiveEpoch } : undefined;
      if (this.fallbackBatchTimer) clearInterval(this.fallbackBatchTimer);
      this.fallbackBatchTimer = setInterval(() => {
        this.flushFallbackBatch();
      }, 16);
    }
  }

  /**
   * 主线程流分流兜底处理
   */
  private processChunkOnMainThread(chunk: Uint8Array, rxOrigin?: RxOrigin, timestampUs?: number): void {
    const baseTs = timestampUs ?? Math.round(
      ((typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        this.connectTimeMs) *
        1000
    );

    if (this.protocolConfig.type !== 'firewater') {
      if (this.protocolConfig.type === 'rawdata' && this.protocolConfig.mode === 'display') return;
      const output = this.fallbackProtocolEngine.feed(chunk, baseTs);
      this.droppedBytesCount += output.droppedBytes;
      this.pendingProtocolErrors += output.errorCount;
      for (const frame of output.frames) {
        this.pendingFrames.push(frame);
        for (let index = 0; index < frame.values.length; index++) {
          const value = frame.values[index];
          if (Number.isFinite(value)) this.pendingSamples.push({ channel: frame.channelNames?.[index] ?? `ch${index}`, t: frame.timestampUs / 1_000_000, v: value });
        }
      }
      for (const log of output.logs) this.pendingLogs.push({ t: log.timestampUs / 1_000_000, text: log.text });
      if (this.pendingSamples.length >= 200 || this.pendingFrames.length >= 200 || this.pendingLogs.length >= 100 || output.droppedBytes > 0) this.flushFallbackBatch();
      return;
    }

    if (!this.fallbackDemuxer) return;
    const lines = this.fallbackDemuxer.processBytesWithOrigin(chunk, rxOrigin);
    if (lines.length === 0) {
      this.flushFallbackBatch();
      return;
    }

    for (let i = 0; i < lines.length; i++) {
      const lineTs = baseTs + i * 1000;
      const result = this.fallbackDemuxer.demuxLine(lines[i].text, lineTs, 'Rx');

      if (result.type === 'sample') {
        const channels = this.fallbackDemuxer.channelNames();
        const tSec = result.sample.timestamp_us / 1_000_000;
        for (let c = 0; c < channels.length; c++) {
          const v = result.sample.values[c];
          if (v !== undefined && v !== null && Number.isFinite(v)) {
            this.pendingSamples.push({
              channel: channels[c],
              t: tSec,
              v,
            });
          }
        }
        if (this.pendingSamples.length > 20000) {
          const overflow = this.pendingSamples.length - 20000;
          this.pendingSamples.splice(0, overflow);
          this.droppedBytesCount += overflow * 16;
        }
      } else if (result.type === 'log') {
        this.pendingLogs.push({
          t: result.log.timestamp_us / 1_000_000,
          text: result.log.text,
          ...(lines[i].rx_origin ? { rx_origin: lines[i].rx_origin } : {}),
        });
        if (this.pendingLogs.length > 5000) {
          const overflow = this.pendingLogs.length - 5000;
          this.pendingLogs.splice(0, overflow);
        }
      }
    }

    if (this.pendingSamples.length >= 200 || this.pendingLogs.length >= 100) {
      this.flushFallbackBatch();
    }
  }

  private flushFallbackBatch(force = false): void {
    // Pausing acquisition must create a clean delivery boundary. Samples that
    // already entered the fallback buffer are retained and delivered after
    // resume; they must not appear as a late batch while the UI says paused.
    // Disconnect uses force=true so shutdown still flushes the final prefix.
    if (!force && this.isOpen && !this.acquisitionEnabled) return;
    if (this.fallbackDemuxer) {
      const demuxErrors = this.fallbackDemuxer.errorCount();
      if (demuxErrors > this.lastFallbackDemuxErrors) {
        this.pendingProtocolErrors += demuxErrors - this.lastFallbackDemuxErrors;
      }
      this.lastFallbackDemuxErrors = demuxErrors;
    }

    if (
      this.pendingSamples.length === 0 &&
      this.pendingFrames.length === 0 &&
      this.pendingLogs.length === 0 &&
      this.droppedBytesCount === 0 &&
      this.pendingProtocolErrors === 0
    ) {
      return;
    }

    const batch: ParsedBatch = {
      ...(this.fallbackReceiveContext ? { session_id: this.fallbackReceiveContext.session_id, channel_epoch: this.fallbackReceiveContext.epoch } : {}),
      samples: this.pendingSamples,
      frames: this.pendingFrames.length > 0 ? this.pendingFrames : undefined,
      logLines: this.pendingLogs,
      droppedBytes: this.droppedBytesCount,
      protocolErrors: this.pendingProtocolErrors,
    };

    this.pendingSamples = [];
    this.pendingFrames = [];
    this.pendingLogs = [];
    this.droppedBytesCount = 0;
    this.pendingProtocolErrors = 0;

    for (const listener of this.batchListeners) {
      try {
        listener(batch);
      } catch (err) {
        console.error('[WebSerialTransport] 派发 fallback ParsedBatch 异常:', err);
      }
    }
  }

  private rejectProtocolWaiters(error: Error): void {
    for (const waiter of this.protocolWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.protocolWaiters.clear();
  }

  private nextReadOrigin(): RxOrigin | undefined {
    this.rxSequence += 1;
    if (!this.sessionId || !Number.isSafeInteger(this.rxSequence)) return undefined;
    return {
      source: 'web-serial-read',
      session_id: this.sessionId,
      epoch: this.receiveEpoch,
      first_rx_sequence: this.rxSequence,
      last_rx_sequence: this.rxSequence,
    };
  }

  /**
   * 启动后台连续读取循环并具备可恢复错误容错重试机制
   */
  private async startReadLoop(port: WebSerialPort): Promise<void> {
    let streamEnded = false;

    while (this.isOpen && !this.isClosing && !streamEnded) {
      if (!port.readable) {
        break;
      }

      try {
        this.reader = port.readable.getReader();
      } catch (lockErr) {
        if (!this.isClosing) {
          console.warn('[WebSerialTransport] 获取 readable reader 锁失败:', lockErr);
        }
        break;
      }

      try {
        while (this.isOpen && !this.isClosing) {
          if (!this.acquisitionEnabled) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            continue;
          }
          const { value, done } = await this.reader.read();
          if (done) {
            streamEnded = true;
            break;
          }
          if (value && value.length > 0) {
            // Allocate before observers can synchronously dispatch a write. This
            // records read() return order, not a device/UART arrival timestamp.
            const rxOrigin = this.nextReadOrigin();
            const timestampUs = Math.round(
              ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.connectTimeMs) * 1000
            );
            // 派发给 rawData 观察者
            if (this.rawDataListeners.size > 0) {
              for (const listener of this.rawDataListeners) {
                try {
                  listener(value);
                } catch (err) {
                  console.error('[WebSerialTransport] rawDataListener 异常:', err);
                }
              }
            }

            // 派发至 Dedicated Web Worker 进行零主线程占用协议分流
            if (this.worker) {
              const msg: WorkerInMessage = {
                type: 'CHUNK',
                data: value,
                timestampUs,
                ...(rxOrigin ? { rxOrigin } : {}),
              };
              // 安全转移 ArrayBuffer 达到零拷贝性能
              const transferBuffer =
                value.buffer instanceof ArrayBuffer &&
                value.byteOffset === 0 &&
                value.byteLength === value.buffer.byteLength
                  ? value.buffer
                  : value.slice().buffer;
              try {
                this.worker.postMessage(msg, [transferBuffer]);
              } catch {
                this.worker.postMessage(msg);
              }
            } else {
              // 主线程兼容分流兜底
              this.processChunkOnMainThread(value, rxOrigin, timestampUs);
            }
          }
        }
      } catch (readErr: any) {
        if (this.isClosing) {
          break;
        }

        const errName = String(readErr?.name || '');
        const errMsg = String(readErr?.message || readErr);

        // 判断是否为硬件串口可恢复错误 (BufferOverrun, Framing, Parity)
        const isBufferOverrun =
          errName === 'BufferOverrunError' ||
          errMsg.includes('Buffer overrun') ||
          errMsg.includes('overflow');
        const isFraming =
          errName === 'FramingError' || errMsg.includes('framing');
        const isParity =
          errName === 'ParityError' || errMsg.includes('parity');

        const isRecoverable = isBufferOverrun || isFraming || isParity;

        if (isRecoverable) {
          const code: TransportErrorCode = isBufferOverrun
            ? 'BufferOverflow'
            : isFraming
            ? 'FramingError'
            : 'ParityError';

          const transErr = new TransportError(
            `串口通信发生可恢复故障 (${errName}): ${errMsg}。正在自动恢复...`,
            code,
            readErr
          );
          this.notifyError(transErr);

          // 依据 W3C Web Serial 规范：释放当前锁并重新获取 reader 继续读循环
          try {
            this.reader.releaseLock();
          } catch {}
          this.reader = null;
          continue;
        } else {
          // 不可恢复错误（如设备意外拔出、系统 I/O 错误）
          const isDeviceLost =
            errName === 'NetworkError' ||
            errMsg.includes('device lost') ||
            errMsg.includes('disconnected') ||
            errMsg.includes('拔出');

          this.setStatus(isDeviceLost ? 'device-lost' : 'error');
          const transErr = new TransportError(
            `串口通信不可恢复中断: ${errMsg}`,
            isDeviceLost ? 'DeviceLost' : 'Unknown',
            readErr
          );
          this.notifyError(transErr);
          // 异步触发资源清理，防止资源句柄残留
          this.disconnect(isDeviceLost ? 'device-lost' : 'error').catch(() => {});
          break;
        }
      } finally {
        if (this.reader) {
          try {
            this.reader.releaseLock();
          } catch {}
          this.reader = null;
        }
      }

      if (streamEnded) {
        break;
      }
    }
  }

  /**
   * 严格保证关闭顺序：reader.cancel() → reader.releaseLock() → writer.releaseLock() → port.close()
   */
  async disconnect(finalStatus: TransportStatus = 'idle'): Promise<void> {
    if (this.currentStatus === 'idle' && !this.activePort) {
      return;
    }

    this.isClosing = true;
    this.acquisitionEnabled = false;
    if (finalStatus !== 'device-lost') {
      this.setStatus('disconnecting');
    }

    // 1. 取消正在阻塞的 reader 并释放读锁
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
    }

    // 2. 等待读循环退出 (startReadLoop 的 finally 会调用 reader.releaseLock())
    if (this.readLoopPromise) {
      try {
        await this.readLoopPromise;
      } catch {}
      this.readLoopPromise = null;
    }

    if (this.reader) {
      try {
        this.reader.releaseLock();
      } catch {}
      this.reader = null;
    }

    // 3. 取消并清空待发队列与急停队列，释放写入锁
    if (this.normalWriteQueue.length > 0) {
      const tasks = this.normalWriteQueue.splice(0);
      const disErr = new TransportError('串口连接已断开', 'NotConnected');
      for (const t of tasks) t.reject(disErr);
    }
    if (this.emergencyWriteQueue.length > 0) {
      const tasks = this.emergencyWriteQueue.splice(0);
      const disErr = new TransportError('串口连接已断开', 'NotConnected');
      for (const t of tasks) t.reject(disErr);
    }

    if (this.writer) {
      try {
        await this.writer.abort();
      } catch {}
      try {
        this.writer.releaseLock();
      } catch {}
      this.writer = null;
    }

    // 4. 关闭物理端口
    if (this.activePort) {
      try {
        await this.activePort.close();
      } catch (closeErr) {
        console.warn('[WebSerialTransport] 端口 close() 异常:', closeErr);
      }
      this.activePort = null;
    }

    // 5. 停止 Mock 仿真计时器
    this.stopMockSimulation();

    // 6. 终止 Dedicated Web Worker 与主线程 fallback 资源
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'RESET' });
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
    this.rejectProtocolWaiters(new Error('串口已断开，协议配置请求已取消'));

    if (this.fallbackBatchTimer) {
      clearInterval(this.fallbackBatchTimer);
      this.fallbackBatchTimer = null;
    }
    this.flushFallbackBatch(true);
    if (this.fallbackDemuxer) {
      this.fallbackDemuxer.reset();
      this.fallbackDemuxer = null;
    }
    this.fallbackProtocolEngine.reset();
    this.pendingProtocolErrors = 0;
    this.lastFallbackDemuxErrors = 0;

    this.isOpen = false;
    this.isClosing = false;
    this.connectedPortId = null;
    this.sessionId = null;
    this.sessionEpoch = 0;
    this.receiveEpoch = 0;
    this.rxSequence = 0;
    this.fallbackReceiveContext = undefined;
    this.setStatus(finalStatus);
  }

  async setAcquisitionEnabled(enabled: boolean): Promise<void> {
    if (!this.isOpen || !this.activePort && this.connectedPortId !== 'mock' && this.connectedPortId !== 'VIRTUAL_COM') {
      throw new TransportError('串口未连接，无法改变采集状态', 'NotConnected');
    }
    this.acquisitionEnabled = enabled;
  }

  /**
   * 向串口写入数据 (排入待发队列并在后台串行发送)
   */
  async configureProtocol(config: ProtocolConfig): Promise<void> {
    const validationError = validateProtocolConfig(config);
    if (validationError) throw new TransportError(validationError, 'Unknown');
    // Vue passes reactive proxies from configuration forms. Worker messages and
    // retained parser state must own a clone that the caller cannot mutate.
    config = JSON.parse(JSON.stringify(config)) as ProtocolConfig;
    if (this.worker) {
      const requestId = ++this.configureRequestId;
      const nextEpoch = this.sessionId ? Math.max(this.receiveEpoch, this.sessionEpoch) + 1 : 0;
      // postMessage and the read loop share one JS thread. Advance the input
      // identity before posting CONFIGURE so FIFO CHUNKs after it use the new
      // epoch even while the CONFIGURED reply is still pending.
      this.receiveEpoch = nextEpoch;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.protocolWaiters.delete(requestId);
          reject(new Error('等待 Web Worker 应用协议配置超时'));
        }, 5000);
        this.protocolWaiters.set(requestId, { resolve, reject, timer });
        try {
          this.worker?.postMessage({ type: 'CONFIGURE', protocolConfig: config, requestId,
            ...(this.sessionId ? { receiveContext: { session_id: this.sessionId, epoch: nextEpoch } } : {}),
          } satisfies WorkerInMessage);
        } catch (error) {
          clearTimeout(timer);
          this.protocolWaiters.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      this.protocolConfig = config;
      if (this.sessionId) this.sessionEpoch = nextEpoch;
      return;
    }

    this.protocolConfig = config;
    this.fallbackProtocolEngine = createProtocolEngine(config);
    this.fallbackDemuxer?.reset();
    this.pendingSamples = [];
    this.pendingFrames = [];
    this.pendingLogs = [];
    this.droppedBytesCount = 0;
    this.pendingProtocolErrors = 0;
    this.lastFallbackDemuxErrors = 0;
    if (this.sessionId) {
      this.sessionEpoch = Math.max(this.receiveEpoch, this.sessionEpoch) + 1;
      this.receiveEpoch = this.sessionEpoch;
    }
    this.fallbackReceiveContext = this.sessionId ? { session_id: this.sessionId, epoch: this.receiveEpoch } : undefined;
  }

  async write(data: Uint8Array): Promise<WriteReceipt> {
    if (this.writesLocked) {
      const err = new TransportError('软件停止屏障已锁定发送；请确认设备状态后显式恢复发送', 'NotConnected');
      this.notifyError(err);
      throw err;
    }
    if (this.currentStatus !== 'connected' || !this.isOpen) {
      const err = new TransportError('串口未连接，无法发送数据', 'NotConnected');
      this.notifyError(err);
      throw err;
    }
    if (this.receiveEpoch !== this.sessionEpoch) {
      throw new TransportError('协议切换尚未确认，暂停普通发送', 'Unknown');
    }

    if (this.connectedPortId === 'mock' || this.connectedPortId === 'VIRTUAL_COM') {
      const text = new TextDecoder().decode(data);
      if (text.includes('SET:PID')) {
        const parts = text.trim().split(',');
        if (parts.length >= 4) {
          const kp = parseFloat(parts[1]);
          const ki = parseFloat(parts[2]);
          const kd = parseFloat(parts[3]);
          if (!isNaN(kp)) this.mockKp = kp;
          if (!isNaN(ki)) this.mockKi = ki;
          if (!isNaN(kd)) this.mockKd = kd;
        }
      } else if (text.includes('CMD:STOP')) {
        this.mockTarget = 0;
        this.mockDy = 0;
      } else if (text.includes('RST')) {
        this.mockY = 0;
        this.mockDy = 0;
        this.mockIntegral = 0;
        this.mockPrevErr = 0;
      }
      return makeWebWriteReceipt(data.length, this.sessionId, this.sessionEpoch);
    }

    if (!this.writer) {
      const err = new TransportError('串口未连接，无法发送数据', 'NotConnected');
      this.notifyError(err);
      throw err;
    }

    if (this.normalWriteQueue.length >= 200) {
      const err = new TransportError('待发数据队列已满 (超过 200 帧)', 'BufferOverflow');
      this.notifyError(err);
      throw err;
    }

    return new Promise<WriteReceipt>((resolve, reject) => {
      this.normalWriteQueue.push({ chunk: data, resolve: receipt => {
        if (receipt) resolve(receipt);
        else reject(new TransportError('缺少 Web Serial 写入回执', 'Unknown'));
      }, reject });
      this.drainWriteQueue().catch(() => {});
    });
  }

  /**
   * 急停专用通道：立即清空待发状态并优先下发急停报文 (ADR 0004)
   */
  async emergencyStop(frame: Uint8Array = new Uint8Array()): Promise<void> {
    this.writesLocked = true;
    if (this.normalWriteQueue.length > 0) {
      const cancelledTasks = this.normalWriteQueue.splice(0);
      const cancelErr = new TransportError('已触发软件停止，待发队列已取消', 'Timeout');
      for (const task of cancelledTasks) task.reject(cancelErr);
    }
    if (this.connectedPortId === 'mock' || this.connectedPortId === 'VIRTUAL_COM') {
      this.mockTarget = 0;
      this.mockDy = 0;
      this.mockIntegral = 0;
      return;
    }
    if (frame.length === 0) return;
    if (this.currentStatus !== 'connected' || !this.isOpen) {
      const err = new TransportError('串口未连接，无法发送急停指令', 'NotConnected');
      this.notifyError(err);
      throw err;
    }

    if (!this.writer) {
      const err = new TransportError('串口未连接，无法发送急停指令', 'NotConnected');
      this.notifyError(err);
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      this.emergencyWriteQueue.push({ chunk: frame, isEmergency: true, resolve: () => resolve(), reject });
      this.drainWriteQueue().catch(() => {});
    });
  }

  async resumeWrites(): Promise<void> {
    if (this.currentStatus !== 'connected' || !this.isOpen) {
      throw new TransportError('串口未连接；软件停止锁保持启用', 'NotConnected');
    }
    this.writesLocked = false;
  }

  /**
   * 串行排干发送队列 (优先处理急停队列)
   */
  private async drainWriteQueue(): Promise<void> {
    if (this.isDrainingQueue) return;
    this.isDrainingQueue = true;

    try {
      while (
        (this.emergencyWriteQueue.length > 0 || this.normalWriteQueue.length > 0) &&
        this.writer &&
        this.isOpen &&
        !this.isClosing
      ) {
        const task =
          this.emergencyWriteQueue.length > 0
            ? this.emergencyWriteQueue.shift()!
            : this.normalWriteQueue.shift()!;

        try {
          if (!task.isEmergency && this.receiveEpoch !== this.sessionEpoch) {
            throw new TransportError('协议切换尚未确认，待发普通命令已拒绝', 'Unknown');
          }
          // Freeze at actual WritableStream dispatch, not enqueue time or the
          // later Promise resolution. An early device reply can then remain
          // eligible while a pre-dispatch parsed batch cannot become newer.
          const sessionId = this.sessionId;
          const epoch = this.sessionEpoch;
          const rxDispatch = sessionId ? {
            source: 'web-serial-read' as const,
            session_id: sessionId,
            epoch,
            rx_sequence: this.rxSequence,
          } : undefined;
          const receipt = task.isEmergency ? undefined : makeWebWriteReceipt(task.chunk.length, sessionId, epoch, rxDispatch);
          await this.writer.write(task.chunk);
          task.resolve(receipt);
        } catch (err: any) {
          const transErr = this.mapToTransportError(err);
          task.reject(transErr);
          this.notifyError(transErr);
        }
      }
    } finally {
      this.isDrainingQueue = false;
    }
  }

  /**
   * 控制物理串口信号引脚 (DTR / RTS / Break)
   */
  async setSignals(signals: { dtr?: boolean; rts?: boolean; brk?: boolean }): Promise<void> {
    if (!this.activePort) {
      throw new TransportError('串口未连接，无法设置物理信号', 'NotConnected');
    }
    if (typeof this.activePort.setSignals !== 'function') {
      throw new TransportError('当前浏览器或串口设备不支持物理信号控制', 'NotSupported');
    }

    try {
      await this.activePort.setSignals({
        dataTerminalReady: signals.dtr,
        requestToSend: signals.rts,
        break: signals.brk,
      });
    } catch (err) {
      const transportError = this.mapToTransportError(err);
      this.notifyError(transportError);
      throw transportError;
    }
  }

  onBatch(cb: (batch: ParsedBatch) => void): Unsubscribe {
    this.batchListeners.add(cb);
    return () => {
      this.batchListeners.delete(cb);
    };
  }

  /**
   * 将 Web Serial 的通用解析批次适配为带真实会话身份的波形批次。
   *
   * 不能交给 session.ts 使用固定的伪 session_id：重连或协议切换后，
   * 旧批次必须能和当前 session/epoch 区分开。缺失的通道样本保留为
   * NaN，让图表显示断点，而不是用 0 制造不存在的测量值。
   */
  onWaveformBatch(cb: (batch: WaveformBatch) => void): Unsubscribe {
    return this.onBatch((parsed) => {
      const sessionId = parsed.session_id ?? this.sessionId;
      const epoch = parsed.channel_epoch ?? this.sessionEpoch;
      if (this.currentStatus !== 'connected' || !sessionId || !this.sessionId) return;
      // CONFIGURE flushes the old parser before acknowledging the new one.
      // Keep that batch observable to log consumers, but never let its old
      // samples roll ChannelStore back after the input epoch has advanced.
      const currentReceiveEpoch = this.receiveEpoch || this.sessionEpoch;
      if (sessionId !== this.sessionId || epoch !== currentReceiveEpoch) return;

      if (parsed.frames && parsed.frames.length > 0) {
        // Parser output order is frame identity. Several frames may share the
        // same host arrival timestamp; keep that measured time without inferring
        // a device sample interval. Keep channel positions even for invalid values.
        const channelNames = Array.from(new Set(parsed.frames.flatMap((frame) =>
          frame.values.map((_, index) => frame.channelNames?.[index] ?? `ch${index}`))));
        if (channelNames.length === 0) return;
        const channelIndex = new Map(channelNames.map((channel, index) => [channel, index]));
        const timestamps = parsed.frames.map((frame) => frame.timestampUs / 1_000_000);
        const series = channelNames.map(() => new Array<number>(timestamps.length).fill(Number.NaN));
        parsed.frames.forEach((frame, column) => {
          frame.values.forEach((value, index) => {
            const row = channelIndex.get(frame.channelNames?.[index] ?? `ch${index}`);
            if (row !== undefined && Number.isFinite(value)) series[row][column] = value;
          });
        });
        cb({
          session_id: sessionId,
          channel_epoch: epoch,
          channel_names: channelNames,
          points: [],
          timestamps,
          series,
          dropped_bytes: parsed.droppedBytes || 0,
        });
        return;
      }
      if (parsed.samples.length === 0) return;

      const channelNames = Array.from(new Set(parsed.samples.map((sample) => sample.channel)));
      const timestamps = Array.from(new Set(parsed.samples.map((sample) => sample.t))).sort((a, b) => a - b);
      if (channelNames.length === 0 || timestamps.length === 0) return;

      const timestampIndex = new Map<number, number>();
      timestamps.forEach((timestamp, index) => timestampIndex.set(timestamp, index));
      const channelIndex = new Map<string, number>();
      channelNames.forEach((channel, index) => channelIndex.set(channel, index));
      const series = channelNames.map(() => new Array<number>(timestamps.length).fill(Number.NaN));

      for (const sample of parsed.samples) {
        const row = channelIndex.get(sample.channel);
        const column = timestampIndex.get(sample.t);
        if (row === undefined || column === undefined || !Number.isFinite(sample.v)) continue;
        series[row][column] = sample.v;
      }

      cb({
        session_id: sessionId,
        channel_epoch: epoch,
        channel_names: channelNames,
        points: [],
        timestamps,
        series,
        dropped_bytes: parsed.droppedBytes || 0,
      });
    });
  }

  onRawData?(cb: (chunk: Uint8Array) => void): Unsubscribe {
    this.rawDataListeners.add(cb);
    return () => {
      this.rawDataListeners.delete(cb);
    };
  }

  onError(cb: (err: TransportError) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  onStatusChange(cb: (status: TransportStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    cb(this.currentStatus);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  onWriteResult(_cb: (result: WriteResultEvent) => void): Unsubscribe {
    // Web Serial write() resolves only after WritableStream accepts the bytes.
    // The caller receives that completion directly rather than through events.
    return () => {};
  }

  async dispose(): Promise<void> {
    if (
      typeof navigator !== 'undefined' &&
      'serial' in navigator &&
      typeof (navigator as any).serial?.removeEventListener === 'function'
    ) {
      (navigator as any).serial.removeEventListener('connect', this.handleConnect);
      (navigator as any).serial.removeEventListener('disconnect', this.handleDisconnect);
    }

    await this.disconnect();
    this.batchListeners.clear();
    this.rawDataListeners.clear();
    this.errorListeners.clear();
    this.statusListeners.clear();
    this.portMap.clear();
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

  /**
   * 将原生 DOMException 映射到标准化 TransportError 错误码体系
   */
  private mapToTransportError(err: unknown): TransportError {
    if (err instanceof TransportError) {
      return err;
    }

    const msg = (err as any)?.message || String(err);
    const name = (err as any)?.name || '';

    let code: TransportErrorCode = 'Unknown';

    if (name === 'InvalidStateError' || msg.includes('already open') || msg.includes('occupied')) {
      code = 'PortBusy';
    } else if (name === 'SecurityError' || msg.includes('Permission denied')) {
      code = 'PermissionDenied';
    } else if (name === 'NotFoundError' || msg.includes('not found')) {
      code = 'PortNotFound';
    } else if (name === 'NetworkError' || msg.includes('device lost') || msg.includes('disconnected')) {
      code = 'DeviceLost';
    } else if (name === 'BufferOverrunError' || msg.includes('overflow')) {
      code = 'BufferOverflow';
    } else if (name === 'FramingError' || msg.includes('framing')) {
      code = 'FramingError';
    } else if (name === 'ParityError' || msg.includes('parity')) {
      code = 'ParityError';
    }

    return new TransportError(msg, code, err);
  }
}
