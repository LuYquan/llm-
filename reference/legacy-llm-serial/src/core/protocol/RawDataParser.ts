/**
 * VOFA+ RawData 原生数据解析器
 * 支持按单字节或多字节字长 (u8, i16, f32 等) 与指定通道数进行流式解析
 */

import type { IProtocolParser, ProtocolOutput, RawDataFormat, RawDataOptions, ChannelFrame } from './types';

export class RawDataParser implements IProtocolParser {
  private format: RawDataFormat;
  private channels: number;
  private buffer: Uint8Array = new Uint8Array(0);
  private sampleBytes: number;
  private maxBufferSize: number = 65536;

  constructor(options: RawDataOptions = {}) {
    this.format = options.format || 'u8';
    this.channels = Math.max(1, options.channels || 1);
    this.sampleBytes = this.calcSampleBytes(this.format);
  }

  private calcSampleBytes(fmt: RawDataFormat): number {
    switch (fmt) {
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
    }
  }

  private readSample(view: DataView, offset: number): number {
    switch (this.format) {
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
    }
  }

  feed(chunk: Uint8Array, timestampUs: number = Date.now() * 1000): ProtocolOutput {
    if (chunk.length === 0) {
      return { frames: [], logs: [], droppedBytes: 0, errorCount: 0 };
    }

    // 拼接缓冲区
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frameBytes = this.sampleBytes * this.channels;
    const frames: ChannelFrame[] = [];
    let droppedBytes = 0;
    let errorCount = 0;
    let offset = 0;
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);

    while (offset + frameBytes <= this.buffer.length) {
      const values: number[] = new Array(this.channels);
      for (let ch = 0; ch < this.channels; ch++) {
        values[ch] = this.readSample(view, offset + ch * this.sampleBytes);
      }
      if (values.every(Number.isFinite)) {
        frames.push({
          timestampUs,
          values,
        });
      } else {
        // 与 Rust BinaryProtocolParser 一致：非有限值使整帧无效，不能
        // 将 NaN/Infinity 继续传播到波形和分析层。
        droppedBytes += frameBytes;
        errorCount++;
      }
      offset += frameBytes;
    }

    // 保留未凑满一个 frame 的残留字节
    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset);
    }

    if (this.buffer.length > this.maxBufferSize) {
      const preserve = Math.min(
        this.maxBufferSize,
        this.sampleBytes * Math.max(1, this.channels - 1)
      );
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
