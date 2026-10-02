import type { RecordingReplaySample } from './replay-decoder';

export interface ReplayChartPoint {
  timeSeconds: number;
  value: number;
}

export interface ReplayChartSeries {
  channel: string;
  points: ReplayChartPoint[];
}

/**
 * Build an isolated, read-only replay view. The live ChannelStore is never
 * touched; each channel keeps its own timestamps and missing samples remain
 * absent from that series. Long recordings are reduced per bucket while
 * preserving the local minimum and maximum so narrow spikes remain visible.
 */
export function buildReplayChartSeries(
  samples: readonly RecordingReplaySample[],
  maxPointsPerChannel = 1200
): ReplayChartSeries[] {
  const limit = Math.max(8, Math.floor(maxPointsPerChannel));
  const grouped = new Map<string, ReplayChartPoint[]>();

  for (const sample of samples) {
    if (!sample || typeof sample.channel !== 'string') continue;
    if (!Number.isFinite(sample.timeSeconds) || !Number.isFinite(sample.value)) continue;
    const channel = sample.channel.trim() || '未命名通道';
    const points = grouped.get(channel) ?? [];
    points.push({ timeSeconds: sample.timeSeconds, value: sample.value });
    grouped.set(channel, points);
  }

  return Array.from(grouped, ([channel, points]) => {
    points.sort((a, b) => a.timeSeconds - b.timeSeconds);
    return { channel, points: decimateReplaySeries(points, limit) };
  }).sort((a, b) => a.channel.localeCompare(b.channel));
}

function decimateReplaySeries(points: ReplayChartPoint[], limit: number): ReplayChartPoint[] {
  if (points.length <= limit) return points;
  const bucketSize = Math.ceil(points.length / limit);
  const output: ReplayChartPoint[] = [];

  for (let start = 0; start < points.length; start += bucketSize) {
    const bucket = points.slice(start, Math.min(points.length, start + bucketSize));
    if (bucket.length === 0) continue;
    output.push(bucket[0]);
    if (bucket.length > 2) {
      let min = bucket[1];
      let max = bucket[1];
      for (let index = 2; index < bucket.length; index++) {
        const point = bucket[index];
        if (point.value < min.value) min = point;
        if (point.value > max.value) max = point;
      }
      if (min !== max) {
        if (min.timeSeconds <= max.timeSeconds) output.push(min, max);
        else output.push(max, min);
      } else {
        output.push(min);
      }
    } else if (bucket.length === 2) {
      output.push(bucket[1]);
    }
  }

  return output.slice(0, Math.max(limit * 2, limit));
}

