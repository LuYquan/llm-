import assert from 'node:assert/strict';
import { CascadeStateMachine } from '../src/core/control/cascadeStateMachine.ts';
import { composeContinuousInnerLoop, continuousPidTransfer } from '../src/core/control/cascadeModel.ts';
import { evalControllerFreq, evalPlantFreq } from '../src/core/control/computeBode.ts';
import type { ControllerParams, PlantModel, TransferFunctionModel } from '../src/core/control/types.ts';

function transfer(model: PlantModel): TransferFunctionModel {
  assert.equal(model.family, 'transfer_function');
  if (model.family !== 'transfer_function') throw new Error('Expected an exact rational model');
  return model;
}

function closeArray(actual: number[], expected: number[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= 1e-12 * Math.max(1, Math.abs(expected[index]))));
}

/** Compare the returned rational model with direct complex negative feedback. */
function checkFeedbackResponse(plant: PlantModel, pid: ControllerParams, h = 1): void {
  const closed = composeContinuousInnerLoop(plant, pid, h);
  for (const omega of [0.001, 0.03, 0.3, 1, 3, 10, 100, 1000]) {
    const p = evalPlantFreq(plant, omega);
    const c = evalControllerFreq(pid, omega);
    const phase = p.phaseRad + c.phaseRad;
    const re = p.mag * c.mag * Math.cos(phase);
    const im = p.mag * c.mag * Math.sin(phase);
    const dr = 1 + h * re;
    const di = h * im;
    const norm = dr * dr + di * di;
    const expectedRe = (re * dr + im * di) / norm;
    const expectedIm = (im * dr - re * di) / norm;
    const response = evalPlantFreq(closed, omega);
    assert.ok(Math.abs(response.mag * Math.cos(response.phaseRad) - expectedRe) < 1e-9);
    assert.ok(Math.abs(response.mag * Math.sin(response.phaseRad) - expectedIm) < 1e-9);
  }
}

