/**
 * 统一会话层：useSerialSession
 * 提供响应式状态绑定、连接生命周期管理、急停与数据分发能力
 * 彻底解耦上层 UI 对 @tauri-apps/api/core 的直接强依赖，使同一套 UI 在桌面与 WebSerial 环境下自适应运转
 */

import { ref, computed, shallowRef } from 'vue';
import type {
  ISerialTransport,
  SerialPortInfo,
  SerialOpenOptions,
  SerialSettings,
  TransportStatus,
  TransportCapabilities,
  ParsedBatch,
  TransportError,
  Unsubscribe,
  WriteReceipt,
  WriteResultEvent,
} from './types';
import { TransportFactory } from './factory';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { SafetyGuard } from '../ai';
import type { WaveformBatch, StepSnapshot, StepMetrics, ChecksumResult } from '../../types/ipc';
import type { RadarScores } from '../../components/MetricRadar.vue';
import type { PidParams } from '../ai';
import { encodeCommand, type CommandLineEnding } from './command-encoder';
import type { ProtocolConfig } from '../../core/protocol/types';
import { LEGACY_WORKSPACE_KEY, loadBrowserWorkspace, saveBrowserWorkspace } from '../workspace/browser-storage';
import { BrowserRecordingStore } from '../recording/browser-recording';
import { PipelineStatistics } from './pipeline-statistics';

export interface PipelineStatus {
  is_running: boolean;
  is_acquiring?: boolean;
  mode: string;
  sample_rate: number;
  total_samples: number;
  /** Raw bytes received before protocol/text parsing (desktop status only). */
  rx_bytes?: number;
  error_count?: number;
  protocol_dropped_bytes?: number;
}

export interface RecordingStatus {
  isRecording: boolean;
  sessionId: string | null;
  directory: string | null;
  rxBytes: number;
  rxChunks: number;
  error: string | null;
}

export interface RecordingSummary {
  directory: string;
  manifest: {
    formatVersion: number;
    sessionId: string;
    epoch: number;
    source: string;
    port: string | null;
    baudRate: number | null;
    protocolConfig: ProtocolConfig | null;
    timeSource: string;
    status: string;
    startedUnixMs: number;
    endedUnixMs: number | null;
    rxBytes: number;
    rxChunks: number;
    unindexedBytes: number;
    segments: { file: string; bytes: number }[];
    error: string | null;
  };
}

export interface RecordedRawChunk {
  rxSequence: number;
  receivedAtUs: number;
  bytes: number[];
}

export interface RecordingPage {
  sessionId: string;
  epoch: number;
  chunks: RecordedRawChunk[];
  nextAfterRxSequence: number | null;
  eof: boolean;
  sequenceGap: boolean;
}

// 模块级单例响应式状态
const transportInstance = shallowRef<ISerialTransport | null>(null);
const currentStatus = ref<TransportStatus>('idle');
const availablePorts = ref<SerialPortInfo[]>([]);
const activePortId = ref<string>('');
const lastParsedBatch = ref<ParsedBatch | null>(null);
const lastTransportError = ref<TransportError | null>(null);
const droppedBytes = ref<number>(0);
const totalDroppedBytes = ref<number>(0);
const protocolErrors = ref<number>(0);
const softwareStopLocked = ref(false);
const acquisitionEnabled = ref(false);
const currentBaudRate = ref(115200);
const currentProtocolConfig = ref<ProtocolConfig>({ type: 'firewater' });
const browserRecording = new BrowserRecordingStore();
const browserStatistics = new PipelineStatistics();
function hostNowMs(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

const capabilities = ref<TransportCapabilities>({
  canEnumerateAllPorts: false,
  requiresUserGestureToAddPort: true,
  globalEmergencyStop: false,
  fileSystemLogging: false,
});

let initPromise: Promise<ISerialTransport> | null = null;
let unlistenStatus: Unsubscribe | null = null;
let unlistenError: Unsubscribe | null = null;
let unlistenBatch: Unsubscribe | null = null;
let unlistenRawData: Unsubscribe | null = null;
let webPeriodicTimer: any = null;

/**
 * 动态安全调用 Tauri 命令 (在浏览器/非 Tauri 宿主下安全降级)
 */
async function safeInvoke<T>(cmd: string, args?: Record<string, any>): Promise<T | null> {
  if (typeof window !== 'undefined' && isTauri()) {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      console.warn(`[useSerialSession] safeInvoke '${cmd}' 警告:`, e);
      throw e;
    }
  }
  return null;
}

