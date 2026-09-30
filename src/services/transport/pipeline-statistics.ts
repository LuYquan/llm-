import type { ParsedBatch } from './types';

/** Host receive/parse throughput, never a claim about the device's sample clock. */
export class PipelineStatistics {
  private samples = 0;
  private rxBytes = 0;
  private latestTimestamp = -Infinity;
  private rates: { atMs: number; count: number }[] = [];

  reset(): void {
    this.samples = 0;
    this.rxBytes = 0;
    this.latestTimestamp = -Infinity;
    this.rates = [];
  }

  resetProtocol(): void {
    this.samples = 0;
    this.latestTimestamp = -Infinity;
    this.rates = [];
  }

  addBytes(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) this.rxBytes += count;
  }

  addBatch(batch: ParsedBatch, atMs: number): void {
    let count: number;
    if (batch.frames && batch.frames.length > 0) {
      // Every delivered parser frame counts once. The host arrival time may
      // repeat within a chunk or across batches and cannot serve as frame identity.
      count = batch.frames.length;
      for (const frame of batch.frames) {
        const time = frame.timestampUs / 1_000_000;
        if (Number.isFinite(time)) this.latestTimestamp = Math.max(this.latestTimestamp, time);
      }
    } else {
      const times = new Set(batch.samples.filter(sample => Number.isFinite(sample.t) && Number.isFinite(sample.v))
        .map(sample => sample.t).filter(time => time > this.latestTimestamp));
      count = times.size;
      for (const time of times) this.latestTimestamp = Math.max(this.latestTimestamp, time);
    }
    if (!count) return;
    this.samples += count;
    this.rates.push({ atMs, count });
    this.prune(atMs);
  }

  private prune(atMs: number): void {
    this.rates = this.rates.filter(rate => rate.atMs > atMs - 1000);
  }

  snapshot(atMs: number, acquiring: boolean) {
    this.prune(atMs);
    return {
      sample_rate: acquiring ? this.rates.reduce((sum, rate) => sum + rate.count, 0) : 0,
      total_samples: this.samples,
      rx_bytes: this.rxBytes,
    };
  }
}
