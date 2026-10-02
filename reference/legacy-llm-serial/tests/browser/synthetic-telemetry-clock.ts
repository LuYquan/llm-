/** Fixture-only buffered sample clock. Browser callback cadence is not device sampling cadence. */
export class SyntheticTelemetryClock {
  private lastSampleAt: number;
  private lastCallbackAt: number;
  readonly sampleTimeMs: number;
  readonly maximumGapMs: number;
  constructor(startAt: number, sampleTimeMs = 10, maximumGapMs = 5000) {
    if (![startAt, sampleTimeMs, maximumGapMs].every(Number.isFinite) || sampleTimeMs <= 0 || maximumGapMs < sampleTimeMs) throw new Error('Invalid synthetic timing contract');
    this.lastSampleAt = startAt;
    this.lastCallbackAt = startAt;
    this.sampleTimeMs = sampleTimeMs;
    this.maximumGapMs = maximumGapMs;
  }
  take(now: number): { samples: number; gapMs: number; unsupportedGap: boolean } {
    if (!Number.isFinite(now) || now < this.lastCallbackAt) throw new Error('Synthetic monotonic callback clock moved backwards');
    const gapMs = now - this.lastCallbackAt;
    this.lastCallbackAt = now;
    if (gapMs > this.maximumGapMs) {
      this.lastSampleAt = now;
      return { samples: 0, gapMs, unsupportedGap: true };
    }
    const samples = Math.floor((now - this.lastSampleAt) / this.sampleTimeMs);
    this.lastSampleAt += samples * this.sampleTimeMs;
    return { samples, gapMs, unsupportedGap: false };
  }
}
