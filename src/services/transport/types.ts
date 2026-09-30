import type { ChannelFrame, ProtocolConfig } from '../../core/protocol/types';
import type { WaveformBatch } from '../../types/ipc';

/**
 * 通用串口传输抽象层接口契约 (PRD 4.1 / Phase 1: TransportAdapter)
 * 严格对齐 docs/dev-plan-desktop-and-web.md 规范定义
 */

export type TransportKind = 'tauri' | 'webserial';
export type Unsubscribe = () => void;

export interface SerialPortInfo {
  id: string;              // Tauri: COM 口名称 (如 COM3); Web: 内部生成的句柄 ID
  label: string;
  usbVendorId?: number;
  usbProductId?: number;
  port_name?: string;
  port_type?: string;
  description?: string;
  manufacturer?: string;
}

export type SerialParity = 'none' | 'even' | 'odd';
export type SerialFlowControl = 'none' | 'hardware';

export type WriteStatus = 'queued' | 'written' | 'acknowledged' | 'failed' | 'canceled' | 'superseded';

export interface WriteReceipt {
  request_id: string;
  session_id?: string;
  epoch?: number;
  byte_count: number;
  status: 'queued' | 'written';
}

export interface WriteResultEvent {
  request_id: string;
  session_id: string;
  epoch: number;
  source: string;
  status: Exclude<WriteStatus, 'queued'>;
  requested_bytes: number;
  written_bytes: number;
  reason?: string | null;
}

export interface SerialSettings {
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: SerialParity;
  flowControl: SerialFlowControl;
}

export interface SerialOpenOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: SerialParity;
  flowControl?: SerialFlowControl;
  bufferSize?: number;     // Web 端必须显式调大，默认值仅 255 字节
}

export type TransportStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'reconnecting'
  | 'device-lost'
  | 'error';

export interface TransportCapabilities {
  canEnumerateAllPorts: boolean;
  requiresUserGestureToAddPort: boolean;
  globalEmergencyStop: boolean;
  fileSystemLogging: boolean;
}

/** 解析后的批量数据（主数据通道） */
export interface ParsedBatch {
  samples: { channel: string; t: number; v: number }[];
  /** Ordered protocol frames. Equal host arrival timestamps do not identify the same frame. */
  frames?: ChannelFrame[];
  logLines: { t: number; text: string }[];
  droppedBytes?: number;   // 缓冲溢出统计
  protocolErrors?: number; // 本批次新增的协议/文本解析错误，不含历史累计值
}

export type TransportErrorCode =
  | 'PortBusy'             // 端口被占用
  | 'PermissionDenied'     // 权限被拒绝
  | 'DeviceLost'           // 设备丢失 / 异常拔出
  | 'FramingError'         // 帧错误
  | 'ParityError'          // 奇偶校验错误
  | 'BufferOverflow'       // 缓冲溢出
  | 'PortNotFound'         // 未找到指定端口
  | 'Timeout'              // 操作超时
  | 'NotSupported'         // 运行环境不支持该特性
  | 'AlreadyConnected'     // 端口已连接
  | 'NotConnected'         // 尚未建立连接
  | 'Unknown';             // 未知/未分类错误

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly originalError?: unknown;

  constructor(message: string, code: TransportErrorCode = 'Unknown', originalError?: unknown) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.originalError = originalError;
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

export interface ISerialTransport {
  readonly kind: TransportKind;
  readonly capabilities: TransportCapabilities;
  /** 当前连接是否能控制 DTR / RTS / Break 等物理串口信号。 */
  readonly supportsSignals?: boolean;

  listPorts(): Promise<SerialPortInfo[]>;
  /** 仅 Web 端需要：必须在用户点击事件中调用 */
  requestPort?(filters?: { usbVendorId?: number }[]): Promise<SerialPortInfo | null>;

  connect(portId: string, options: SerialOpenOptions): Promise<void>;
  disconnect(): Promise<void>;
  configureProtocol(config: ProtocolConfig): Promise<void>;
  /** Pause/resume byte acquisition without closing the current connection. */
  setAcquisitionEnabled?(enabled: boolean): Promise<void>;

  write(data: Uint8Array): Promise<WriteReceipt>;
  /** 急停专用：绕过普通发送队列，并清空待发数据 */
  emergencyStop(frame: Uint8Array): Promise<void>;
  /** 用户明确恢复普通发送；重连不会自动调用。 */
  resumeWrites(): Promise<void>;
  setSignals?(signals: { dtr?: boolean; rts?: boolean; brk?: boolean }): Promise<void>;

  onBatch(cb: (batch: ParsedBatch) => void): Unsubscribe;
  /** 带会话/协议代次的高性能波形批次；不支持时由 Session 层从 ParsedBatch 适配。 */
  onWaveformBatch?(cb: (batch: WaveformBatch) => void): Unsubscribe;
  /** 实际读取到的原始字节（当前仅 Web Serial 提供；Tauri 原始块事件尚未接入）。 */
  onRawData?(cb: (chunk: Uint8Array) => void): Unsubscribe;
  onError(cb: (err: TransportError) => void): Unsubscribe;
  onStatusChange(cb: (status: TransportStatus) => void): Unsubscribe;
  /** 结果事件只说明本地驱动写入状态，不代表设备已执行。 */
  onWriteResult(cb: (result: WriteResultEvent) => void): Unsubscribe;

  dispose(): Promise<void>;
}
