import assert from 'node:assert/strict';
import { evaluateResponse, importCapabilityPlan, packagePlan, validateCapabilityPackage, validatePlan } from '../src/core/tuning/engine';
import type { TuningCapabilityPackage, TuningGoal, TuningPlan } from '../src/core/tuning/types';
import { cascadeStageConfigurationSignature } from '../src/core/tuning/cascadeDependencies';
import { validateFeedbackObservation } from '../src/services/tuningAgent';

export function runStepResponseTests(plan: TuningPlan): void {
  let checked = 0;
  const test = (name: string, check: () => void) => { check(); checked++; console.log('  step response: ' + name); };
  const goal: TuningGoal = { ...plan.goal, mode: 'step-response', maximumSteadyError: .1, maximumOvershootPct: 5, stepSetpointTolerance: 0 };
  const step = [...Array(5).fill(0), ...Array(7).fill(1)];
  const evaluate = (reference: number[], response = reference, target: TuningGoal = goal, outputs = Array(reference.length).fill(1)) => evaluateResponse(reference, response, outputs, target, 5);
  const invalid = (reference: number[], response = reference, target: TuningGoal = goal) => {
    const result = evaluate(reference, response, target);
    assert.equal(result.passed, false);
    assert.equal(result.metrics, null, 'ambiguous step data cannot become AI metrics or a verified trial');
    assert.ok(result.message.trim());
  };
  test('one rising step is measured', () => { const result = evaluate(step); assert.equal(result.passed, true); assert.equal(result.metrics?.overshootPercent, 0); });
  test('zero permitted overshoot is a valid strict target', () => { const zero = { ...goal, maximumOvershootPct: 0 }; assert.equal(evaluate(step, step, zero).passed, true); assert.ok(validatePlan({ ...plan, goal: zero }).every(error => !error.includes('阶跃目标需要'))); });
  test('zero permitted overshoot rejects any measured excess', () => { assert.equal(evaluate(step, [...Array(5).fill(0), 1.001, ...Array(6).fill(1)], { ...goal, maximumOvershootPct: 0 }).passed, false); });
  test('one falling step uses the falling direction', () => { const reference = step.map(value => 1 - value); const response = [...Array(5).fill(1), -.04, ...Array(6).fill(0)]; const result = evaluate(reference, response); assert.equal(result.passed, true); assert.ok(Math.abs(result.metrics!.overshootPercent! - 4) < 1e-10); });
  test('negative offset does not change the step meaning', () => { assert.equal(evaluate(step.map(value => value - 3)).passed, true); });
  test('multiple target reversals cannot pass as one step', () => { invalid([...Array(5).fill(0), 1, 0, 1, 0, ...Array(5).fill(1)]); });
  test('a third target level cannot pass', () => { invalid([...Array(5).fill(0), 2, ...Array(5).fill(1)]); });
  test('a ramp cannot pass as a sampled step', () => { invalid([...Array(5).fill(0), .25, .5, .75, ...Array(5).fill(1)]); });
  test('constant reference has no measurable step', () => { invalid(Array(12).fill(1)); });
  test('both platforms need five samples', () => { invalid([...Array(4).fill(0), ...Array(8).fill(1)]); invalid([...Array(8).fill(0), ...Array(4).fill(1)]); });
  test('explicit reference jitter tolerance accepts one step', () => { const reference = [0, .01, -.01, 0, 0, 1, 1.01, .99, 1, 1, 1, 1]; assert.equal(evaluate(reference, reference, { ...goal, stepSetpointTolerance: .011 }).passed, true); });
  test('reference jitter outside tolerance is not hidden by response-error allowance', () => { invalid([0, .01, -.01, 0, 0, ...Array(7).fill(1)]); });
  test('overlapping reference bands are rejected', () => { invalid(step, step, { ...goal, stepSetpointTolerance: .5 }); });
  test('missing legacy tolerance requires explicit setup', () => { const legacy = { ...goal }; delete legacy.stepSetpointTolerance; invalid(step, step, legacy); assert.ok(validatePlan({ ...plan, goal: legacy }).some(error => error.includes('设定值容差'))); });
  test('bad reference tolerance is never coerced', () => { for (const value of [null, -1, NaN, Infinity, '0', false]) invalid(step, step, { ...goal, stepSetpointTolerance: value as never }); });
  test('pre-step unsettled feedback is not a step measurement', () => { invalid(step, [...Array(5).fill(.3), ...Array(7).fill(1)]); });
  test('overshoot failure retains valid step metrics', () => { const result = evaluate(step, [...Array(5).fill(0), 1.2, ...Array(6).fill(1)]); assert.equal(result.passed, false); assert.ok(Math.abs(result.metrics!.overshootPercent! - 20) < 1e-10); });
  test('small engineering units have no arbitrary amplitude floor', () => { const tiny = step.map(value => value * 1e-12); const result = evaluate(tiny, tiny, { ...goal, maximumSteadyError: 1e-15 }); assert.equal(result.passed, true); assert.equal(result.metrics?.overshootPercent, 0); });
  test('tracking remains available for repeated references', () => { const reference = [...Array(5).fill(0), 1, 0, 1, 0, ...Array(5).fill(1)]; const result = evaluate(reference, reference, { ...goal, mode: 'track', maximumTrackingError: .1 }); assert.equal(result.passed, true); assert.equal(result.metrics?.overshootPercent, null); });
  test('invalid step cannot mask an output-limit violation', () => { const reference = [...Array(5).fill(0), 1, 0, ...Array(5).fill(1)]; const result = evaluate(reference, reference, goal, [6, ...Array(reference.length - 1).fill(1)]); assert.equal(result.passed, false); assert.equal(result.outputLimitExceeded, true); assert.match(result.message, /控制输出超过/); });
  test('finite large RMS is computed without squaring overflow', () => { const result = evaluate(Array(12).fill(0), Array(12).fill(1e200), { ...goal, mode: 'track', maximumTrackingError: 1e201 }); assert.equal(result.passed, true); assert.equal(result.metrics?.rmsTrackingError, 1e200); });
  test('unrepresentable error does not become nonfinite metrics', () => { const result = evaluate(Array(12).fill(-1e308), Array(12).fill(1e308), { ...goal, mode: 'track', maximumTrackingError: 1e308 }); assert.equal(result.passed, false); assert.equal(result.metrics, null); });
  test('step feedback service rejects null overshoot before any request', () => {
    const current = { ...plan, goal };
    const metrics = { steadyError: 0, peakError: 0, rmsTrackingError: 0, overshootPercent: null, maximumOutputMagnitude: 1, sampleCount: 12 };
    const evidence = { source: 'baseline-window', configurationSignature: cascadeStageConfigurationSignature(current).signature, generation: 1, sessionId: 'unit-fixture', epoch: 1,
      params: current.baseline.params, windowStart: 0, windowEnd: 1, baselineConfirmedAt: 1, sampleCount: 12 };
    assert.throws(() => validateFeedbackObservation(current, current.baseline.params!, metrics, evidence), /单次阶跃/);
  });
  test('large windows avoid spread-argument limits and preserve samples', () => { const reference = new Float64Array(200_000).fill(1); const response = new Float64Array(200_000).fill(.99); const outputs = new Float64Array(200_000).fill(1); const result = evaluateResponse(reference, response, outputs, { ...goal, mode: 'settle' }, 5); assert.equal(result.passed, true); assert.equal(result.metrics?.sampleCount, 200_000); assert.equal(response[0], .99); });
  test('tolerance survives package import without confirmation authority', () => { const pkg = packagePlan({ ...plan, goal: { ...goal, stepSetpointTolerance: .01 } }) as TuningCapabilityPackage; assert.deepEqual(validateCapabilityPackage(pkg), []); const restored = importCapabilityPlan(pkg); assert.equal(restored.goal.stepSetpointTolerance, .01); assert.equal(restored.baseline.confirmed, false); assert.ok(validatePlan({ ...plan, goal: { ...goal, stepSetpointTolerance: 0 } }).every(error => !error.includes('设定值容差'))); });
  test('old packages remain readable without inventing tolerance', () => { const legacy = { ...goal }; delete legacy.stepSetpointTolerance; const pkg = packagePlan({ ...plan, goal: legacy }) as TuningCapabilityPackage; assert.deepEqual(validateCapabilityPackage(pkg), []); assert.equal(importCapabilityPlan(pkg).goal.stepSetpointTolerance, undefined); });
  test('malformed package tolerance is rejected before hydration', () => { const pkg = packagePlan({ ...plan, goal }) as TuningCapabilityPackage; pkg.plan.goal.stepSetpointTolerance = '0' as never; assert.ok(validateCapabilityPackage(pkg).some(error => error.includes('目标格式'))); });
  console.log(`Step response identification and finite evaluation: ${checked} behavior checks passed.`);
}
