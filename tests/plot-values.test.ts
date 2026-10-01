import assert from 'node:assert/strict';
import type uPlot from 'uplot';
import { toUPlotValues, transformPlotValues } from '../src/core/channel/plotValues';

export function runPlotValuesTests(): void {
  let checked = 0;
  const check = (run: () => void) => { run(); checked++; };
  check(() => {
    const finite = Float64Array.of(1, 2, 0, -1, -0);
    assert.equal(toUPlotValues(finite), finite, 'Finite buffers use the zero-copy path');
    assert.equal(Object.is(toUPlotValues(finite)[4], -0), true);
  });
  check(() => {
    const finite = Object.freeze([1, 2, 0]);
    assert.equal(toUPlotValues(finite), finite);
    assert.deepEqual(finite, [1, 2, 0]);
  });
  check(() => {
    const values = Float64Array.of(1, NaN, 0, Infinity, -Infinity, 2, -0);
    const before = new Uint8Array(values.buffer.slice(0));
    const plotted = toUPlotValues(values);
    assert.deepEqual(plotted, [1, null, 0, null, null, 2, -0]);
    assert.equal(plotted.length, values.length);
    assert.notEqual(plotted, values);
    assert.deepEqual(new Uint8Array(values.buffer), before, 'Raw bytes remain unchanged');
    assert.equal(Number.isNaN(values[1]), true);
    assert.equal(values[3], Infinity);
  });
  check(() => {
    const values = Object.freeze([NaN, Infinity, -Infinity]);
    assert.deepEqual(toUPlotValues(values), [null, null, null], 'All missing points remain gaps, never fake zero');
    assert.equal(Number.isNaN(values[0]), true);
    assert.equal(values[1], Infinity);
  });
  check(() => {
    const raw = Float64Array.of(1, 2, 0);
    const transformed = Float64Array.from(raw, value => value * Number.MAX_VALUE);
    const timestamps = Float64Array.of(1, 1.01, 1.02);
    const beforeRaw = raw.slice();
    const beforeTimes = timestamps.slice();
    const result: uPlot.AlignedData = [timestamps, toUPlotValues(transformed)];
    assert.equal(result[0], timestamps);
    assert.deepEqual(result[1], [Number.MAX_VALUE, null, 0]);
    assert.equal(result[0].length, result[1].length, 'Plot gaps preserve the exact point indices/time range');
    assert.deepEqual(timestamps, beforeTimes);
    assert.deepEqual(raw, beforeRaw);
    assert.equal(transformed[1], Infinity);
  });
  check(() => {
    const timestamps = Float64Array.of(1, 1.01);
    const actual = Float64Array.of(1, 2);
    const speed = Float64Array.of(3, 4);
    const pending = Float64Array.of(NaN, NaN);
    const data: uPlot.AlignedData = [timestamps, toUPlotValues(actual), toUPlotValues(speed), toUPlotValues(pending)];
    assert.equal(data[1], actual);
    assert.equal(data[2], speed);
    assert.deepEqual(data[3], [null, null]);
    assert.equal(data.length, 4, 'Waiting series is retained in the plot contract');
    assert.equal(pending.every(Number.isNaN), true);
  });
  check(() => {
    const empty = new Float64Array(0);
    assert.equal(toUPlotValues(empty), empty);
    const float32 = Float32Array.of(1, 0, NaN);
    assert.deepEqual(toUPlotValues(float32), [1, 0, null]);
  });
  check(() => {
    const raw = Float64Array.of(1, 0, -0, NaN, Infinity);
    assert.equal(transformPlotValues(raw), raw, 'Missing fields use the identity transform without allocation');
    assert.equal(transformPlotValues(raw, undefined, undefined), raw);
    assert.equal(transformPlotValues(raw, 1, 0), raw);
  });
  for (const field of ['scale', 'offset'] as const) {
    for (const invalid of [null, '', '0', '1', false, true, NaN, Infinity, -Infinity]) {
      check(() => {
        const raw = Float64Array.of(1, 0, 2);
        const before = new Uint8Array(raw.buffer.slice(0));
        const transformed = transformPlotValues(raw, field === 'scale' ? invalid : 1, field === 'offset' ? invalid : 0);
        assert.equal(transformed.length, raw.length);
        assert.equal(transformed.every(Number.isNaN), true, `Invalid ${field} must never coerce into a finite reading`);
        assert.deepEqual(toUPlotValues(transformed), [null, null, null]);
        assert.deepEqual(new Uint8Array(raw.buffer), before);
      });
    }
  }
  check(() => {
    const raw = Float64Array.of(1, 2, 0);
    assert.deepEqual(transformPlotValues(raw, undefined, 5), Float64Array.of(6, 7, 5));
    assert.deepEqual(transformPlotValues(raw, 2, undefined), Float64Array.of(2, 4, 0));
    assert.deepEqual(raw, Float64Array.of(1, 2, 0));
  });
  check(() => {
    const raw = Float64Array.of(1, 2, 0, NaN, Infinity);
    const before = new Uint8Array(raw.buffer.slice(0));
    const transformed = transformPlotValues(raw, 0, 0);
    assert.deepEqual(toUPlotValues(transformed), [0, 0, 0, null, null], 'A genuine numeric zero multiplier is allowed, but invalid samples stay missing');
    assert.deepEqual(new Uint8Array(raw.buffer), before);
  });
  check(() => {
    const raw = Float64Array.of(1, 2, 0);
    const before = new Uint8Array(raw.buffer.slice(0));
    const transformed = transformPlotValues(raw, Number.MAX_VALUE, 0);
    assert.equal(transformed[1], Infinity, 'Transform overflow remains nonfinite until the final renderer boundary');
    assert.deepEqual(toUPlotValues(transformed), [Number.MAX_VALUE, null, 0]);
    assert.deepEqual(new Uint8Array(raw.buffer), before);
  });
  console.log(`Plot display gaps: ${checked} behavior checks passed; raw/analysis arrays unchanged.`);
}
