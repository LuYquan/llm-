import assert from 'node:assert/strict';
import { evalPlantFreq } from '../src/core/control/computeBode';
import type { ControllerParams, FopdtModel } from '../src/core/control/types';
import { deriveScenarioPlant, getScenarioPhysicalFields, type ScenarioInnerLoopSource } from '../src/core/tuning/scenarios';

const plant: FopdtModel = { family: 'fopdt', k: 2, t: 0.3, tau: 0 };
const values = { inner_feedback_gain: 2, inner_derivative_filter_time: 0.01, angle_rate_unit_scale: 180 / Math.PI, delay: 0.02 };
const source = (params: ControllerParams = { kp: 1, ki: 2, kd: 0.03, tf: 0.01 }): ScenarioInnerLoopSource => ({ plant: { ...plant }, params, feedbackGain: values.inner_feedback_gain });
const derive = (inputs: Record<string, number | null> = values, inner?: ScenarioInnerLoopSource) => deriveScenarioPlant('flight-control', 'rate-attitude', 'attitude', inputs, inner);
const multiply = (a: [number, number], b: [number, number]): [number, number] => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const divide = (a: [number, number], b: [number, number]): [number, number] => { const norm = b[0] ** 2 + b[1] ** 2; return [(a[0] * b[0] + a[1] * b[1]) / norm, (a[1] * b[0] - a[0] * b[1]) / norm]; };

/** Direct complex P*C/(1+H*P*C) × scale/(jω) × exp(-jωτ). */
function directOuter(omega: number, inner: ScenarioInnerLoopSource): [number, number] {
  assert.equal(inner.plant.family, 'fopdt');
  const p = inner.plant as FopdtModel;
  const c = inner.params;
  const jwTf = omega * c.tf!;
  const derivative = c.kd ?? 0;
  const controller: [number, number] = [c.kp + derivative * omega ** 2 * c.tf! / (1 + jwTf ** 2), -(c.ki ?? 0) / omega + derivative * omega / (1 + jwTf ** 2)];
  const loop = multiply(divide([p.k, 0], [1, p.t * omega]), controller);
  const closed = divide(loop, [1 + inner.feedbackGain * loop[0], inner.feedbackGain * loop[1]]);
  return multiply(multiply(closed, [0, -values.angle_rate_unit_scale / omega]), [Math.cos(omega * values.delay), -Math.sin(omega * values.delay)]);
}

