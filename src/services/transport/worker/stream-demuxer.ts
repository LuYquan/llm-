/**
 * 纯 TypeScript 串口通信流分流器 (StreamDemuxer & TeleplotAligner)
 * 100% 对齐 Rust 后端 (src-tauri/src/pipeline/) 与 docs/protocol/stream-format.md
 */

import type { DemuxOutput, LogDirection, LogLevel, LogLine, SamplePoint } from './types';

export const FLOAT_REGEX = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * 纯文本协议行级静态解析器
 */
export class TextParser {
  /**
   * 解析 CSV 逗号分隔的浮点数数值行
   * 输入示例: "10.00,9.23,30.15\r\n" -> [10.0, 9.23, 30.15]
   * 非纯数值或格式错误返回 null
   */
  static parseCsvLine(line: string): number[] | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // 快速前缀过滤：若以 '['、'#'、'//'、'>' 开头，显然不是标准 CSV 数值行
    if (
      trimmed.startsWith('[') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('>')
    ) {
      return null;
    }

    const parts = trimmed.split(',');
    const values: number[] = new Array(parts.length);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (part.length === 0 || !FLOAT_REGEX.test(part)) {
        return null;
      }
      const val = Number(part);
      if (!Number.isFinite(val)) {
        return null;
      }
      values[i] = val;
    }

    return values;
  }

  /**
   * 解析 Teleplot 键值对行 (>变量名:数值)
   * 输入示例: ">setpoint:10.00\r\n" -> ["setpoint", 10.0]
   */
  static parseTeleplotLine(line: string): [string, number] | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('>')) {
      return null;
    }

    const content = trimmed.slice(1);
    const colonIndex = content.indexOf(':');
    if (colonIndex === -1) {
      return null;
    }

    const name = content.slice(0, colonIndex).trim();
    const valStr = content.slice(colonIndex + 1).trim();

    if (name.length === 0 || valStr.length === 0 || !FLOAT_REGEX.test(valStr)) {
      return null;
    }

    const val = Number(valStr);
    if (!Number.isFinite(val)) {
      return null;
    }

    return [name, val];
  }

  /**
   * 从日志文本推断日志级别并生成 LogLine 结构
   */
  static parseLogLine(
    text: string,
    timestampUs: number,
    direction: LogDirection = 'Rx'
  ): LogLine {
    const upper = text.toUpperCase();
    let level: LogLevel = 'Info';

    if (
      upper.includes('[ERR') ||
      upper.includes('[ERROR]') ||
      upper.includes('ERROR:')
    ) {
      level = 'Error';
    } else if (
      upper.includes('[WARN') ||
      upper.includes('[WARNING]') ||
      upper.includes('WARN:')
    ) {
      level = 'Warn';
    }

    return {
      timestamp_us: timestampUs,
      direction,
      level,
      text: text.trim(),
    };
  }
}

/**
 * Teleplot 异步多变量时间对齐器 (对齐 Rust TeleplotAligner)
 */
export class TeleplotAligner {
  private cache = new Map<string, number>();
  private currentFrameVars = new Set<string>();
  private currentFrameTimestampUs: number | null = null;
  private lastVarTimestampUs: number | null = null;
  private channelOrderList: string[] = [];
  private timeWindowUs: number;

  constructor(timeWindowUs = 10000) {
    this.timeWindowUs = timeWindowUs;
  }

  feed(key: string, val: number, timestampUs: number): SamplePoint | null {
    let completedPoint: SamplePoint | null = null;

    // 判断是否触发新一轮帧周期翻转：
    // 1. 该变量在当前帧中已经出现过（新的一轮控制循环开始）
    // 2. 与当前帧内上一个变量的时间间隔超过了 timeWindowUs（空闲超时断帧）
    const isVarRepeat = this.currentFrameVars.has(key);
    const isIdleTimeout =
      this.lastVarTimestampUs !== null &&
      timestampUs - this.lastVarTimestampUs > this.timeWindowUs;

    const isRollover = isVarRepeat || isIdleTimeout;

    if (isRollover && this.currentFrameVars.size > 0) {
      const ts = this.currentFrameTimestampUs ?? timestampUs;
      const values: (number | null)[] = this.channelOrderList.map((ch) =>
        this.currentFrameVars.has(ch) ? (this.cache.get(ch) ?? null) : null
      );

      completedPoint = {
        timestamp_us: ts,
        values,
      };

      // 开启新一帧
      this.currentFrameVars.clear();
      this.currentFrameTimestampUs = timestampUs;
    } else if (this.currentFrameTimestampUs === null) {
      this.currentFrameTimestampUs = timestampUs;
    }

    this.lastVarTimestampUs = timestampUs;

    // 注册新通道（如果第一次见到）
    if (!this.channelOrderList.includes(key)) {
      this.channelOrderList.push(key);
    }

    // 更新最新值缓存与当前帧标记
    this.cache.set(key, val);
    this.currentFrameVars.add(key);

    return completedPoint;
  }

