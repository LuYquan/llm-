import assert from 'node:assert/strict';
import { alignTelemetrySnapshots } from '../src/core/tuning/alignTelemetry.ts';
import type { AlignedTelemetry, TelemetryAlignmentSnapshot } from '../src/core/tuning/alignTelemetry';

let cases = 0;
function check(name: string, verify: () => void) { verify(); cases++; console.log('  tuning alignment: ' + name); }
const snapshot = (timestamps: number[], values = timestamps.map(value => value * 2)): TelemetryAlignmentSnapshot => ({ timestamps: Float64Array.from(timestamps), values: Float64Array.from(values), count: timestamps.length });
const noPoints: AlignedTelemetry = { setpoints: [], responses: [], outputs: [] };

/** Original loop, used only as a small-sample independent regression oracle. */
function naive(setpoint: TelemetryAlignmentSnapshot, feedback: TelemetryAlignmentSnapshot, output: TelemetryAlignmentSnapshot, afterTimestamp: number, maximumGap: number): AlignedTelemetry {
  const result: AlignedTelemetry = { setpoints: [], responses: [], outputs: [] };
  function nearest(source: TelemetryAlignmentSnapshot, time: number): number {
    let best = -1, gap = Infinity;
    for (let index = 0; index < source.count; index++) {
      const distance = Math.abs(source.timestamps[index] - time);
      if (distance < gap) { gap = distance; best = index; }
    }
    return best >= 0 && gap <= maximumGap ? source.values[best] : NaN;
  }
  for (let index = 0; index < feedback.count; index++) {
    const time = feedback.timestamps[index];
    if (time <= afterTimestamp) continue;
    const target = nearest(setpoint, time), actuator = nearest(output, time), response = feedback.values[index];
    if (Number.isFinite(target) && Number.isFinite(actuator) && Number.isFinite(response)) {
      result.setpoints.push(target); result.responses.push(response); result.outputs.push(actuator);
    }
  }
  return result;
}

check('sorted exact samples follow feedback order and exclude the start boundary', () => {
  const source = snapshot([0, 1, 2, 3]);
  assert.deepEqual(alignTelemetrySnapshots(source, source, source, { afterTimestamp: 1, maximumGap: 0 }), { setpoints: [4, 6], responses: [4, 6], outputs: [4, 6] });
});

check('unsorted sources and feedback match the original nearest-neighbour loop', () => {
  const setpoint = snapshot([4, 0, 2, 1], [40, 0, 20, 10]);
  const feedback = snapshot([3, 1.1, 0.1, 2], [30, 11, 1, 20]);
  const output = snapshot([2.1, 0, 4, 1], [21, 0, 40, 10]);
  assert.deepEqual(alignTelemetrySnapshots(setpoint, feedback, output, { afterTimestamp: 0, maximumGap: 1 }), naive(setpoint, feedback, output, 0, 1));
});

check('equal-distance neighbours choose earliest source index rather than lower timestamp', () => {
  const feedback = snapshot([2], [99]);
  assert.deepEqual(alignTelemetrySnapshots(snapshot([3, 1], [30, 10]), feedback, snapshot([1, 3], [10, 30]), { afterTimestamp: 0, maximumGap: 1 }), { setpoints: [30], responses: [99], outputs: [10] });
});

check('duplicate timestamp picks original earliest index for each source', () => {
  const source = snapshot([3, 1, 1, 0, 3], [30, 11, 12, 0, 31]);
  const feedback = snapshot([1, 3], [7, 8]);
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: 0, maximumGap: 0 }), { setpoints: [11, 30], responses: [7, 8], outputs: [11, 30] });
});

