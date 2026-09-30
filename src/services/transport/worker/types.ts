/**
 * Web Worker 流分流器消息协议与数据契约
 * 对齐 docs/protocol/stream-format.md 与 types/ipc.ts
 */

import type { ParsedBatch } from '../types';
import type { LogDirection, LogLevel, SamplePoint, LogLine } from '../../../types/ipc';
import type { ProtocolConfig } from '../../../core/protocol/types';

export type { LogDirection, LogLevel, SamplePoint, LogLine };

/**
 * 主线程 -> Dedicated Web Worker 输入消息契约
 */
export type WorkerInMessage =
  | {
      type: 'CHUNK';
      data: Uint8Array;
      timestampUs?: number;
    }
  | {
      type: 'FLUSH';
    }
  | {
      type: 'RESET';
    }
  | {
      type: 'SET_TIME_WINDOW';
      windowUs: number;
    }
  | {
      type: 'CONFIGURE';
      batchIntervalMs?: number;
      forwardRawData?: boolean;
      protocolConfig?: ProtocolConfig;
      requestId?: number;
    };

/**
 * Dedicated Web Worker -> 主线程 输出消息契约
 */
export type WorkerOutMessage =
  | {
      type: 'BATCH';
      batch: ParsedBatch;
    }
  | {
      type: 'RAW_DATA';
      chunk: Uint8Array;
    }
  | {
      type: 'STATS';
      dirtyBytes: number;
      demuxErrors: number;
    }
  | {
      type: 'CONFIGURED';
      requestId: number;
      error?: string;
    };

/**
 * 分流器逐行处理单次输出结果
 */
export type DemuxOutput =
  | {
      type: 'sample';
      sample: SamplePoint;
    }
  | {
      type: 'log';
      log: LogLine;
    }
  | {
      type: 'none';
    };