  flush(): SamplePoint | null {
    if (this.currentFrameVars.size === 0) {
      return null;
    }

    const ts = this.currentFrameTimestampUs ?? 0;
    const values: (number | null)[] = this.channelOrderList.map((ch) =>
      this.currentFrameVars.has(ch) ? (this.cache.get(ch) ?? null) : null
    );

    this.currentFrameVars.clear();
    this.currentFrameTimestampUs = null;
    this.lastVarTimestampUs = null;

    return {
      timestamp_us: ts,
      values,
    };
  }

  reset(): void {
    this.cache.clear();
    this.currentFrameVars.clear();
    this.currentFrameTimestampUs = null;
    this.lastVarTimestampUs = null;
    this.channelOrderList = [];
  }

  channelOrder(): string[] {
    return this.channelOrderList;
  }

  setTimeWindow(windowUs: number): void {
    this.timeWindowUs = windowUs;
  }
}

/**
 * 串口数据流智能分流器 (StreamDemuxer)
 * 支持逐字节提取、超长行防护、乱码容错与多协议自适应路由
 */
export class StreamDemuxer {
  private teleplotAligner: TeleplotAligner;
  private lineBuffer: Uint8Array = new Uint8Array(0);
  private utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  private demuxErrorCount = 0;
  private byteDirtyCount = 0;
  private channelNamesList: string[];

  constructor(channels: string[] = ['setpoint', 'actual', 'output']) {
    this.teleplotAligner = new TeleplotAligner();
    this.channelNamesList = [...channels];
  }

  /**
   * 从原始串口字节流中追加切片、提取完整行，并做 UTF-8 校验与 64KiB 超长行防护
   * 100% 对齐 Rust process_serial_bytes
   */
  processBytes(readBytes: Uint8Array): string[] {
    if (readBytes.length === 0) {
      return [];
    }

    // 合并新切片至内部缓冲区
    const merged = new Uint8Array(this.lineBuffer.length + readBytes.length);
    merged.set(this.lineBuffer, 0);
    merged.set(readBytes, this.lineBuffer.length);
    this.lineBuffer = merged;

    const lines: string[] = [];
    let newlineIdx = this.lineBuffer.indexOf(0x0a); // '\n'

    while (newlineIdx !== -1) {
      if (newlineIdx + 1 > 65_536) {
        this.lineBuffer = this.lineBuffer.subarray(newlineIdx + 1);
        this.byteDirtyCount++;
        newlineIdx = this.lineBuffer.indexOf(0x0a);
        continue;
      }
      // 提取截至 \n 的字节 (..=pos)
      const lineBytes = this.lineBuffer.subarray(0, newlineIdx + 1);
      this.lineBuffer = this.lineBuffer.subarray(newlineIdx + 1);

      try {
        const decoded = this.utf8Decoder.decode(lineBytes);
        // 去除末尾 \r 与 \n
        const trimmed = decoded.replace(/[\r\n]+$/, '');
        if (trimmed.length > 0) {
          lines.push(trimmed);
        }
      } catch {
        // 遇到非 UTF-8 乱码或非法字节，静默丢弃单行并累加 byte_dirty_count
        this.byteDirtyCount++;
      }

      newlineIdx = this.lineBuffer.indexOf(0x0a);
    }

    // 文本解析副本最多保留 64 KiB；原始接收字节由 transport/记录器独立持有。
    if (this.lineBuffer.length > 65_536) {
      this.byteDirtyCount++;
      this.lineBuffer = new Uint8Array(0);
    }

    return lines;
  }

