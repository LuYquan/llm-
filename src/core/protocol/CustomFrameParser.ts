/**
 * 自定义二进制/文本帧解析器 (CustomFrameParser)
 * 支持用户配置自定义帧头、帧尾、通道数、数值类型与校验算法
 */

import type { IProtocolParser, ProtocolOutput, CustomFrameOptions, ChannelFrame } from './types';

export class CustomFrameParser implements IProtocolParser {
  private options: CustomFrameOptions;
  private buffer: Uint8Array = new Uint8Array(0);
  private sampleBytes: number;

  constructor(options: CustomFrameOptions) {
    this.options = options;
    this.sampleBytes = this.calcSampleBytes(options.dataType || 'f32le');
  }

  private calcSampleBytes(dt: string): number {
    switch (dt) {
      case 'u8':
      case 'i8':
        return 1;
      case 'u16le':
      case 'u16be':
      case 'i16le':
      case 'i16be':
        return 2;
      case 'u32le':
      case 'u32be':
      case 'i32le':
      case 'i32be':
      case 'f32le':
      case 'f32be':
        return 4;
      case 'f64le':
      case 'f64be':
        return 8;
      default:
        return 4;
    }
  }

  private readSample(view: DataView, offset: number): number {
    const dt = this.options.dataType || 'f32le';
    switch (dt) {
      case 'u8':
        return view.getUint8(offset);
      case 'i8':
        return view.getInt8(offset);
      case 'u16le':
        return view.getUint16(offset, true);
      case 'u16be':
        return view.getUint16(offset, false);
      case 'i16le':
        return view.getInt16(offset, true);
      case 'i16be':
        return view.getInt16(offset, false);
      case 'u32le':
        return view.getUint32(offset, true);
      case 'u32be':
        return view.getUint32(offset, false);
      case 'i32le':
        return view.getInt32(offset, true);
      case 'i32be':
        return view.getInt32(offset, false);
      case 'f32le':
        return view.getFloat32(offset, true);
      case 'f32be':
        return view.getFloat32(offset, false);
      case 'f64le':
        return view.getFloat64(offset, true);
      case 'f64be':
        return view.getFloat64(offset, false);
      default:
        return view.getFloat32(offset, true);
    }
  }

  private calcChecksum(data: Uint8Array, type: string): number {
    switch (type) {
      case 'sum8': {
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          sum = (sum + data[i]) & 0xff;
        }
        return sum;
      }
      case 'xor8': {
        let x = 0;
        for (let i = 0; i < data.length; i++) {
          x ^= data[i];
        }
        return x;
      }
      case 'crc16_modbus': {
        let crc = 0xffff;
        for (let i = 0; i < data.length; i++) {
          crc ^= data[i];
          for (let j = 0; j < 8; j++) {
            if (crc & 0x0001) {
              crc = (crc >> 1) ^ 0xa001;
            } else {
              crc >>= 1;
            }
          }
        }
        return crc & 0xffff;
      }
      case 'crc16_ccitt': {
        let crc = 0x0000;
        for (let i = 0; i < data.length; i++) {
          crc ^= (data[i] << 8) & 0xffff;
          for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) {
              crc = ((crc << 1) ^ 0x1021) & 0xffff;
            } else {
              crc = (crc << 1) & 0xffff;
            }
          }
        }
        return crc & 0xffff;
      }
      default:
        return 0;
    }
  }

  private maxBufferSize = 65536;

  feed(chunk: Uint8Array, timestampUs: number = Date.now() * 1000): ProtocolOutput {
    if (chunk.length === 0) {
      return { frames: [], logs: [], droppedBytes: 0, errorCount: 0 };
    }

    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: ChannelFrame[] = [];
    let droppedBytes = 0;
    let errorCount = 0;

    // 1. 若配置了自定义解析函数
    if (this.options.customParser) {
      while (this.buffer.length > 0) {
        const res = this.options.customParser(this.buffer);
        if (!res || res.consumed <= 0) break;
        if (res.values.length > 0) {
          frames.push({
            timestampUs,
            values: res.values,
          });
        }
        this.buffer = this.buffer.subarray(res.consumed);
      }
      return { frames, logs: [], droppedBytes, errorCount };
    }

    // 2. 标准帧结构解析: [Header] + [Payload] + [Checksum?] + [Tail?]
    const header = this.options.header;
    const tail = this.options.tail;
    const channels = this.options.channels;
    const payloadBytes = channels * this.sampleBytes;
    const checksumBytes =
      this.options.checksum === 'crc16_modbus' || this.options.checksum === 'crc16_ccitt'
        ? 2
        : this.options.checksum && this.options.checksum !== 'none'
          ? 1
          : 0;
    const tailBytes = tail ? tail.length : 0;
    const totalFrameLen = header.length + payloadBytes + checksumBytes + tailBytes;

    let offset = 0;
    while (offset + totalFrameLen <= this.buffer.length) {
      // 检查 Header
      let matchHeader = true;
      for (let h = 0; h < header.length; h++) {
        if (this.buffer[offset + h] !== header[h]) {
          matchHeader = false;
          break;
        }
      }

      if (!matchHeader) {
        offset++;
        droppedBytes++;
        continue;
      }

      // 检查 Tail (如果有)
      if (tail && tail.length > 0) {
        const tailOffset = offset + header.length + payloadBytes + checksumBytes;
        let matchTail = true;
        for (let t = 0; t < tail.length; t++) {
          if (this.buffer[tailOffset + t] !== tail[t]) {
            matchTail = false;
            break;
          }
        }
        if (!matchTail) {
          // 伪帧头，继续向后搜索
          offset++;
          droppedBytes++;
          errorCount++;
          continue;
        }
      }

      // 检查校验和 (如果有)
      if (checksumBytes > 0 && this.options.checksum) {
        const checkData = this.buffer.subarray(offset + header.length, offset + header.length + payloadBytes);
        const expectedCheck = this.calcChecksum(checkData, this.options.checksum);
        const checkOffset = offset + header.length + payloadBytes;
        let actualCheck = 0;
        if (checksumBytes === 1) {
          actualCheck = this.buffer[checkOffset];
        } else {
          actualCheck = new DataView(
            this.buffer.buffer,
            this.buffer.byteOffset + checkOffset,
            2
          ).getUint16(0, (this.options.checksumByteOrder || 'little') === 'little');
        }

        if (actualCheck !== expectedCheck) {
          offset++;
          droppedBytes++;
          errorCount++;
          continue;
        }
      }

      // 提取 Payload
      const payloadStart = offset + header.length;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + payloadStart, payloadBytes);
      const values: number[] = new Array(channels);
      for (let ch = 0; ch < channels; ch++) {
        values[ch] = this.readSample(view, ch * this.sampleBytes);
      }

      if (!values.every(Number.isFinite)) {
        offset += totalFrameLen;
        droppedBytes += totalFrameLen;
        errorCount++;
        continue;
      }

      frames.push({
        timestampUs,
        values,
      });

      offset += totalFrameLen;
    }

    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset);
    }

    if (this.buffer.length > this.maxBufferSize) {
      const preserve = Math.min(this.maxBufferSize, Math.max(0, header.length - 1));
      const dropCount = this.buffer.length - preserve;
      droppedBytes += dropCount;
      errorCount++;
      this.buffer = this.buffer.subarray(dropCount);
    }

    return {
      frames,
      logs: [],
      droppedBytes,
      errorCount,
    };
  }

  flush(_timestampUs?: number): ProtocolOutput {
    return { frames: [], logs: [], droppedBytes: 0, errorCount: 0 };
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}