export function runCascadeModelTests(): void {
  const sm = new CascadeStateMachine();
  const unitPlant: PlantModel = { family: 'fopdt', k: 1, t: 1, tau: 0 };
  const p = transfer(sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'none' }));
  assert.deepEqual(p.numerator, [1]);
  assert.deepEqual(p.denominator, [1, 2]);
  assert.equal(p.numerator[0] / p.denominator.at(-1)!, 0.5, 'P-only inner loop does not have unit DC gain');

  const pi = transfer(sm.composeOuterPlant(unitPlant, { kp: 1, ki: 1 }, { addition: 'none' }));
  const highI = transfer(sm.composeOuterPlant(unitPlant, { kp: 1, ki: 100 }, { addition: 'none' }));
  assert.deepEqual(pi.numerator, [1, 1]);
  assert.deepEqual(pi.denominator, [1, 2, 1]);
  assert.deepEqual(highI.numerator, [1, 100]);
  assert.deepEqual(highI.denominator, [1, 2, 100], 'Ki changes the real inner dynamics instead of being ignored');
  assert.deepEqual(transfer(sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'none', feedbackGain: 2 })).denominator, [1, 3]);

  const pid = transfer(sm.composeOuterPlant(unitPlant, { kp: 1, ki: 1, kd: 0.2 }, { addition: 'none' }));
  closeArray(pid.numerator, [0.2, 1, 1]);
  closeArray(pid.denominator, [1.2, 2, 1]);
  const filtered = transfer(sm.composeOuterPlant(unitPlant, { kp: 1, ki: 1, kd: 0.2, tf: 0.1 }, { addition: 'none' }));
  closeArray(filtered.numerator, [0.3, 1.1, 1]);
  closeArray(filtered.denominator, [0.1, 1.4, 2.1, 1]);
  assert.deepEqual(continuousPidTransfer({ kp: 1 }), { numerator: [1], denominator: [1] }, 'P has no artificial integral state');
  assert.deepEqual(continuousPidTransfer({ kp: 1, kd: 0.2 }), { numerator: [0.2, 1], denominator: [1] }, 'PD has no artificial integral state');

  checkFeedbackResponse(unitPlant, { kp: 1, ki: 1, kd: 0.2, tf: 0.1 }, 2);
  checkFeedbackResponse({ family: 'sopdt', k: 2, wn: 3, zeta: 0.5, tau: 0 }, { kp: 1 });
  checkFeedbackResponse({ family: 'integral_lag', k: 1, t: 0.2, tau: 0 }, { kp: 2 });
  checkFeedbackResponse({ family: 'transfer_function', numerator: [1, 2], denominator: [1, 3, 2], tau: 0 }, { kp: 2 });

  const position = transfer(sm.composeOuterPlant(unitPlant, { kp: 1, ki: 1 }, { addition: 'integrator', extraGain: 2, delay: 0.02 }));
  assert.deepEqual(position.numerator, [2, 2]);
  assert.deepEqual(position.denominator, [1, 2, 1, 0]);
  assert.equal(position.tau, 0.02, 'only the external link delay is outside the zero-delay inner feedback');
  const lag = transfer(sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'lag', extraGain: 2, lagT: 0.2, delay: 0 }));
  assert.deepEqual(lag.numerator, [2]);
  closeArray(lag.denominator, [0.2, 1.4, 2]);
  const middlePlant = sm.composeOuterPlant(unitPlant, { kp: 1, ki: 1 }, { addition: 'integrator', extraGain: 1, delay: 0 });
  const outerClosed = transfer(sm.composeOuterPlant(middlePlant, { kp: 0.5 }, { addition: 'none' }));
  assert.deepEqual(outerClosed.numerator, [0.5, 0.5]);
  assert.deepEqual(outerClosed.denominator, [1, 2, 1.5, 0.5], 'the next loop is closed around the assembled inner subsystem');

  assert.throws(() => sm.composeOuterPlant({ ...unitPlant, k: -2 }, { kp: 1 }, { addition: 'none' }), /原始闭环特征多项式/);
  assert.deepEqual(transfer(sm.composeOuterPlant({ ...unitPlant, k: -2 }, { kp: -1 }, { addition: 'none' })).denominator, [1, 3], 'signed loop polarity is retained exactly');
  assert.throws(() => sm.composeOuterPlant({ family: 'transfer_function', numerator: [1], denominator: [1, 0], tau: 0 }, { kp: 0, ki: 1 }, { addition: 'none' }), /原始闭环特征多项式/);
  assert.throws(() => sm.composeOuterPlant({ family: 'transfer_function', numerator: [1, -1], denominator: [1, 0, -1], tau: 0 }, { kp: 1 }, { addition: 'none' }), /原始闭环特征多项式/, 'an unstable hidden plant mode must not disappear through pole-zero cancellation');

  const delayedPlant: PlantModel = { ...unitPlant, tau: 0.2 };
  assert.throws(() => sm.composeOuterPlant(delayedPlant, { kp: 1, ki: 1 }, { addition: 'none' }), /反馈中含纯滞后/);
  assert.throws(() => sm.composeOuterPlant(delayedPlant, { kp: 1, ki: 1 }, { addition: 'none', effectiveInnerBandwidth: 10 }), /单个内环带宽不能/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'none', effectiveInnerBandwidth: 10 }), /单个内环带宽不能/);
  const measuredClosed: PlantModel = { family: 'transfer_function', numerator: [2], denominator: [0.1, 1], tau: 0.03 };
  const supplied = transfer(sm.composeOuterPlant(delayedPlant, { kp: 1, ki: 1 }, {
    addition: 'integrator', extraGain: 3, delay: 0.02, innerClosedLoopModel: measuredClosed, effectiveInnerBandwidth: 10,
  }));
  assert.deepEqual(supplied.numerator, [6]);
  assert.deepEqual(supplied.denominator, [0.1, 1, 0]);
  assert.equal(supplied.tau, 0.05, 'the supplied closed-loop model is not multiplied by the old 0.2 second plant delay');
  assert.deepEqual(measuredClosed, { family: 'transfer_function', numerator: [2], denominator: [0.1, 1], tau: 0.03 }, 'input model remains unchanged');
  assert.throws(() => sm.composeOuterPlant(delayedPlant, { kp: 1 }, { addition: 'none', innerClosedLoopModel: { family: 'transfer_function', numerator: [1], denominator: [1, -1], tau: 0 } }), /闭环等效模型必须/);

  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'integrator' }), /增益必须明确/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'integrator', extraGain: 1 }), /纯滞后必须明确/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'lag', extraGain: 1, delay: 0 }), /时间常数必须明确/);
  for (const lagT of [0, -1, NaN, Infinity]) assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'lag', extraGain: 1, delay: 0, lagT }), /时间常数必须明确/);
  for (const extraGain of [0, NaN, Infinity]) assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'none', extraGain }), /增益必须是非零有限/);
  for (const delay of [-1, NaN, Infinity]) assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'none', delay }), /纯滞后必须是非负有限/);
  for (const feedbackGain of [0, NaN, Infinity]) assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'none', feedbackGain }), /反馈增益必须/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1, ki: NaN }, { addition: 'none' }), /PID 系数/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1, tf: -1 }, { addition: 'none' }), /PID 系数/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1, sampleTime: 0 }, { addition: 'none' }), /采样周期必须/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 0 }, { addition: 'none' }), /零控制器/);
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: Number.MAX_VALUE }, { addition: 'none', feedbackGain: 2 }));
  assert.throws(() => sm.composeOuterPlant(unitPlant, { kp: 1 }, { addition: 'integrator', extraGain: 1, delay: 0,
    innerClosedLoopModel: { family: 'transfer_function', numerator: [1], denominator: [1, 8, 28, 56, 70, 56, 28, 8, 1], tau: 0 },
  }), /最高 8 阶/);
  console.log('  ✓ 精确连续串级模型、完整 PID/反馈增益、频率一致性、原始稳定性、延迟与参数边界回归通过');
}
