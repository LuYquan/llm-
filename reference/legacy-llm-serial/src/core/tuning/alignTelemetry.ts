export interface TelemetryAlignmentSnapshot {
  timestamps: Float64Array;
  values: Float64Array;
  count: number;
}

export interface TelemetryAlignmentOptions {
  afterTimestamp: number;
  maximumGap: number;
}

export interface AlignedTelemetry {
  setpoints: number[];
  responses: number[];
  outputs: number[];
}

const MAX_SAMPLES = 50_000;
type TimestampIndex = { time: number; index: number };
type OrderedTimestampIndex = { entries: TimestampIndex[]; minimumIndex: Int32Array; treeBase: number };
const empty = (): AlignedTelemetry => ({ setpoints: [], responses: [], outputs: [] });

function validSnapshot(value: TelemetryAlignmentSnapshot): boolean {
  return Boolean(value && value.timestamps instanceof Float64Array && value.values instanceof Float64Array
    && value.timestamps.length <= MAX_SAMPLES && value.values.length <= MAX_SAMPLES
    && Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= MAX_SAMPLES
    && value.count <= value.timestamps.length && value.count <= value.values.length);
}

/** Duplicate timestamps retain the earliest original index, including NaN values. */
function sortedTimestampIndex(snapshot: TelemetryAlignmentSnapshot): OrderedTimestampIndex {
  const entries: TimestampIndex[] = [];
  for (let index = 0; index < snapshot.count; index++) {
    const time = snapshot.timestamps[index];
    if (Number.isFinite(time)) entries.push({ time, index });
  }
  entries.sort((left, right) => left.time === right.time ? left.index - right.index : left.time < right.time ? -1 : 1);
  const unique: TimestampIndex[] = [];
  for (const entry of entries) {
    if (!unique.length || unique[unique.length - 1].time !== entry.time) unique.push(entry);
  }
  let treeBase = 1;
  while (treeBase < unique.length) treeBase *= 2;
  const minimumIndex = new Int32Array(treeBase * 2);
  minimumIndex.fill(MAX_SAMPLES);
  unique.forEach((entry, index) => { minimumIndex[treeBase + index] = entry.index; });
  for (let index = treeBase - 1; index > 0; index--) minimumIndex[index] = Math.min(minimumIndex[index * 2], minimumIndex[index * 2 + 1]);
  return { entries: unique, minimumIndex, treeBase };
}

/** Range minimum keeps the original tie rule even for rounded equal distances. */
function earliestOriginalIndex(ordered: OrderedTimestampIndex, from: number, to: number): number {
  let left = from + ordered.treeBase, right = to + ordered.treeBase, earliest = MAX_SAMPLES;
  while (left < right) {
    if (left % 2 === 1) { earliest = Math.min(earliest, ordered.minimumIndex[left]); left++; }
    if (right % 2 === 1) { right--; earliest = Math.min(earliest, ordered.minimumIndex[right]); }
    left = Math.floor(left / 2); right = Math.floor(right / 2);
  }
  return earliest;
}

function nearestValue(source: TelemetryAlignmentSnapshot, ordered: OrderedTimestampIndex, time: number, maximumGap: number): number {
  const entries = ordered.entries;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle].time < time) low = middle + 1;
    else high = middle;
  }
  const split = low;
  const left = entries[split - 1];
  const right = entries[split];
  const leftGap = left ? Math.abs(left.time - time) : Infinity;
  const rightGap = right ? Math.abs(right.time - time) : Infinity;
  const gap = Math.min(leftGap, rightGap);
  if (!Number.isFinite(gap) || gap > maximumGap) return NaN;
  // On each side distances are monotone. IEEE subtraction can round several
  // different times to the same distance, so the tie may span more than two
  // neighbours. Find the complete equal-distance interval in logarithmic time.
  low = 0; high = split;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (Math.abs(entries[middle].time - time) <= gap) high = middle;
    else low = middle + 1;
  }
  const from = low;
  low = split; high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (Math.abs(entries[middle].time - time) <= gap) low = middle + 1;
    else high = middle;
  }
  const originalIndex = earliestOriginalIndex(ordered, from, low);
  return originalIndex < source.count ? source.values[originalIndex] : NaN;
}

/**
 * Align around feedback timestamps with the original nearest-neighbour policy.
 * Source sorting is local; output order follows the original feedback array.
 * Equal distances pick the earliest source index even when its value is NaN.
 * Malformed snapshots/options return empty arrays, never partial evidence.
 * Sorting plus logarithmic nearest/tie queries costs O(n log n).
 */
export function alignTelemetrySnapshots(
  setpoint: TelemetryAlignmentSnapshot,
  feedback: TelemetryAlignmentSnapshot,
  output: TelemetryAlignmentSnapshot,
  options: TelemetryAlignmentOptions,
): AlignedTelemetry {
  if (!validSnapshot(setpoint) || !validSnapshot(feedback) || !validSnapshot(output)
    || !options || !Number.isFinite(options.afterTimestamp) || !Number.isFinite(options.maximumGap) || options.maximumGap < 0) return empty();
  const result = empty();
  const setpointIndex = sortedTimestampIndex(setpoint);
  const outputIndex = sortedTimestampIndex(output);
  if (!setpointIndex.entries.length || !outputIndex.entries.length) return result;
  for (let index = 0; index < feedback.count; index++) {
    const time = feedback.timestamps[index];
    const response = feedback.values[index];
    if (!Number.isFinite(time) || time <= options.afterTimestamp || !Number.isFinite(response)) continue;
    const target = nearestValue(setpoint, setpointIndex, time, options.maximumGap);
    const actuator = nearestValue(output, outputIndex, time, options.maximumGap);
    if (Number.isFinite(target) && Number.isFinite(actuator)) {
      result.setpoints.push(target);
      result.responses.push(response);
      result.outputs.push(actuator);
    }
  }
  return result;
}