  /**
   * 逐行智能分流与协议解析
   * 100% 对齐 Rust StreamDemuxer::demux_line
   */
  demuxLine(
    line: string,
    timestampUs: number,
    direction: LogDirection = 'Rx'
  ): DemuxOutput {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return { type: 'none' };
    }

    // 1. Teleplot 路由：以 `>` 开头
    if (trimmed.startsWith('>')) {
      const parsed = TextParser.parseTeleplotLine(trimmed);
      if (parsed) {
        const [name, val] = parsed;
        const sample = this.teleplotAligner.feed(name, val, timestampUs);
        if (sample) {
          return { type: 'sample', sample };
        }
        return { type: 'none' };
      } else {
        // 格式非法的 Teleplot 键值对行，累加错误计数并静默丢弃 (绝不抛出异常)
        this.demuxErrorCount++;
        return { type: 'none' };
      }
    }

    // 2. 明确的日志前缀过滤 (即使包含逗号，如 `[INFO] System ready, 3 sensors found`)
    const upper = trimmed.toUpperCase();
    if (
      trimmed.startsWith('[') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      upper.startsWith('INFO:') ||
      upper.startsWith('WARN:') ||
      upper.startsWith('ERROR:') ||
      upper.startsWith('DEBUG:')
    ) {
      const log = TextParser.parseLogLine(trimmed, timestampUs, direction);
      return { type: 'log', log };
    }

    // 3. CSV 路由：包含英文逗号 `,`
    if (trimmed.includes(',')) {
      const values = TextParser.parseCsvLine(trimmed);
      if (values) {
        // 自动补齐通道名
        if (this.channelNamesList.length < values.length) {
          for (let i = this.channelNamesList.length; i < values.length; i++) {
            this.channelNamesList.push(`ch${i}`);
          }
        }
        return {
          type: 'sample',
          sample: {
            timestamp_us: timestampUs,
            values: values,
          },
        };
      } else {
        // 包含逗号但不满足纯数值 CSV。
        // 检查：如果第一个字段可解析为浮点数（例如 "10.0,??#$%,30.0"），则判定为损坏的 CSV 行，统计错误并静默丢弃；
        // 否则（例如 "System booted, ready for command"），判定为含逗号的普通文本日志，路由至日志缓冲。
        const firstPart = trimmed.split(',')[0].trim();
        const startsWithNumber = FLOAT_REGEX.test(firstPart);

        if (startsWithNumber) {
          this.demuxErrorCount++;
          return { type: 'none' };
        } else {
          const log = TextParser.parseLogLine(trimmed, timestampUs, direction);
          return { type: 'log', log };
        }
      }
    }

    // 4. 其余所有非数值普通文本，路由至日志缓冲
    const log = TextParser.parseLogLine(trimmed, timestampUs, direction);
    return { type: 'log', log };
  }

  /**
   * 强制刷新 Teleplot 对齐器中尚未打包的最后一组变量
   */
  flush(): SamplePoint | null {
    return this.teleplotAligner.flush();
  }

  /**
   * 获取累计格式与解析错误计数 (demux_error_count)
   */
  errorCount(): number {
    return this.demuxErrorCount;
  }

  /**
   * 获取累计非法字节与超长缓冲截断计数 (byte_dirty_count)
   */
  dirtyByteCount(): number {
    return this.byteDirtyCount;
  }

  /**
   * 获取当前有效通道名列表
   */
  channelNames(): string[] {
    const teleplotChannels = this.teleplotAligner.channelOrder();
    if (teleplotChannels.length > 0) {
      return teleplotChannels;
    }
    return this.channelNamesList;
  }

  /**
   * 重置分流器内部状态与全部计数
   */
  reset(): void {
    this.teleplotAligner.reset();
    this.lineBuffer = new Uint8Array(0);
    this.demuxErrorCount = 0;
    this.byteDirtyCount = 0;
    this.channelNamesList = ['setpoint', 'actual', 'output'];
  }

  setTimeWindow(windowUs: number): void {
    this.teleplotAligner.setTimeWindow(windowUs);
  }
}
