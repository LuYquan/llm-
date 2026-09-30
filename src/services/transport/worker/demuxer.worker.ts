/**
 * Dedicated Web Worker: 纯 TypeScript 串口通信流分流器执行体
 * 在独立 Worker 线程中运行 StreamDemuxer，杜绝高频波形分流对主线程 UI 渲染的阻塞
 */

import { StreamDemuxer } from './stream-demuxer';
import type { WorkerInMessage, WorkerOutMessage } from './types';
import type { ParsedBatch } from '../types';
import { createProtocolEngine } from '../../../core/protocol/ProtocolEngine';
import type { ProtocolConfig } from '../../../core/protocol/types';
import { validateProtocolConfig } from '../../../core/protocol/types';

const MAX_SAMPLES_BUFFER = 20000;
const MAX_LOGS_BUFFER = 5000;

const demuxer = new StreamDemuxer();
let protocolConfig: ProtocolConfig = { type: 'firewater' };
let binaryEngine = createProtocolEngine(protocolConfig);

let pendingSamples: ParsedBatch['samples'] = [];
let pendingFrames: NonNullable<ParsedBatch['frames']> = [];
let pendingLogs: ParsedBatch['logLines'] = [];
let droppedBytesCount = 0;
let pendingProtocolErrors = 0;
let lastDemuxErrorCount = 0;

let batchIntervalMs = 16; // ~60Hz 批次推送
let forwardRawData = false;
let batchTimer: ReturnType<typeof setInterval> | null = null;
let lastStatsPostTime = 0;

function flushBatch(): void {
  const demuxErrors = demuxer.errorCount();
  if (demuxErrors > lastDemuxErrorCount) {
    pendingProtocolErrors += demuxErrors - lastDemuxErrorCount;
  }
  lastDemuxErrorCount = demuxErrors;

  if (pendingSamples.length === 0 && pendingFrames.length === 0 && pendingLogs.length === 0 && droppedBytesCount === 0 && pendingProtocolErrors === 0) {
    return;
  }

  const batch: ParsedBatch = {
    samples: pendingSamples,
    frames: pendingFrames.length > 0 ? pendingFrames : undefined,
    logLines: pendingLogs,
    droppedBytes: droppedBytesCount,
    protocolErrors: pendingProtocolErrors,
  };

  pendingSamples = [];
  pendingFrames = [];
  pendingLogs = [];
  droppedBytesCount = 0;
  pendingProtocolErrors = 0;

  const msg: WorkerOutMessage = {
    type: 'BATCH',
    batch,
  };

  self.postMessage(msg);

  const now = performance.now();
  if (now - lastStatsPostTime > 500) {
    lastStatsPostTime = now;
    const statsMsg: WorkerOutMessage = {
      type: 'STATS',
      dirtyBytes: demuxer.dirtyByteCount(),
      demuxErrors: demuxer.errorCount(),
    };
    self.postMessage(statsMsg);
  }
}

function startTimer(): void {
  if (batchTimer) clearInterval(batchTimer);
  batchTimer = setInterval(flushBatch, batchIntervalMs);
}

