/**
 * VOFA+ FireWater 文本协议解析器
 * 纯文本 CSV 行格式 (val0,val1,...,valN\n)，支持与调试文本日志自动分流
 */

import type { IProtocolParser, ProtocolOutput, FireWaterOptions, ChannelFrame, ProtocolLog } from './types';

const FLOAT_REGEX = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

export class FireWaterParser implements IProtocolParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  private maxBufferSize = 16384; // 16KB 超长行防御
  private delimiter: string;

  constructor(options: FireWaterOptions = {}) {
    this.delimiter = options.delimiter || ',';
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
    const logs: ProtocolLog[] = [];
    let droppedBytes = 0;
    let errorCount = 0;

    let newlineIdx = this.buffer.indexOf(0x0a); // '\n'

    while (newlineIdx !== -1) {
      const lineBytes = this.buffer.subarray(0, newlineIdx + 1);
      this.buffer = this.buffer.subarray(newlineIdx + 1);

      const decoded = this.utf8Decoder.decode(lineBytes);
      const trimmed = decoded.replace(/[\r\n]+$/, '').trim();

      if (trimmed.length > 0) {
        this.parseLine(trimmed, timestampUs, frames, logs, () => {
          errorCount++;
        });
      }

      newlineIdx = this.buffer.indexOf(0x0a);
    }

    // 防御性设计：超过 16KB 无换行符，清空丢弃并记录丢包
    if (this.buffer.length > this.maxBufferSize) {
      droppedBytes += this.buffer.length;
      this.buffer = new Uint8Array(0);
    }

    return {
      frames,
      logs,
      droppedBytes,
      errorCount,
    };
  }

  private parseLine(
    line: string,
    timestampUs: number,
    frames: ChannelFrame[],
    logs: ProtocolLog[],
    onError: () => void
  ): void {
    // 1. 明确的日志前缀过滤
    const upper = line.toUpperCase();
    if (
      line.startsWith('[') ||
      line.startsWith('#') ||
      line.startsWith('//') ||
      upper.startsWith('INFO:') ||
      upper.startsWith('WARN:') ||
      upper.startsWith('ERROR:') ||
      upper.startsWith('DEBUG:')
    ) {
      logs.push(this.formatLog(line, timestampUs));
      return;
    }

    // 2. Teleplot 格式行 (>key:val)
    if (line.startsWith('>')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 1) {
        const key = line.slice(1, colonIdx).trim();
        const valStr = line.slice(colonIdx + 1).trim();
        if (FLOAT_REGEX.test(valStr)) {
          const val = Number(valStr);
          if (Number.isFinite(val)) {
            frames.push({
              timestampUs,
              values: [val],
              channelNames: [key],
            });
            return;
          }
        }
      }
      onError();
      return;
    }

    // 3. FireWater CSV 数值行
    if (line.includes(this.delimiter)) {
      let parts = line.split(this.delimiter);
      // 容错处理：单片机固件 printf("%f,%f,\n") 常带末尾多余分隔符
      if (parts.length > 1 && parts[parts.length - 1].trim().length === 0) {
        parts = parts.slice(0, parts.length - 1);
      }

      const values: number[] = [];
      let isAllNumbers = true;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (part.length === 0 || !FLOAT_REGEX.test(part)) {
          isAllNumbers = false;
          break;
        }
        const val = Number(part);
        if (!Number.isFinite(val)) {
          isAllNumbers = false;
          break;
        }
        values.push(val);
      }

      if (isAllNumbers && values.length > 0) {
        frames.push({
          timestampUs,
          values,
        });
        return;
      }

      // 如果不是纯数值 CSV，判断是否首字段为数值
      const firstPart = parts[0].trim();
      if (FLOAT_REGEX.test(firstPart)) {
        onError(); // 损坏的数值行
      } else {
        logs.push(this.formatLog(line, timestampUs)); // 含逗号的文本行
      }
      return;
    }

    // 4. 单值纯数值行 (例如 "12.34\n")
    if (FLOAT_REGEX.test(line)) {
      const val = Number(line);
      if (Number.isFinite(val)) {
        frames.push({
          timestampUs,
          values: [val],
        });
        return;
      }
    }

    // 5. 其余普通文本归入日志
    logs.push(this.formatLog(line, timestampUs));
  }

  private formatLog(text: string, timestampUs: number): ProtocolLog {
    const upper = text.toUpperCase();
    let level: 'Info' | 'Warn' | 'Error' = 'Info';
    if (upper.includes('[ERR') || upper.includes('[ERROR]') || upper.includes('ERROR:')) {
      level = 'Error';
    } else if (upper.includes('[WARN') || upper.includes('[WARNING]') || upper.includes('WARN:')) {
      level = 'Warn';
    }
    return {
      timestampUs,
      text,
      level,
    };
  }

  flush(timestampUs: number = Date.now() * 1000): ProtocolOutput {
    if (this.buffer.length === 0) {
      return { frames: [], logs: [], droppedBytes: 0, errorCount: 0 };
    }
    const decoded = this.utf8Decoder.decode(this.buffer).trim();
    this.buffer = new Uint8Array(0);
    if (!decoded) {
      return { frames: [], logs: [], droppedBytes: 0, errorCount: 0 };
    }

    const frames: ChannelFrame[] = [];
    const logs: ProtocolLog[] = [];
    let errorCount = 0;
    this.parseLine(decoded, timestampUs, frames, logs, () => {
      errorCount++;
    });

    return {
      frames,
      logs,
      droppedBytes: 0,
      errorCount,
    };
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}
