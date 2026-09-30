/**
 * VOFA+ JustFloat 二进制协议解析器
 * 格式: N 个 IEEE 754 float32 小端单精度浮点数 (每个 4 字节)，以 0x00, 0x00, 0x80, 0x7F (尾帧) 结尾
 */

import type { IProtocolParser, ProtocolOutput, JustFloatOptions, ChannelFrame } from './types';

// 尾帧字节序列: 0x00, 0x00, 0x80, 0x7F
const TAIL_BYTE_0 = 0x00;
const TAIL_BYTE_1 = 0x00;
const TAIL_BYTE_2 = 0x80;
const TAIL_BYTE_3 = 0x7f;

export class JustFloatParser implements IProtocolParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private expectedChannels?: number;
  private maxBufferSize = 65536; // 64KB 异常截断防护

  constructor(options: JustFloatOptions = {}) {
    if (options.channels && options.channels > 0) {
      this.expectedChannels = options.channels;
    }
  }

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

    let searchStart = 0;
    let frameStart = 0;

    while (searchStart + 3 < this.buffer.length) {
      // 搜索尾帧序列 00 00 80 7F
      if (
        this.buffer[searchStart] === TAIL_BYTE_0 &&
        this.buffer[searchStart + 1] === TAIL_BYTE_1 &&
        this.buffer[searchStart + 2] === TAIL_BYTE_2 &&
        this.buffer[searchStart + 3] === TAIL_BYTE_3
      ) {
        const payloadLen = searchStart - frameStart;

        if (payloadLen > 0) {
          // Rust 端的契约是整段 payload 必须按 float32 对齐，并且在声明
          // 通道数时必须精确匹配；不能通过截断前导字节把坏帧伪装成有效帧。
          const expectedPayloadBytes = this.expectedChannels === undefined ? null : this.expectedChannels * 4;
          const remainder = payloadLen % 4;
          let validStart = frameStart;
          let validLen = payloadLen;
          if (remainder !== 0) {
            droppedBytes += remainder;
            errorCount++;
            validStart += remainder;
            validLen -= remainder;
          }

          // When a channel count is declared, discard extra leading corrupt
          // values but never emit a partial frame with fewer channels.
          if (expectedPayloadBytes !== null && validLen > expectedPayloadBytes) {
            const extra = validLen - expectedPayloadBytes;
            droppedBytes += extra;
            errorCount++;
            validStart += extra;
            validLen = expectedPayloadBytes;
          }

          const validPayload = validLen >= 4
            && validLen % 4 === 0
            && (expectedPayloadBytes === null || validLen === expectedPayloadBytes);

          if (!validPayload) {
            if (validLen > 0) {
              droppedBytes += validLen;
              errorCount++;
            }
          } else {
            const channelCount = validLen / 4;
            const values: number[] = new Array(channelCount);
            const view = new DataView(
              this.buffer.buffer,
              this.buffer.byteOffset + validStart,
              validLen
            );

            for (let ch = 0; ch < channelCount; ch++) {
              values[ch] = view.getFloat32(ch * 4, true); // true = Little-Endian
            }

            if (values.every(Number.isFinite)) {
              frames.push({ timestampUs, values });
            } else {
              // 与 Rust 一致：整段非有限 payload 计为坏帧并保留错误证据。
              droppedBytes += validLen;
              errorCount++;
            }
          }
        }

        // 跳过尾帧 4 字节
        frameStart = searchStart + 4;
        searchStart = frameStart;
      } else {
        searchStart++;
      }
    }

    if (frameStart > 0) {
      this.buffer = this.buffer.subarray(frameStart);
    }

    // 缓冲区过大且未找到尾帧，丢弃历史字节并保留最后 3 字节以防尾帧被截断
    if (this.buffer.length > this.maxBufferSize) {
      const dropCount = this.buffer.length - 3;
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
    // 二进制尾帧协议无法在没有尾帧的情况下盲目刷新，清空缓冲区
    const dropped = this.buffer.length;
    this.buffer = new Uint8Array(0);
    return {
      frames: [],
      logs: [],
      droppedBytes: dropped,
      errorCount: dropped > 0 ? 1 : 0,
    };
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}