export function runScenarioCascadeModelTests(): void {
  const fields = getScenarioPhysicalFields('flight-control', 'attitude');
  assert.deepEqual(fields.map(field => field.id), ['inner_feedback_gain', 'inner_derivative_filter_time', 'angle_rate_unit_scale', 'delay']);
  assert.ok(fields.every(field => field.required), 'feedback gain, derivative filter and unit scale require explicit inputs');
  assert.equal(derive({ inner_bandwidth: 20, delay: 0 }).status, 'needs-input', 'bandwidth alone never supplies a closed-loop model');
  const missingSource = derive();
  assert.equal(missingSource.status, 'needs-input');
  assert.equal(missingSource.model, null);
  assert.ok(missingSource.pendingInputs.some(item => item.includes('来源')));

  const p = derive({ ...values, inner_derivative_filter_time: 0, delay: 0 }, source({ kp: 4, ki: 0, kd: 0, tf: 0 }));
  assert.equal(p.status, 'ready', p.warnings.join(' '));
  assert.deepEqual(p.model!.numerator, [8 * values.angle_rate_unit_scale]);
  assert.deepEqual(p.model!.denominator, [0.3, 17, 0], 'complete inner feedback denominator retains explicitly non-unity gain');
  assert.ok(p.assumptions.some(item => item.includes('连续名义模型')));
  assert.ok(p.assumptions.some(item => item.includes('微分作用于误差')));

  for (const controller of [
    { kp: 1, ki: 0, kd: 0, tf: 0.01 },
    { kp: 1, ki: 2, kd: 0, tf: 0.01 },
    { kp: 1, ki: 0, kd: 0.03, tf: 0.01 },
    { kp: 1, ki: 2, kd: 0.03, tf: 0.01 },
  ]) {
    const inner = source(controller);
    const actual = derive(values, inner);
    assert.equal(actual.status, 'ready', actual.warnings.join(' '));
    assert.equal(actual.model!.tau, values.delay, 'only the explicit external cascade delay is attached to the result');
    for (const omega of [0.01, 0.1, 1, 10, 100, 1000]) {
      const expected = directOuter(omega, inner);
      const frequency = evalPlantFreq(actual.model!, omega);
      const got = [frequency.mag * Math.cos(frequency.phaseRad), frequency.mag * Math.sin(frequency.phaseRad)];
      const tolerance = 1e-10 * Math.max(1, Math.hypot(...expected));
      assert.ok(Math.abs(got[0] - expected[0]) <= tolerance && Math.abs(got[1] - expected[1]) <= tolerance, `direct feedback matches at ${omega} rad/s for ${JSON.stringify(controller)}`);
    }
  }

  const reverse = derive({ ...values, inner_derivative_filter_time: 0, angle_rate_unit_scale: -2, delay: 0 }, { plant: { ...plant, k: -2 }, params: { kp: -4, ki: 0, kd: 0, tf: 0 }, feedbackGain: 2 });
  assert.equal(reverse.status, 'ready', reverse.warnings.join(' '));
  assert.deepEqual(reverse.model!.numerator, [-16], 'signed controller, plant and external coordinate scale are retained');
  assert.deepEqual(reverse.model!.denominator, [0.3, 17, 0]);

  for (const key of Object.keys(values)) {
    assert.equal(derive({ ...values, [key]: null }, source()).status, 'needs-input', key);
    assert.equal(derive({ ...values, [key]: NaN }, source()).status, 'unsupported', key);
  }
  for (const bad of [{ inner_feedback_gain: 0 }, { angle_rate_unit_scale: 0 }, { inner_derivative_filter_time: -1 }, { delay: -1 }]) {
    assert.equal(derive({ ...values, ...bad }, source()).status, 'unsupported');
  }
  assert.equal(derive(values, source({ kp: 1, ki: 0, kd: 0 })).status, 'needs-input', 'omitted Tf is not silently treated as zero');
  assert.equal(derive(values, { ...source(), feedbackGain: 1 }).status, 'unsupported', 'source feedback gain must match explicit input');
  assert.equal(derive(values, source({ kp: 1, ki: 2, kd: 0.03, tf: 0.02 })).status, 'unsupported', 'source derivative filter must match explicit input');

  const delayed = derive(values, { ...source(), plant: { ...plant, tau: 0.005 } });
  assert.equal(delayed.status, 'unsupported');
  assert.equal(delayed.model, null);
  assert.ok(delayed.warnings.some(item => item.includes('内环反馈中含纯滞后')));
  assert.ok(delayed.warnings.some(item => item.includes('外环等效')));
  assert.equal(derive(values, source({ kp: -4, ki: 0, kd: 0, tf: 0.01 })).status, 'unsupported', 'unstable inner characteristic polynomial is refused');
  assert.deepEqual(derive({ ...values, inner_bandwidth: 0.00001 }, source()).model, derive(values, source()).model, 'legacy bandwidth input cannot alter the complete model');
  const frozen = source();
  Object.freeze(frozen.plant); Object.freeze(frozen.params); Object.freeze(frozen);
  assert.equal(derive(Object.freeze({ ...values }), frozen).status, 'ready', 'model derivation does not mutate its source or physical inputs');

  const velocity = deriveScenarioPlant('balance-car', 'upright-velocity', 'velocity', { speed_gain: 2, speed_time: 0.4, delay: 0.02 });
  assert.equal(velocity.status, 'ready');
  assert.deepEqual(velocity.model, { family: 'transfer_function', numerator: [2], denominator: [0.4, 1], tau: 0.02 }, 'balance speed remains a user-provided equivalent measured model');
  console.log('✓ 飞控串级物理模型：完整内环、显式单位/反馈/滤波、延迟边界与来源一致性测试通过。');
}

runScenarioCascadeModelTests();
