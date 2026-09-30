/**
 * 协议引擎核心类型定义 (ProtocolEngine Types)
 * 兼容 VOFA+ 官方 RawData / FireWater / JustFloat 及自定义帧协议
 */

export type ProtocolType = 'rawdata' | 'firewater' | 'justfloat' | 'custom';

/** Persisted protocol settings shared by the native pipeline and Web Worker. */
export type ProtocolConfig =
  | { type: 'firewater' }
  | { type: 'justfloat'; channels: number | null }
  | { type: 'rawdata'; mode: 'display' | 'decode'; format: RawDataFormat; channels: number }
  | {
      type: 'custom';
      header: number[];
      tail: number[];
      channels: number;
      dataType: CustomFrameDataType;
      checksum: ChecksumType;
      checksumByteOrder: ByteOrder;
    };

export type ByteOrder = 'little' | 'big';

export interface ChannelFrame {
  timestampUs: number;
  values: number[];
  channelNames?: string[];
}

export interface ProtocolLog {
  timestampUs: number;
  text: string;
  level: 'Info' | 'Warn' | 'Error' | 'Data';
}

export interface ProtocolOutput {
  frames: ChannelFrame[];
  logs: ProtocolLog[];
  droppedBytes: number;
  errorCount: number;
}

export interface IProtocolParser {
  feed(chunk: Uint8Array, timestampUs?: number): ProtocolOutput;
  flush(timestampUs?: number): ProtocolOutput;
  reset(): void;
}

export type RawDataFormat =
  | 'u8'
  | 'i8'
  | 'u16le'
  | 'u16be'
  | 'i16le'
  | 'i16be'
  | 'u32le'
  | 'u32be'
  | 'i32le'
  | 'i32be'
  | 'f32le'
  | 'f32be'
  | 'f64le'
  | 'f64be';

export interface RawDataOptions {
  format?: RawDataFormat;
  channels?: number;
}

export interface FireWaterOptions {
  delimiter?: string;
  autoChannelNames?: boolean;
}

export interface JustFloatOptions {
  channels?: number;
}

export type ChecksumType = 'none' | 'sum8' | 'xor8' | 'crc16_modbus' | 'crc16_ccitt';

export type CustomFrameDataType =
  | 'u8'
  | 'i8'
  | 'u16le'
  | 'u16be'
  | 'i16le'
  | 'i16be'
  | 'u32le'
  | 'u32be'
  | 'i32le'
  | 'i32be'
  | 'f32le'
  | 'f32be'
  | 'f64le'
  | 'f64be';

export interface CustomFrameOptions {
  header: number[];
  tail?: number[];
  channels: number;
  dataType?: CustomFrameDataType;
  checksum?: ChecksumType;
  checksumByteOrder?: ByteOrder;
  customParser?: (buffer: Uint8Array) => { consumed: number; values: number[] } | null;
}

export function validateProtocolConfig(config: ProtocolConfig): string | null {
  if (!config || typeof config !== 'object' || !('type' in config)) return '协议配置格式无效';
  if (config.type === 'firewater') return null;
  if (config.type === 'justfloat') {
    return config.channels === null || (Number.isInteger(config.channels) && config.channels >= 1 && config.channels <= 64)
      ? null : 'JustFloat 通道数必须为空或在 1 到 64 之间';
  }
  if (config.type === 'rawdata') {
    if (config.mode !== 'display' && config.mode !== 'decode') return 'RawData 模式无效';
    if (!Number.isInteger(config.channels) || config.channels < 1 || config.channels > 64) return 'RawData 通道数必须在 1 到 64 之间';
    return ['u8', 'i8', 'u16le', 'u16be', 'i16le', 'i16be', 'u32le', 'u32be', 'i32le', 'i32be', 'f32le', 'f32be', 'f64le', 'f64be'].includes(config.format)
      ? null : 'RawData 数值类型无效';
  }
  if (config.type === 'custom') {
    if (!Array.isArray(config.header) || config.header.length < 1 || config.header.length > 64 || !config.header.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return 'CustomFrame 帧头须为 1 到 64 个有效字节';
    if (!Array.isArray(config.tail) || config.tail.length > 64 || !config.tail.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return 'CustomFrame 帧尾最多 64 个有效字节';
    if (!Number.isInteger(config.channels) || config.channels < 1 || config.channels > 64) return 'CustomFrame 通道数必须在 1 到 64 之间';
    if (config.checksumByteOrder !== 'little' && config.checksumByteOrder !== 'big') return '校验字节序无效';
    const width = config.dataType === 'u8' || config.dataType === 'i8' ? 1
      : ['u16le', 'u16be', 'i16le', 'i16be'].includes(config.dataType) ? 2
        : ['f64le', 'f64be'].includes(config.dataType) ? 8 : 4;
    const checksumWidth = config.checksum === 'none' ? 0
      : config.checksum === 'crc16_modbus' || config.checksum === 'crc16_ccitt' ? 2
        : config.checksum === 'sum8' || config.checksum === 'xor8' ? 1 : -1;
    if (checksumWidth < 0) return '校验算法无效';
    if (config.header.length + config.tail.length + width * config.channels + checksumWidth > 65_536) return 'CustomFrame 帧长度超过 64 KiB';
    return null;
  }
  return '不支持的协议类型';
}