/**
 * 获取或异步初始化底层串口传输实例
 */
export async function getOrInitTransport(): Promise<ISerialTransport> {
  if (transportInstance.value) {
    return transportInstance.value;
  }
  if (!initPromise) {
    initPromise = (async () => {
      const tp = await TransportFactory.create();
      transportInstance.value = tp;
      capabilities.value = tp.capabilities;

      // 注册状态与错误监听
      unlistenStatus = tp.onStatusChange((s) => {
        currentStatus.value = s;
      });

      unlistenError = tp.onError((err) => {
        lastTransportError.value = err;
      });

      unlistenBatch = tp.onBatch((batch) => {
        if (tp.kind === 'webserial') browserStatistics.addBatch(batch, hostNowMs());
        lastParsedBatch.value = batch;
        if (batch.droppedBytes !== undefined) {
          droppedBytes.value = batch.droppedBytes;
          totalDroppedBytes.value += batch.droppedBytes;
        }
        if (batch.protocolErrors !== undefined && batch.protocolErrors > 0) {
          protocolErrors.value += batch.protocolErrors;
        }
      });

      if (tp.onRawData) {
        unlistenRawData = tp.onRawData((chunk) => {
          browserStatistics.addBytes(chunk.byteLength);
          browserRecording.append(chunk, browserRecording.receiveTimeUs());
        });
      }

      // 若平台支持全量枚举端口（如 Tauri），自动拉取初始列表
      if (tp.capabilities.canEnumerateAllPorts) {
        try {
          const list = await tp.listPorts();
          availablePorts.value = list;
          if (list.length > 0 && !activePortId.value) {
            activePortId.value = list[0].id;
          }
        } catch (e) {
          console.warn('[useSerialSession] 初始化端口列表失败:', e);
        }
      }

      return tp;
    })();
  }
  return initPromise;
}

/**
 * 串口会话管理 Composable
 */
