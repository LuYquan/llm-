import assert from 'node:assert/strict';
import { alignSnapshotsByTimestamp } from '../src/core/channel/alignment.ts';
import type { ChannelSnapshot } from '../src/core/channel/types.ts';

const snapshot = (timestamps: number[], values: number[]): ChannelSnapshot => ({
  timestamps: Float64Array.from(timestamps),
  values: Float64Array.from(values),
  count: timestamps.length,
});

export function runChannelAlignmentTests() {
  const result = alignSnapshotsByTimestamp([
    snapshot([1, 2, 3], [10, 20, 30]),
    snapshot([1.5, 3], [4, 5]),
  ]);

  assert.deepEqual(Array.from(result.timestamps), [1, 1.5, 2, 3]);
  assert.deepEqual(Array.from(result.values[0]), [10, Number.NaN, 20, 30]);
  assert.deepEqual(Array.from(result.values[1]), [Number.NaN, 4, Number.NaN, 5]);

  const repeated = alignSnapshotsByTimestamp([
    snapshot([2, 2, 1], [10, 11, 5]),
  ]);
  assert.deepEqual(Array.from(repeated.timestamps), [1, 2]);
  assert.deepEqual(Array.from(repeated.values[0]), [5, 11]);

  const empty = alignSnapshotsByTimestamp([]);
  assert.equal(empty.timestamps.length, 0);
  console.log('✓ 波形时间对齐保留错频/缺失点断口，不插值或按末尾索引拼接');
}