startTimer();

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'CHUNK': {
      const { data, timestampUs } = msg;
      if (!data || data.length === 0) return;

      if (forwardRawData) {
        const rawMsg: WorkerOutMessage = {
          type: 'RAW_DATA',
          chunk: data,
        };
        self.postMessage(rawMsg);
      }

      if (protocolConfig.type !== 'firewater') {
        if (protocolConfig.type === 'rawdata' && protocolConfig.mode === 'display') return;
        const baseTs = timestampUs ?? Math.round(performance.now() * 1000);
        const output = binaryEngine.feed(data, baseTs);
        droppedBytesCount += output.droppedBytes;
        pendingProtocolErrors += output.errorCount;
        for (const frame of output.frames) {
          pendingFrames.push(frame);
          const t = frame.timestampUs / 1_000_000;
          for (let index = 0; index < frame.values.length; index++) {
            const value = frame.values[index];
            if (Number.isFinite(value)) pendingSamples.push({ channel: frame.channelNames?.[index] ?? `ch${index}`, t, v: value });
          }
        }
        for (const log of output.logs) pendingLogs.push({ t: log.timestampUs / 1_000_000, text: log.text });
        if (pendingSamples.length >= 200 || pendingFrames.length >= 200 || pendingLogs.length >= 100 || output.droppedBytes > 0) flushBatch();
        return;
      }

      const lines = demuxer.processBytes(data);
      if (lines.length === 0) {
        return;
      }

      const baseTs = timestampUs ?? Math.round(performance.now() * 1000);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 增量步进微秒时间戳以保持单调递增
        const lineTs = baseTs + i * 1000;
        const result = demuxer.demuxLine(line, lineTs, 'Rx');

        if (result.type === 'sample') {
          const channels = demuxer.channelNames();
          const tSec = result.sample.timestamp_us / 1_000_000;
          for (let c = 0; c < channels.length; c++) {
            const v = result.sample.values[c];
            if (v !== undefined && v !== null && Number.isFinite(v)) {
              pendingSamples.push({
                channel: channels[c],
                t: tSec,
                v,
              });
            }
          }

          // 有界缓冲防内存泄漏：若前端处于后台标签页挂起未拉取，丢弃最旧数据
          if (pendingSamples.length > MAX_SAMPLES_BUFFER) {
            const overflow = pendingSamples.length - MAX_SAMPLES_BUFFER;
            pendingSamples.splice(0, overflow);
            droppedBytesCount += overflow * 16;
          }
        } else if (result.type === 'log') {
          pendingLogs.push({
            t: result.log.timestamp_us / 1_000_000,
            text: result.log.text,
          });

          if (pendingLogs.length > MAX_LOGS_BUFFER) {
            const overflow = pendingLogs.length - MAX_LOGS_BUFFER;
            pendingLogs.splice(0, overflow);
          }
        }
      }

      // 若积攒点数达到瞬态阈值，提前立即刷新
      if (pendingSamples.length >= 200 || pendingLogs.length >= 100) {
        flushBatch();
      }
      break;
    }

    case 'FLUSH': {
      const flushedSample = demuxer.flush();
      if (flushedSample) {
        const channels = demuxer.channelNames();
        const tSec = flushedSample.timestamp_us / 1_000_000;
        for (let c = 0; c < channels.length; c++) {
          const v = flushedSample.values[c];
          if (v !== undefined && v !== null && Number.isFinite(v)) {
            pendingSamples.push({
              channel: channels[c],
              t: tSec,
              v,
            });
          }
        }
      }
      flushBatch();

      const statsMsg: WorkerOutMessage = {
        type: 'STATS',
        dirtyBytes: demuxer.dirtyByteCount(),
        demuxErrors: demuxer.errorCount(),
      };
      self.postMessage(statsMsg);
      break;
    }

    case 'RESET': {
      demuxer.reset();
      binaryEngine.reset();
      pendingSamples = [];
      pendingFrames = [];
      pendingLogs = [];
      droppedBytesCount = 0;
      pendingProtocolErrors = 0;
      lastDemuxErrorCount = 0;
      break;
    }

    case 'SET_TIME_WINDOW': {
      demuxer.setTimeWindow(msg.windowUs);
      break;
    }

    case 'CONFIGURE': {
      if (msg.batchIntervalMs && msg.batchIntervalMs > 0) {
        batchIntervalMs = msg.batchIntervalMs;
        startTimer();
      }
      if (msg.forwardRawData !== undefined) {
        forwardRawData = msg.forwardRawData;
      }
      if (msg.protocolConfig) {
        const validationError = validateProtocolConfig(msg.protocolConfig);
        if (validationError) {
          if (msg.requestId !== undefined) {
            self.postMessage({ type: 'CONFIGURED', requestId: msg.requestId, error: validationError } satisfies WorkerOutMessage);
          }
          break;
        }
        flushBatch();
        try {
          const nextEngine = createProtocolEngine(msg.protocolConfig);
          protocolConfig = msg.protocolConfig;
          binaryEngine = nextEngine;
          demuxer.reset();
          pendingSamples = [];
          pendingFrames = [];
          pendingLogs = [];
          droppedBytesCount = 0;
          pendingProtocolErrors = 0;
          lastDemuxErrorCount = 0;
        } catch (error) {
          if (msg.requestId !== undefined) {
            const detail = error instanceof Error ? error.message : String(error);
            self.postMessage({ type: 'CONFIGURED', requestId: msg.requestId, error: detail } satisfies WorkerOutMessage);
          }
          break;
        }
      }
      if (msg.requestId !== undefined) {
        self.postMessage({ type: 'CONFIGURED', requestId: msg.requestId } satisfies WorkerOutMessage);
      }
      break;
    }
  }
};
