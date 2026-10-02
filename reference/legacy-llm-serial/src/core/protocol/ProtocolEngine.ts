/**
 * 协议引擎总控调度器 (ProtocolEngine)
 * 统一管理与热切换 RawData / FireWater / JustFloat / CustomFrame 解析器
 */

import type {
  IProtocolParser,
  ProtocolType,
  ProtocolOutput,
  RawDataOptions,
  FireWaterOptions,
  JustFloatOptions,
  CustomFrameOptions,
  ProtocolConfig,
} from './types';
import { RawDataParser } from './RawDataParser';
import { FireWaterParser } from './FireWaterParser';
import { JustFloatParser } from './JustFloatParser';
import { CustomFrameParser } from './CustomFrameParser';

export class ProtocolEngine implements IProtocolParser {
  private currentType: ProtocolType = 'firewater';
  private parser: IProtocolParser;
  private totalFrames = 0;
  private totalLogs = 0;
  private totalDroppedBytes = 0;
  private totalErrors = 0;

  constructor(type: ProtocolType = 'firewater', options?: any) {
    this.currentType = type;
    this.parser = this.createParser(type, options);
  }

  private createParser(type: ProtocolType, options?: any): IProtocolParser {
    switch (type) {
      case 'rawdata':
        return new RawDataParser(options as RawDataOptions);
      case 'firewater':
        return new FireWaterParser(options as FireWaterOptions);
      case 'justfloat':
        return new JustFloatParser(options as JustFloatOptions);
      case 'custom':
        return new CustomFrameParser(options as CustomFrameOptions);
      default:
        return new FireWaterParser();
    }
  }

  public setProtocol(type: ProtocolType, options?: any): void {
    if (this.currentType !== type || options) {
      this.currentType = type;
      this.parser = this.createParser(type, options);
    }
  }

  public getProtocol(): ProtocolType {
    return this.currentType;
  }

  public feed(chunk: Uint8Array, timestampUs?: number): ProtocolOutput {
    const res = this.parser.feed(chunk, timestampUs);
    this.totalFrames += res.frames.length;
    this.totalLogs += res.logs.length;
    this.totalDroppedBytes += res.droppedBytes;
    this.totalErrors += res.errorCount;
    return res;
  }

  public flush(timestampUs?: number): ProtocolOutput {
    const res = this.parser.flush(timestampUs);
    this.totalFrames += res.frames.length;
    this.totalLogs += res.logs.length;
    this.totalDroppedBytes += res.droppedBytes;
    this.totalErrors += res.errorCount;
    return res;
  }

  public reset(): void {
    this.parser.reset();
  }

  public resetStats(): void {
    this.totalFrames = 0;
    this.totalLogs = 0;
    this.totalDroppedBytes = 0;
    this.totalErrors = 0;
  }

  public getStats() {
    return {
      totalFrames: this.totalFrames,
      totalLogs: this.totalLogs,
      totalDroppedBytes: this.totalDroppedBytes,
      totalErrors: this.totalErrors,
    };
  }
}

/** Build the exact parser selected by the persisted cross-runtime configuration. */
export function createProtocolEngine(config: ProtocolConfig): ProtocolEngine {
  switch (config.type) {
    case 'firewater':
      return new ProtocolEngine('firewater');
    case 'justfloat':
      return new ProtocolEngine('justfloat', {
        channels: config.channels ?? undefined,
      });
    case 'rawdata':
      return new ProtocolEngine('rawdata', {
        format: config.format,
        channels: config.channels,
      });
    case 'custom':
      return new ProtocolEngine('custom', {
        header: config.header,
        tail: config.tail,
        channels: config.channels,
        dataType: config.dataType,
        checksum: config.checksum,
        checksumByteOrder: config.checksumByteOrder,
      });
  }
}