export function useSerialSession() {
  const isConnected = computed(() => currentStatus.value === 'connected');
  const isConnecting = computed(() => currentStatus.value === 'connecting');
  const isDisconnecting = computed(() => currentStatus.value === 'disconnecting');
  const isDeviceLost = computed(() => currentStatus.value === 'device-lost');
  const hasError = computed(() => currentStatus.value === 'error');

  /**
   * 刷新可用端口列表
   */
  async function refreshPorts(): Promise<SerialPortInfo[]> {
    const tp = await getOrInitTransport();
    const list = await tp.listPorts();
    availablePorts.value = list;
    if (list.length > 0 && !activePortId.value) {
      activePortId.value = list[0].id;
    }
    return list;
  }

  /**
   * 请求用户选择并授权新端口 (仅 Web Serial 网页端需要)
   */
  async function requestPort(filters?: { usbVendorId?: number }[]): Promise<SerialPortInfo | null> {
    const tp = await getOrInitTransport();
    if (!tp.requestPort) {
      return null;
    }
    const port = await tp.requestPort(filters);
    if (port) {
      if (!availablePorts.value.some((p) => p.id === port.id)) {
        availablePorts.value.push(port);
      }
      activePortId.value = port.id;
    }
    return port;
  }

  /**
   * 连接指定端口
   */
  async function connect(portId: string, options: SerialOpenOptions): Promise<void> {
    const tp = await getOrInitTransport();
    activePortId.value = portId;
    currentBaudRate.value = options.baudRate;
    browserRecording.setReceiveClock((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1000);
    protocolErrors.value = 0;
    browserStatistics.reset();
    await tp.connect(portId, options);
    acquisitionEnabled.value = true;
  }

  /**
   * 断开当前连接
   */
  async function disconnect(): Promise<void> {
    const tp = await getOrInitTransport();
    if (tp.kind === 'webserial' && browserRecording.status().isRecording) {
      await browserRecording.stop();
    }
    await tp.disconnect();
    protocolErrors.value = 0;
    acquisitionEnabled.value = false;
  }

  async function setAcquisitionEnabled(enabled: boolean): Promise<boolean> {
    const tp = await getOrInitTransport();
    if (currentStatus.value !== 'connected') throw new Error('当前没有可控制的串口会话');
    if (!tp.setAcquisitionEnabled) throw new Error('当前传输驱动不支持独立采集控制');
    await tp.setAcquisitionEnabled(enabled);
    acquisitionEnabled.value = enabled;
    return enabled;
  }

  async function configureProtocol(config: ProtocolConfig): Promise<void> {
    const tp = await getOrInitTransport();
    await tp.configureProtocol(config);
    browserStatistics.resetProtocol();
    currentProtocolConfig.value = JSON.parse(JSON.stringify(config)) as ProtocolConfig;
    protocolErrors.value = 0;
  }

  /**
   * 发送指令或数据流（支持 Uint8Array 原始字节或普通字符串）
   */
  async function writeBytesThroughGate(bytes: Uint8Array): Promise<WriteReceipt> {
    if (softwareStopLocked.value) {
      throw new Error('软件停止屏障已锁定发送；请确认设备状态后显式恢复发送');
    }
    const tp = await getOrInitTransport();
    return tp.write(bytes);
  }

  async function write(data: Uint8Array | string): Promise<WriteReceipt> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return writeBytesThroughGate(bytes);
  }

  /**
   * 发送最高优先级急停指令 (ADR 0004)
   * 绕过普通发送队列直接清空待发缓冲
   */
  async function emergencyStop(frame?: Uint8Array | string): Promise<void> {
    const tp = await getOrInitTransport();
    let bytes: Uint8Array;
    if (!frame) {
      bytes = new Uint8Array();
    } else if (typeof frame === 'string') {
      // String-valued stop commands are explicitly text. Callers that need binary
      // stop bytes must pass a Uint8Array produced by the shared HEX encoder.
      bytes = encodeCommand(frame, { encoding: 'text', escapeText: true });
    } else {
      bytes = frame;
    }
    if (tp.kind !== 'tauri') await stopPeriodicSend();
    await tp.emergencyStop(bytes);
    softwareStopLocked.value = true;
  }

  async function refreshWriteLockStatus(): Promise<boolean> {
    if (typeof window !== 'undefined' && isTauri()) {
      const locked = await safeInvoke<boolean>('get_write_lock_status');
      if (locked !== null) softwareStopLocked.value = locked;
    }
    return softwareStopLocked.value;
  }

  async function resumeWrites(): Promise<void> {
    const tp = await getOrInitTransport();
    await tp.resumeWrites();
    softwareStopLocked.value = false;
  }

  /**
   * 订阅统一抽象批量数据
   */
  function onBatch(cb: (batch: ParsedBatch) => void): Unsubscribe {
    let unsub: Unsubscribe = () => {};
    let cancelled = false;
    getOrInitTransport().then((tp) => {
      if (cancelled) return;
      unsub = tp.onBatch(cb);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }

  /**
   * 高性能波形批次专用订阅 (直通 WaveformViewer)
   */
  function onWaveformBatch(cb: (batch: WaveformBatch) => void): Unsubscribe {
    let unsub: Unsubscribe = () => {};
    let cancelled = false;
    getOrInitTransport().then((tp) => {
      if (cancelled) return;
      if (tp.onWaveformBatch) {
        unsub = tp.onWaveformBatch(cb);
      } else {
        // 在 WebSerialTransport 等通用实现中，自适应聚合为 WaveformBatch
        unsub = tp.onBatch((parsed) => {
          if (parsed.samples.length === 0) return;
          const channelSet = new Set<string>();
          const timestamps: number[] = [];
          for (const s of parsed.samples) {
            channelSet.add(s.channel);
            if (timestamps.length === 0 || timestamps[timestamps.length - 1] !== s.t) {
              timestamps.push(s.t);
            }
          }
          const channelNames = Array.from(channelSet);
          const series: number[][] = channelNames.map(() => new Array(timestamps.length).fill(0));

          const timeIndexMap = new Map<number, number>();
          timestamps.forEach((t, i) => timeIndexMap.set(t, i));

          for (const s of parsed.samples) {
            const tIdx = timeIndexMap.get(s.t);
            const cIdx = channelNames.indexOf(s.channel);
            if (tIdx !== undefined && cIdx >= 0) {
              series[cIdx][tIdx] = s.v;
            }
          }

          cb({
            session_id: 'serial_session',
            channel_epoch: 1,
            channel_names: channelNames,
            points: [],
            timestamps,
            series,
            dropped_bytes: parsed.droppedBytes || 0,
          });
        });
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }

  /**
   * 格式化日志批次专用订阅 (直通 GeneralTerminal)
   */
  function onLogsBatch(cb: (logs: any[]) => void): Unsubscribe {
    let unsub: Unsubscribe = () => {};
    let cancelled = false;
    getOrInitTransport().then((tp) => {
      if (cancelled) return;
      if ((tp as any).onLogsBatch) {
        unsub = (tp as any).onLogsBatch(cb);
      } else {
        unsub = tp.onBatch((parsed) => {
          if (parsed.logLines.length > 0) {
            cb(
              parsed.logLines.map((l) => ({
                timestamp_us: Math.round(l.t * 1_000_000),
                direction: 'Rx',
                level: 'Info',
                text: l.text,
              }))
            );
          }
        });
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }

  /**
   * 订阅状态变更
   */
  function onStatusChange(cb: (status: TransportStatus) => void): Unsubscribe {
    let unsub: Unsubscribe = () => {};
    let cancelled = false;
    getOrInitTransport().then((tp) => {
      if (cancelled) return;
      unsub = tp.onStatusChange(cb);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }

  function onWriteResult(cb: (result: WriteResultEvent) => void): Unsubscribe {
    let unsub: Unsubscribe = () => {};
    let cancelled = false;
    getOrInitTransport().then((tp) => {
      if (cancelled) return;
      unsub = tp.onWriteResult(cb);
    }).catch((error) => console.warn('[useSerialSession] 注册写入结果监听失败:', error));
    return () => {
      cancelled = true;
      unsub();
    };
  }

  /**
   * 订阅传输层错误
   */
  function onError(cb: (err: TransportError) => void): Unsubscribe {
    let unsub: Unsubscribe = () => {};
    let cancelled = false;
    getOrInitTransport().then((tp) => {
      if (cancelled) return;
      unsub = tp.onError(cb);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }

  /**
   * 订阅阶跃快照事件
   */
  function onStepSnapshot(cb: (snapshot: StepSnapshot) => void): Unsubscribe {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    if (typeof window !== 'undefined' && isTauri()) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        if (cancelled) return;
        listen<StepSnapshot>('step://snapshot', (event) => {
          cb(event.payload);
        })
          .then((u) => {
            if (cancelled) {
              u();
            } else {
              unlisten = u;
            }
          })
          .catch(() => {});
      });
    }

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }

  /**
   * 获取历史波形窗口 (支持降采样)
   */
  async function getWaveformWindow(
    startUs: number,
    endUs: number,
    maxPoints: number = 1000
  ): Promise<WaveformBatch | null> {
    return await safeInvoke<WaveformBatch>('get_waveform_window', {
      startUs,
      endUs,
      maxPoints,
    });
  }

  /**
   * 重置数据管线与统计计数器
   */
  async function reset(): Promise<void> {
    droppedBytes.value = 0;
    totalDroppedBytes.value = 0;
    protocolErrors.value = 0;
    await safeInvoke('reset_pipeline');
  }

  /**
   * 打开系统日志目录
   */
  async function openLogDir(): Promise<string> {
    const res = await safeInvoke<string>('open_log_dir');
    return res || '日志目录已就绪';
  }

  /**
   * 循环定时发送
   */
  async function startPeriodicSend(
    data: string,
    intervalMs: number,
    isHex: boolean
  ): Promise<void> {
    const tp = await getOrInitTransport();
    if (softwareStopLocked.value) {
      throw new Error('软件停止屏障已锁定发送；请先显式恢复普通发送');
    }
    const bytes = encodeCommand(data, {
      encoding: isHex ? 'hex' : 'text',
      escapeText: true,
      appendNewline: !isHex,
      lineEnding: 'crlf',
    });
    if (tp.kind === 'tauri') {
      await safeInvoke('start_periodic_send', { bytes: Array.from(bytes), intervalMs });
    } else {
      // Clear the previous browser timer before installing a new one.  This is
      // deliberately awaited so a future adapter can report a real stop
      // failure instead of leaving two periodic writers alive.
      await stopPeriodicSend();
      webPeriodicTimer = setInterval(() => {
        // Route every periodic write through the same software-stop gate as
        // terminal and widget commands. A stop that races an already-started
        // write still reports that write as in-flight; no later tick is sent.
        writeBytesThroughGate(bytes).catch((err) => {
          if (webPeriodicTimer) {
            clearInterval(webPeriodicTimer);
            webPeriodicTimer = null;
          }
          console.warn('[PeriodicSend] 写入失败，周期发送已停止:', err);
        });
      }, Math.max(10, intervalMs));
    }
  }

  async function stopPeriodicSend(): Promise<void> {
    if (webPeriodicTimer) {
      clearInterval(webPeriodicTimer);
      webPeriodicTimer = null;
    }
    await safeInvoke('stop_periodic_send');
  }

  /**
   * 通道语义映射配置
   */
  async function setChannelMapping(mapping: { target: string; actual: string; output: string }): Promise<void> {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('llm_serial_channel_mapping', JSON.stringify(mapping));
      } catch {}
    }
    await safeInvoke('set_channel_mapping', { mapping });
  }

  async function getChannelMapping(): Promise<{ target: string; actual: string; output: string } | null> {
    const res = await safeInvoke<{ target: string; actual: string; output: string }>('get_channel_mapping');
    if (res) return res;
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('llm_serial_channel_mapping');
        if (cached) return JSON.parse(cached);
      } catch {}
    }
    return null;
  }

  /**
   * 阶跃指标五维雷达评分
   */
  async function scoreStepMetrics(metrics: StepMetrics): Promise<RadarScores> {
    const res = await safeInvoke<RadarScores>('score_step_metrics', { metrics });
    if (res) return res;

    // 前端内置备用评分计算
    const mp = metrics.overshoot_percent ?? metrics.overshoot_pct ?? 0;
    const ess = metrics.steady_state_error ?? 0;
    const tr = metrics.rise_time_s ?? 0.1;

    const overshoot_score = Math.max(0, Math.min(100, Math.round(100 - mp * 2.5)));
    const speed_score = Math.max(0, Math.min(100, Math.round(100 - tr * 50)));
    const steady_score = Math.max(0, Math.min(100, Math.round(100 - Math.abs(ess) * 200)));
    const damping_score = Math.max(0, Math.min(100, Math.round(90 - mp * 1.5)));
    const robust_score = Math.round((overshoot_score + steady_score + damping_score) / 3);

    return { overshoot_score, speed_score, steady_score, damping_score, robust_score };
  }

  /**
   * 硬件校验计算 (桌面端经 Rust IPC，网页端返回 null 触发前端纯 TS 回退)
   */
  async function calculateChecksums(data: string, isHex: boolean): Promise<ChecksumResult | null> {
    return await safeInvoke<ChecksumResult>('calculate_checksums', { data, isHex });
  }

  /**
   * 经 SafetyGuard 核准并应用 PID 参数
   */
  async function applyPidParams(currentPid: PidParams, newPid: PidParams): Promise<string> {
    const res = await safeInvoke<string>('validate_and_apply_pid', { currentPid, newPid });
    if (res) return res;

    // 前端内置纯 TS 双模安全防线拦截保护 (Web 模式与降级防护)
    const check = SafetyGuard.validateAndFormatCommand(currentPid, newPid);
    if (!check.ok) {
      throw new Error(check.error);
    }

    await write(check.command);
    return check.command;
  }

  /**
   * 加载与保存工作区配置 (跨平台兼容)
   */
  async function loadAppConfig(): Promise<any> {
    const res = await safeInvoke('load_app_config');
    if (res) return res;
    if (typeof window !== 'undefined') {
      try {
        const cached = await loadBrowserWorkspace();
        if (cached) {
          const parsed = JSON.parse(cached);
          const sanitized = clearWebPersistedApiKeyState(stripPersistedSecrets(parsed));
          if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
            try {
              await saveBrowserWorkspace(JSON.stringify(sanitized));
            } catch (migrationError) {
              // Loading must remain useful even when an embedded browser denies
              // IndexedDB. Keep only the sanitized legacy copy as a last resort;
              // an explicit user save still reports the storage error.
              console.warn('[useSerialSession] 清理旧浏览器配置密钥失败:', migrationError);
              try {
                localStorage.setItem(LEGACY_WORKSPACE_KEY, JSON.stringify(sanitized));
              } catch {
                // The sanitized in-memory value is still safe to use this session.
              }
            }
          }
          return sanitized;
        }
      } catch (error) {
        console.warn('[useSerialSession] 读取浏览器配置失败:', error);
      }
    }
    return null;
  }

  async function saveAppConfig(config: any): Promise<void> {
    const sanitized = clearWebPersistedApiKeyState(stripPersistedSecrets(config));
    if (isTauri()) {
      await safeInvoke('save_app_config', { config });
      return;
    }
    if (typeof window !== 'undefined') {
      try {
        await saveBrowserWorkspace(JSON.stringify(sanitized));
      } catch (error) {
        throw new Error(`浏览器配置保存失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * 获取底层数据采集管线状态 (跨平台兼容)
   */
  async function getPipelineStatus(): Promise<PipelineStatus> {
    const res = await safeInvoke<PipelineStatus>('get_pipeline_status');
    if (res) {
      acquisitionEnabled.value = res.is_acquiring ?? res.is_running;
      return res;
    }
    return {
      is_running: currentStatus.value === 'connected',
      is_acquiring: acquisitionEnabled.value && currentStatus.value === 'connected',
      mode: activePortId.value === 'mock' ? 'mock' : 'serial',
      ...browserStatistics.snapshot(hostNowMs(), acquisitionEnabled.value && currentStatus.value === 'connected'),
      protocol_dropped_bytes: 0,
    };
  }

  async function getRecordingStatus(): Promise<RecordingStatus | null> {
    const native = await safeInvoke<RecordingStatus>('get_recording_status');
    if (native) return native;
    if (transportInstance.value?.kind === 'webserial') return browserRecording.status();
    return null;
  }

  async function startRecording(): Promise<RecordingStatus> {
    const result = await safeInvoke<RecordingStatus>('start_recording');
    if (result) return result;
    const tp = await getOrInitTransport();
    if (tp.kind !== 'webserial') throw new Error('当前传输驱动不支持本地原始记录');
    return browserRecording.start({
      source: activePortId.value === 'mock' ? 'mock' : 'webserial',
      port: activePortId.value || null,
      baudRate: currentBaudRate.value,
      protocolConfig: currentProtocolConfig.value,
    });
  }

  async function stopRecording(): Promise<RecordingStatus> {
    const result = await safeInvoke<RecordingStatus>('stop_recording');
    if (result) return result;
    if (transportInstance.value?.kind !== 'webserial') throw new Error('当前传输驱动不支持本地原始记录');
    return browserRecording.stop();
  }

  async function listRecordings(): Promise<RecordingSummary[]> {
    const native = await safeInvoke<RecordingSummary[]>('list_recordings');
    if (native) return native;
    if (transportInstance.value?.kind === 'webserial') return browserRecording.list();
    return [];
  }

  async function readRecordingPage(
    sessionId: string,
    directory: string,
    afterRxSequence?: number,
    maxBytes = 64 * 1024
  ): Promise<RecordingPage> {
    const result = await safeInvoke<RecordingPage>('read_recording_page', {
      sessionId,
      directory,
      afterRxSequence: afterRxSequence ?? null,
      maxBytes,
    });
    if (result) return result;
    if (transportInstance.value?.kind !== 'webserial') throw new Error('当前传输驱动不支持本地记录回放');
    return browserRecording.readPage(sessionId, directory, afterRxSequence, maxBytes);
  }

  /**
   * 启动数据采集管线 (在桌面端通过 start_pipeline，网页端自适应通过 connect)
   */
  async function startPipeline(params: {
    mode: string;
    port?: string | null;
    baudRate?: number;
    serialSettings?: SerialSettings;
  }): Promise<PipelineStatus> {
    if (typeof window !== 'undefined' && isTauri()) {
      const transport = await getOrInitTransport();
      await transport.connect(params.mode === 'serial' ? (params.port || activePortId.value) : 'mock', {
        baudRate: params.baudRate || 115200,
        dataBits: params.serialSettings?.dataBits ?? 8,
        parity: params.serialSettings?.parity ?? 'none',
        stopBits: params.serialSettings?.stopBits ?? 1,
        flowControl: params.serialSettings?.flowControl ?? 'none',
      });
      currentBaudRate.value = params.baudRate || 115200;
      acquisitionEnabled.value = true;
      const res = await safeInvoke<PipelineStatus>('get_pipeline_status');
      if (res) {
        currentStatus.value = res.is_running ? 'connected' : 'error';
        acquisitionEnabled.value = res.is_acquiring ?? res.is_running;
        return res;
      }
      currentStatus.value = 'connected';
      acquisitionEnabled.value = true;
      return { is_running: true, is_acquiring: true, mode: params.mode, sample_rate: 0, total_samples: 0, rx_bytes: 0, protocol_dropped_bytes: 0 };
    }

    const targetPort = params.mode === 'serial' ? (params.port || activePortId.value) : 'mock';
    await connect(targetPort, {
      baudRate: params.baudRate || 115200,
      dataBits: params.serialSettings?.dataBits ?? 8,
      parity: params.serialSettings?.parity ?? 'none',
      stopBits: params.serialSettings?.stopBits ?? 1,
      flowControl: params.serialSettings?.flowControl ?? 'none',
    });
    return {
      is_running: true,
      is_acquiring: true,
      mode: params.mode,
      sample_rate: 0,
      total_samples: 0,
      rx_bytes: 0,
      protocol_dropped_bytes: 0,
    };
  }

  /**
   * 停止数据采集管线 (跨平台兼容)
   */
  async function stopPipeline(): Promise<PipelineStatus> {
    if (typeof window !== 'undefined' && isTauri()) {
      const transport = await getOrInitTransport();
      await transport.disconnect();
      acquisitionEnabled.value = false;
      const res = await safeInvoke<PipelineStatus>('get_pipeline_status');
      if (res) {
        currentStatus.value = 'idle';
        acquisitionEnabled.value = res.is_acquiring ?? false;
        return res;
      }
    }

    await disconnect();
    currentStatus.value = 'idle';
    return {
      is_running: false,
      is_acquiring: false,
      mode: 'serial',
      sample_rate: 0,
      total_samples: 0,
      rx_bytes: 0,
      protocol_dropped_bytes: 0,
    };
  }

  /**
   * 发送终端数据 (支持 HEX/ASCII 与自动追加换行)
   */
  async function sendSerialData(
    data: string,
    isHex?: boolean,
    appendNewline?: boolean,
    escapeText = true,
    lineEnding: CommandLineEnding = 'crlf'
  ): Promise<WriteReceipt & { byteLength: number }> {
    if (softwareStopLocked.value) throw new Error('软件停止屏障已锁定发送；请确认设备状态后显式恢复发送');
    const bytes = encodeCommand(data, {
      encoding: isHex ? 'hex' : 'text',
      escapeText,
      appendNewline: !!appendNewline && !isHex,
      lineEnding,
    });
    const receipt = await writeBytesThroughGate(bytes);
    // Tauri returns queued; later serial://write-result reports the OS writer result.
    // Web Serial returns after WritableStream completes. Neither result is a device ACK.
    return { ...receipt, byteLength: receipt.byte_count };
  }

  return {
    // 状态
    transport: transportInstance,
    status: currentStatus,
    isConnected,
    isConnecting,
    isDisconnecting,
    isDeviceLost,
    hasError,
    ports: availablePorts,
    activePortId,
    capabilities,
    lastBatch: lastParsedBatch,
    lastError: lastTransportError,
    droppedBytes,
    totalDroppedBytes,
    protocolErrors,
    acquisitionEnabled,

    // 方法
    init: getOrInitTransport,
    refreshPorts,
    requestPort,
    connect,
    disconnect,
    configureProtocol,
    setAcquisitionEnabled,
    startPipeline,
    stopPipeline,
    getPipelineStatus,
    getRecordingStatus,
    startRecording,
    stopRecording,
    listRecordings,
    readRecordingPage,
    isNativeHost: typeof window !== 'undefined' && isTauri(),
    supportsRecording: computed(() => (typeof window !== 'undefined' && isTauri()) || transportInstance.value?.kind === 'webserial'),
    sendSerialData,
    write,
    emergencyStop,
    softwareStopLocked,
    refreshWriteLockStatus,
    resumeWrites,
    reset,
    onBatch,
    onWaveformBatch,
    onLogsBatch,
    onStatusChange,
    onError,
    onWriteResult,
    onStepSnapshot,
    getWaveformWindow,
    openLogDir,
    startPeriodicSend,
    stopPeriodicSend,
    setChannelMapping,
    getChannelMapping,
    scoreStepMetrics,
    calculateChecksums,
    applyPidParams,
    loadAppConfig,
    saveAppConfig,
  };
}

function isPersistedSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  // Keep status/metadata fields such as api_key_configured and token_count,
  // but remove values that can be replayed as credentials or bearer secrets.
  return normalized === 'apikey'
    || normalized.endsWith('apikey')
    || normalized === 'authorization'
    || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken')
    || normalized.includes('idtoken')
    || normalized.includes('clientsecret')
    || normalized.includes('password')
    || normalized === 'secret'
    || normalized.endsWith('secret')
    || normalized === 'token'
    || normalized.endsWith('token');
}

/** Return a JSON-safe copy with credentials removed at every nesting level. */
export function stripPersistedSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripPersistedSecrets(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isPersistedSecretKey(key)) continue;
    sanitized[key] = stripPersistedSecrets(item);
  }
  return sanitized as T;
}

/**
 * Browser storage may keep provider/model preferences, but it must not retain
 * a flag that would make a later page load believe an absent session key is
 * still available. Desktop DPAPI state is handled by the Rust command path.
 */
function clearWebPersistedApiKeyState<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  for (const key of ['ai_config', 'aiConfig']) {
    const config = root[key];
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      root[key] = { ...(config as Record<string, unknown>), api_key_configured: false };
    }
  }
  return value;
}

/**
 * 清理全局会话资源（用于测试或重置）
 */
export async function resetSession(): Promise<void> {
  if (unlistenStatus) unlistenStatus();
  if (unlistenError) unlistenError();
  if (unlistenBatch) unlistenBatch();
  if (unlistenRawData) unlistenRawData();
  unlistenStatus = null;
  unlistenError = null;
  unlistenBatch = null;
  unlistenRawData = null;

  if (webPeriodicTimer) {
    clearInterval(webPeriodicTimer);
    webPeriodicTimer = null;
  }

  if (transportInstance.value) {
    if (browserRecording.status().isRecording) await browserRecording.stop().catch(() => {});
    await transportInstance.value.dispose();
    transportInstance.value = null;
  }
  initPromise = null;
  currentStatus.value = 'idle';
  availablePorts.value = [];
  activePortId.value = '';
  lastParsedBatch.value = null;
  lastTransportError.value = null;
  droppedBytes.value = 0;
  totalDroppedBytes.value = 0;
  protocolErrors.value = 0;
  acquisitionEnabled.value = false;
  currentBaudRate.value = 115200;
  currentProtocolConfig.value = { type: 'firewater' };
}
