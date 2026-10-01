import assert from 'node:assert/strict';
import { SyntheticTelemetryClock } from './browser/synthetic-telemetry-clock.ts';

const syntheticClock = new SyntheticTelemetryClock(0, 10, 5000);
assert.equal(syntheticClock.take(9).samples, 0, 'fractional browser delays do not invent early samples');
assert.equal(syntheticClock.take(109).samples, 10, '100ms pump delivers ten 10ms synthetic samples');
assert.equal(syntheticClock.take(1109).samples, 100, 'one-second background callback delivers a bounded buffered sample batch');
assert.equal(syntheticClock.take(1110).samples, 1, 'fractional sample remainder survives delayed delivery');
assert.equal(syntheticClock.take(6110).samples, 500, 'the explicit five-second synthetic gap is bounded');
assert.deepEqual(syntheticClock.take(11111), { samples: 0, gapMs: 5001, unsupportedGap: true }, 'larger browser stalls cannot be hidden by synthetic catchup');
assert.throws(() => syntheticClock.take(11110), /backwards/);

console.log('Synthetic telemetry clock: 7 behavior checks passed (100ms buffered pump, bounded 5s gap, no unsupported catchup).');
