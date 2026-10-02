import type { RecordingReplaySample } from './replay-decoder';

export interface ReplayChannelSummary {
  channel: string;
  count: number;
}

/** Return finite, named channels without touching the live ChannelStore. */
export function summarizeReplayChannels(
  samples: readonly RecordingReplaySample[],
): ReplayChannelSummary[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    if (!sample || typeof sample.channel !== 'string'
      || !Number.isFinite(sample.timeSeconds) || !Number.isFinite(sample.value)) continue;
    const channel = sample.channel.trim();
    if (!channel) continue;
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  return Array.from(counts, ([channel, count]) => ({ channel, count }))
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

/** Build the exact time/value arrays sent to the common analysis worker. */
export function selectReplayChannelSamples(
  samples: readonly RecordingReplaySample[],
  channel: string,
): { timestamps: number[]; values: number[] } {
  const selected = channel.trim();
  if (!selected) return { timestamps: [], values: [] };
  const timestamps: number[] = [];
  const values: number[] = [];
  for (const sample of samples) {
    if (!sample || typeof sample.channel !== 'string' || sample.channel.trim() !== selected
      || !Number.isFinite(sample.timeSeconds) || !Number.isFinite(sample.value)) continue;
    timestamps.push(sample.timeSeconds);
    values.push(sample.value);
  }
  return { timestamps, values };
}
