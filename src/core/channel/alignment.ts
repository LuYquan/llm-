import type { ChannelSnapshot } from './types';

export interface AlignedSnapshots {
  timestamps: Float64Array;
  values: Float64Array[];
}

/**
 * Align independent channels on the union of their real sample timestamps.
 * Missing observations stay NaN so plotting creates a gap instead of shifting a
 * channel by array position or inventing interpolated measurements.
 */
export function alignSnapshotsByTimestamp(snapshots: readonly ChannelSnapshot[]): AlignedSnapshots {
  const orderedSnapshots = snapshots.map((snapshot) => {
    let monotonic = true;
    for (let index = 0; index < snapshot.count; index++) {
      const timestamp = snapshot.timestamps[index];
      if (!Number.isFinite(timestamp) || (index > 0 && timestamp < snapshot.timestamps[index - 1])) {
        monotonic = false;
        break;
      }
    }
    if (monotonic) return snapshot;

    const points: { timestamp: number; value: number; index: number }[] = [];
    for (let index = 0; index < snapshot.count; index++) {
      const timestamp = snapshot.timestamps[index];
      if (Number.isFinite(timestamp)) points.push({ timestamp, value: snapshot.values[index], index });
    }
    points.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
    return {
      timestamps: Float64Array.from(points, (point) => point.timestamp),
      values: Float64Array.from(points, (point) => point.value),
      count: points.length,
    };
  });

  const total = orderedSnapshots.reduce((sum, snapshot) => sum + snapshot.count, 0);
  if (total === 0) {
    return { timestamps: new Float64Array(0), values: snapshots.map(() => new Float64Array(0)) };
  }

  const sorted = new Float64Array(total);
  let cursor = 0;
  for (const snapshot of orderedSnapshots) {
    for (let index = 0; index < snapshot.count; index++) {
      const timestamp = snapshot.timestamps[index];
      if (Number.isFinite(timestamp)) sorted[cursor++] = timestamp;
    }
  }
  sorted.subarray(0, cursor).sort();

  let uniqueCount = 0;
  for (let index = 0; index < cursor; index++) {
    const timestamp = sorted[index];
    if (uniqueCount === 0 || timestamp !== sorted[uniqueCount - 1]) {
      sorted[uniqueCount++] = timestamp;
    }
  }
  const timestamps = sorted.subarray(0, uniqueCount);

  const values = orderedSnapshots.map((snapshot) => {
    const aligned = new Float64Array(uniqueCount);
    aligned.fill(Number.NaN);
    let alignedIndex = 0;
    for (let index = 0; index < snapshot.count; index++) {
      const timestamp = snapshot.timestamps[index];
      if (!Number.isFinite(timestamp)) continue;
      while (alignedIndex < uniqueCount && timestamps[alignedIndex] < timestamp) alignedIndex++;
      if (alignedIndex < uniqueCount && timestamps[alignedIndex] === timestamp) {
        // Repeated timestamps within one channel keep the last received value.
        aligned[alignedIndex] = snapshot.values[index];
      }
    }
    return aligned;
  });

  return { timestamps, values };
}
