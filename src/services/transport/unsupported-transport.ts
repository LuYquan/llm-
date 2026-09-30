import type {
  ISerialTransport,
  TransportKind,
  TransportCapabilities,
  SerialPortInfo,
  SerialOpenOptions,
  ParsedBatch,
  TransportStatus,
  Unsubscribe,
  WriteReceipt,
  WriteResultEvent,
} from './types';
import { TransportError } from './types';

/**
 * 降级/不支持环境下的串口传输驱动占位实现
 * 用于在非 Web Serial 浏览器或受限环境中提供明确友好的错误提示
 */
export class UnsupportedTransport implements ISerialTransport {
  readonly kind: TransportKind = 'webserial';
  readonly capabilities: TransportCapabilities = {
    canEnumerateAllPorts: false,
    requiresUserGestureToAddPort: true,
    globalEmergencyStop: false,
    fileSystemLogging: false,
  };

  private readonly reason: string;
  private statusListeners = new Set<(status: TransportStatus) => void>();
  private errorListeners = new Set<(err: TransportError) => void>();

  constructor(reason = '当前环境不支持串口通信功能，请使用桌面端或桌面版 Chrome/Edge 浏览器。') {
    this.reason = reason;
  }

  getReason(): string {
    return this.reason;
  }

  async listPorts(): Promise<SerialPortInfo[]> {
    return [];
  }

  async requestPort(_filters?: { usbVendorId?: number }[]): Promise<SerialPortInfo | null> {
    const err = new TransportError(this.reason, 'NotSupported');
    this.notifyError(err);
    throw err;
  }

  async connect(_portId: string, _options: SerialOpenOptions): Promise<void> {
    const err = new TransportError(this.reason, 'NotSupported');
    this.notifyError(err);
    throw err;
  }

  async disconnect(): Promise<void> {
    // 降级驱动无需执行实际关闭操作
  }

  async configureProtocol(_config: import('../../core/protocol/types').ProtocolConfig): Promise<void> {
    const err = new TransportError(this.reason, 'NotSupported');
    this.notifyError(err);
    throw err;
  }

  async write(_data: Uint8Array): Promise<WriteReceipt> {
    const err = new TransportError(this.reason, 'NotSupported');
    this.notifyError(err);
    throw err;
  }

  async emergencyStop(_frame: Uint8Array): Promise<void> {
    const err = new TransportError(this.reason, 'NotSupported');
    this.notifyError(err);
    throw err;
  }

  async resumeWrites(): Promise<void> {
    const err = new TransportError(this.reason, 'NotSupported');
    this.notifyError(err);
    throw err;
  }

  onBatch(_cb: (batch: ParsedBatch) => void): Unsubscribe {
    return () => {};
  }

  onRawData?(_cb: (chunk: Uint8Array) => void): Unsubscribe {
    return () => {};
  }

  onError(cb: (err: TransportError) => void): Unsubscribe {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  onStatusChange(cb: (status: TransportStatus) => void): Unsubscribe {
    this.statusListeners.add(cb);
    // 异步推送一次 error 状态供 UI 显示降级提示
    const timer = setTimeout(() => {
      if (this.statusListeners.has(cb)) {
        cb('error');
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      this.statusListeners.delete(cb);
    };
  }

  onWriteResult(_cb: (result: WriteResultEvent) => void): Unsubscribe {
    return () => {};
  }

  async dispose(): Promise<void> {
    this.statusListeners.clear();
    this.errorListeners.clear();
  }

  private notifyError(err: TransportError) {
    for (const listener of this.errorListeners) {
      try {
        listener(err);
      } catch (e) {
        console.error('Error in UnsupportedTransport onError listener:', e);
      }
    }
  }
}
