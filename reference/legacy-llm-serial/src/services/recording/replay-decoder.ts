import { createProtocolEngine, type ProtocolEngine } from '../../core/protocol/ProtocolEngine';
import type { ProtocolConfig, ProtocolOutput } from '../../core/protocol/types';
import type { RecordedRawChunk, RecordingPage } from '../transport/session';

export interface RecordingReplaySample {
  channel: string;
  timeSeconds: number;
  value: number;
}

export interface RecordingReplayDecodeResult {
  samples: RecordingReplaySample[];
  logs: { timeSeconds: number; text: string }[];
  droppedBytes: number;
  errorCount: number;
}

const MAX_REPLAY_SAMPLES_PER_PAGE = 100_000;

/**
 * Offline decoder for a single recording session. It owns its parser instance,
 * so replay never writes into or changes the live channel store.
 */
export class RecordingReplayDecoder {
  readonly config: ProtocolConfig;
  private readonly engine: ProtocolEngine;

  constructor(config: ProtocolConfig) {
    this.config = JSON.parse(JSON.stringify(config)) as ProtocolConfig;
    this.engine = createProtocolEngine(this.config);
  }

  reset(): void {
    this.engine.reset();
  }

  feedPage(page: RecordingPage): RecordingReplayDecodeResult {
    // A missing raw chunk means parser carry-over can no longer be trusted.
    if (page.sequenceGap) this.reset();
    const result: RecordingReplayDecodeResult = {
      samples: [],
      logs: [],
      droppedBytes: 0,
      errorCount: 0,
    };
    for (const chunk of page.chunks) this.appendChunk(chunk, result);
    return result;
  }

  flush(receivedAtUs: number): RecordingReplayDecodeResult {
    return this.collect(this.engine.flush(receivedAtUs));
  }

  private appendChunk(chunk: RecordedRawChunk, result: RecordingReplayDecodeResult): void {
    const output = this.engine.feed(Uint8Array.from(chunk.bytes), chunk.receivedAtUs);
    const decoded = this.collect(output);
    const remaining = Math.max(0, MAX_REPLAY_SAMPLES_PER_PAGE - result.samples.length);
    result.samples.push(...decoded.samples.slice(0, remaining));
    result.logs.push(...decoded.logs);
    result.droppedBytes += decoded.droppedBytes;
    result.errorCount += decoded.errorCount;
  }

  private collect(output: ProtocolOutput): RecordingReplayDecodeResult {
    const samples: RecordingReplaySample[] = [];
    for (const frame of output.frames) {
      const timeSeconds = frame.timestampUs / 1_000_000;
      for (let index = 0; index < frame.values.length; index++) {
        const value = frame.values[index];
        if (!Number.isFinite(value)) continue;
        const channel = frame.channelNames?.[index]?.trim() || `CH${index + 1}`;
        samples.push({ channel, timeSeconds, value });
      }
    }
    return {
      samples,
      logs: output.logs.map((log) => ({ timeSeconds: log.timestampUs / 1_000_000, text: log.text })),
      droppedBytes: output.droppedBytes,
      errorCount: output.errorCount,
    };
  }
}

export function recordingProtocolReplaySupport(config: ProtocolConfig | null): string | null {
  if (!config) return '此旧记录没有保存协议配置，只能核对原始 RX 字节。';
  if (config.type === 'rawdata' && config.mode === 'display') {
    return '此记录使用 RawData 原始显示模式，没有声明数值类型；只能导出原始 RX 字节。';
  }
  return null;
}

export function formatRecordingSamplesCsv(
  samples: RecordingReplaySample[],
  metadata: { sessionId: string; epoch: number; protocol: string; timeSource: string },
  includeHeader = true
): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = includeHeader ? ['session_id,epoch,protocol,time_source,host_receive_seconds,channel,value'] : [];
  for (const sample of samples) {
    rows.push([
      quote(metadata.sessionId),
      String(metadata.epoch),
      quote(metadata.protocol),
      quote(metadata.timeSource),
      sample.timeSeconds.toPrecision(17),
      quote(sample.channel),
      sample.value.toPrecision(17),
    ].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

/**
 * Export raw chunks already loaded from a recording page. One row per chunk
 * preserves receive order, host time, and the exact bytes without pretending
 * that a text or protocol decoder was lossless.
 */
export function formatRecordingRawChunksCsv(
  chunks: readonly RecordedRawChunk[],
  metadata: { sessionId: string; epoch: number },
  includeHeader = true,
): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = includeHeader
    ? ['session_id,epoch,rx_sequence,received_at_us,byte_count,raw_hex']
    : [];
  for (const chunk of chunks) {
    const bytes = chunk.bytes.map((byte) => Number(byte).toString(16).padStart(2, '0').toUpperCase()).join(' ');
    rows.push([
      quote(metadata.sessionId),
      String(metadata.epoch),
      String(chunk.rxSequence),
      String(chunk.receivedAtUs),
      String(chunk.bytes.length),
      quote(bytes),
    ].join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