check('earliest duplicate or equal-distance NaN value rejects without choosing another value', () => {
  const feedback = snapshot([2], [5]), good = snapshot([2], [10]);
  for (const source of [snapshot([2, 2], [NaN, 10]), snapshot([3, 1], [NaN, 10])]) {
    assert.deepEqual(alignTelemetrySnapshots(source, feedback, good, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
    assert.deepEqual(alignTelemetrySnapshots(good, feedback, source, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
  }
});

check('nearest non-finite value rejects even when farther value is finite', () => {
  const feedback = snapshot([2], [5]), good = snapshot([2], [10]);
  assert.deepEqual(alignTelemetrySnapshots(snapshot([2, 2.1], [Infinity, 10]), feedback, good, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
});

check('non-finite timestamps are excluded but do not rearrange valid original tie indices', () => {
  const setpoint = snapshot([NaN, 3, -Infinity, 1, Infinity], [1, 30, 2, 10, 3]);
  const feedback = snapshot([NaN, 2, Infinity, 1, -Infinity], [1, 22, 2, 11, 3]);
  const output = snapshot([NaN, 1, 3, Infinity], [0, 10, 30, 0]);
  const result = alignTelemetrySnapshots(setpoint, feedback, output, { afterTimestamp: 0, maximumGap: 1 });
  assert.deepEqual(result, naive(setpoint, feedback, output, 0, 1));
  assert.deepEqual(result, { setpoints: [30, 10], responses: [22, 11], outputs: [10, 10] });
});

check('maximum gap boundary is inclusive and zero permits only exact timestamps', () => {
  const source = snapshot([1], [9]), feedback = snapshot([2], [7]);
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: 0, maximumGap: 1 }), { setpoints: [9], responses: [7], outputs: [9] });
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: 0, maximumGap: 1 - Number.EPSILON }), noPoints);
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: 0, maximumGap: 0 }), noPoints);
});

check('count bounds exclude unused tail slots and inputs remain unchanged', () => {
  const source = snapshot([3, 1, 2], [30, 10, 20]);
  source.count = 2;
  const feedback = snapshot([2], [99]);
  const originalTimes = source.timestamps.slice(), originalValues = source.values.slice();
  const result = alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: 0, maximumGap: 1 });
  assert.deepEqual(result.setpoints, [30]);
  assert.deepEqual(source.timestamps, originalTimes);
  assert.deepEqual(source.values, originalValues);
  assert.equal(source.count, 2);
});

check('empty and wholly invalid sources cannot create partial aligned evidence', () => {
  const valid = snapshot([1], [2]);
  for (const source of [snapshot([]), snapshot([NaN, Infinity])]) {
    assert.deepEqual(alignTelemetrySnapshots(source, valid, valid, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
    assert.deepEqual(alignTelemetrySnapshots(valid, valid, source, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
  }
  assert.deepEqual(alignTelemetrySnapshots(valid, snapshot([]), valid, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
});

check('malformed or oversized counts and array capacities return empty arrays', () => {
  const valid = snapshot([1, 2], [2, 4]);
  const invalids: TelemetryAlignmentSnapshot[] = [-1, 0.5, NaN, Infinity, 3, 50_001].map(count => ({ ...valid, count }));
  invalids.push({ ...valid, values: new Float64Array(1) });
  invalids.push({ ...valid, timestamps: new Float64Array(50_001) });
  invalids.push({ ...valid, values: new Float64Array(50_001) });
  invalids.push({ ...valid, timestamps: [1, 2] as unknown as Float64Array });
  invalids.push(null as unknown as TelemetryAlignmentSnapshot);
  for (const invalid of invalids) {
    assert.deepEqual(alignTelemetrySnapshots(invalid, valid, valid, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
    assert.deepEqual(alignTelemetrySnapshots(valid, invalid, valid, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
    assert.deepEqual(alignTelemetrySnapshots(valid, valid, invalid, { afterTimestamp: 0, maximumGap: 1 }), noPoints);
  }
});

check('invalid options return empty while zero gap remains valid', () => {
  const valid = snapshot([1], [2]);
  for (const maximumGap of [-1, NaN, Infinity, -Infinity]) assert.deepEqual(alignTelemetrySnapshots(valid, valid, valid, { afterTimestamp: 0, maximumGap }), noPoints);
  for (const afterTimestamp of [NaN, Infinity, -Infinity]) assert.deepEqual(alignTelemetrySnapshots(valid, valid, valid, { afterTimestamp, maximumGap: 0 }), noPoints);
  assert.deepEqual(alignTelemetrySnapshots(valid, valid, valid, undefined as never), noPoints);
  assert.deepEqual(alignTelemetrySnapshots(valid, valid, valid, { afterTimestamp: 0, maximumGap: 0 }), { setpoints: [2], responses: [2], outputs: [2] });
});

check('distance overflow and signed-zero timestamp duplicates match the original loop', () => {
  const source = snapshot([Number.MAX_VALUE, -Number.MAX_VALUE], [1, 2]);
  const feedback = snapshot([-Number.MAX_VALUE], [5]);
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: -Number.MAX_VALUE, maximumGap: Number.MAX_VALUE }), noPoints);
  const zero = snapshot([-0, 0, 1], [4, 5, 6]), atZero = snapshot([0], [9]);
  assert.deepEqual(alignTelemetrySnapshots(zero, atZero, zero, { afterTimestamp: -1, maximumGap: 0 }), { setpoints: [4], responses: [9], outputs: [4] });
});

check('rounded equal distances across many different timestamps preserve earliest original index', () => {
  const feedback = snapshot([1e20], [99]);
  const source = snapshot([1, 4, 2, 3], [10, 40, 20, 30]);
  const options = { afterTimestamp: 0, maximumGap: 1e20 };
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, options), naive(source, feedback, source, options.afterTimestamp, options.maximumGap));
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, options), { setpoints: [10], responses: [99], outputs: [10] });
  source.values[0] = NaN;
  assert.deepEqual(alignTelemetrySnapshots(source, feedback, source, options), noPoints);
  const negativeFeedback = snapshot([-1e20], [99]);
  const negativeOptions = { afterTimestamp: -1e21, maximumGap: 1e20 };
  const reverseSource = snapshot([3, 2, 4, 1], [30, 20, 40, 10]);
  assert.deepEqual(alignTelemetrySnapshots(reverseSource, negativeFeedback, reverseSource, negativeOptions), naive(reverseSource, negativeFeedback, reverseSource, negativeOptions.afterTimestamp, negativeOptions.maximumGap));
});

check('deterministic mixed small arrays match the naive oracle across gaps and windows', () => {
  let random = 0x12345678;
  const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
  const special = [NaN, Infinity, -Infinity];
  function generated(): TelemetryAlignmentSnapshot {
    const length = next() % 16;
    const timestamps = Array.from({ length }, () => next() % 8 === 0 ? special[next() % special.length] : (next() % 12) / 2 - 2);
    const values = Array.from({ length }, () => next() % 9 === 0 ? special[next() % special.length] : next() % 100);
    return snapshot(timestamps, values);
  }
  for (let index = 0; index < 300; index++) {
    const setpoint = generated(), feedback = generated(), output = generated();
    for (const maximumGap of [0, 0.25, 0.5, 2, 10]) {
      const afterTimestamp = index % 5 - 2;
      assert.deepEqual(alignTelemetrySnapshots(setpoint, feedback, output, { afterTimestamp, maximumGap }), naive(setpoint, feedback, output, afterTimestamp, maximumGap));
    }
  }
});

check('mixed extreme finite timestamps and distance overflow match the naive oracle', () => {
  const times = [-Number.MAX_VALUE, -1e308, -1e20, -3, -1e-200, -0, 0, 1e-200, 1, 2, 3, 1e20, 1e308, Number.MAX_VALUE, NaN];
  for (let offset = 0; offset < times.length; offset++) {
    const source = snapshot(times.map((_, index) => times[(index * 7 + offset) % times.length]), times.map((_, index) => index % 5 ? index : NaN));
    const feedback = snapshot(times, times.map((_, index) => index + 1));
    const output = snapshot([...times].reverse(), times.map((_, index) => index % 7 ? -index : Infinity));
    for (const maximumGap of [0, 1e-200, 1, 1e20, Number.MAX_VALUE]) {
      const options = { afterTimestamp: -Number.MAX_VALUE, maximumGap };
      assert.deepEqual(alignTelemetrySnapshots(source, feedback, output, options), naive(source, feedback, output, options.afterTimestamp, maximumGap));
    }
  }
});

check('50000 unsorted samples align without mutating inputs or using a timing assertion', () => {
  const count = 50_000;
  const source = { timestamps: new Float64Array(count), values: new Float64Array(count), count };
  const feedback = { timestamps: new Float64Array(count), values: new Float64Array(count), count };
  for (let index = 0; index < count; index++) {
    // 3571 is coprime with 50000; every timestamp occurs once in unsorted order.
    const time = (index * 3571) % count + 1;
    source.timestamps[index] = time; source.values[index] = time * 3;
    feedback.timestamps[index] = count - index; feedback.values[index] = index + 1;
  }
  const result = alignTelemetrySnapshots(source, feedback, source, { afterTimestamp: 0, maximumGap: 0 });
  assert.equal(result.responses.length, count);
  for (let index = 0; index < count; index++) {
    assert.equal(result.setpoints[index], (count - index) * 3);
    assert.equal(result.outputs[index], result.setpoints[index]);
    assert.equal(result.responses[index], index + 1);
    assert.equal(source.timestamps[index], (index * 3571) % count + 1);
    assert.equal(source.values[index], source.timestamps[index] * 3);
  }
});

console.log('Tuning alignment regression: ' + cases + ' cases passed.');
