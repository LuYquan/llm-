import assert from 'node:assert/strict';
import type { TransferFunctionModel } from '../src/core/control/types';
import { computeBode, evalPlantFreq } from '../src/core/control/computeBode';
import { solvePid } from '../src/core/control/solvePid';
import { simulateClosedLoop } from '../src/core/control/simulateClosedLoop';
import { closedLoopPolynomial, getPlantControlGain, polynomialStability, validatePlantModel, withPlantGainMultiplier } from '../src/core/control/transferFunction';
import { createScenarioContext, deriveScenarioPlant, evaluateModelExpression, getScenarioPhysicalFields, getScenarioSuite, materializeTransferFunctionDraft, parseTransferFunctionInput, SCENARIO_SUITES, validateCustomStages } from '../src/core/tuning/scenarios';

export function runTuningScenarioTests(): void {
  assert.deepEqual(SCENARIO_SUITES.map(item => item.id), ['balance-car', 'flight-control', 'custom']);
  for (const suite of SCENARIO_SUITES) {
    const context = createScenarioContext(suite.id);
    assert.equal(context.modelOrigin, 'pending');
    assert.equal(context.modelConfirmed, false);
    assert.ok(Object.values(context.physicalInputs).every(value => value === null), '预设字段不得默认设备事实');
    assert.ok(suite.prompt.includes('提示词不能绕过'));
    assert.ok(suite.skills.length && suite.tools.includes('local.pid-solver'));
  }
  assert.equal(getScenarioSuite('untrusted-id'), undefined);
  const custom = createScenarioContext('custom', 'cascade');
  assert.deepEqual(custom.customStages?.map(item => item.id), ['inner', 'outer']);
  assert.equal(validateCustomStages(custom.customStages!).length, 0);
  assert.ok(validateCustomStages([custom.customStages![0], custom.customStages![0]]).length);
  for (const structure of ['P', 'PI', 'PD', 'PID'] as const) {
    assert.equal(validateCustomStages([{ id: 'stage', title: '环路', structure, supportedStructures: [structure] }]).length, 0);
  }
  assert.equal(deriveScenarioPlant('balance-car', 'upright', 'upright', {}).status, 'needs-input');
  assert.equal(deriveScenarioPlant('flight-control', 'rate', 'attitude', {}).status, 'unsupported');
  assert.ok(!getScenarioPhysicalFields('flight-control', 'attitude').some(item => item.id === 'inner_bandwidth'));
  assert.ok(getScenarioPhysicalFields('flight-control', 'attitude').some(item => item.id === 'inner_feedback_gain'));
  assert.ok(getScenarioPhysicalFields('flight-control', 'attitude').some(item => item.id === 'inner_derivative_filter_time'));
  assert.ok(getScenarioPhysicalFields('flight-control', 'attitude').some(item => item.id === 'angle_rate_unit_scale'));
  assert.ok(!getScenarioPhysicalFields('flight-control', 'attitude').some(item => item.id === 'axis_inertia'));

  const balanceInputs = { body_mass: 1, total_mass: 2, center_height: 0.2, body_inertia: 0.02, wheel_radius: 0.05, torque_gain: 0.1, pitch_damping: 0, actuator_time: 0, delay: 0 };
  const balance = deriveScenarioPlant('balance-car', 'upright', 'upright', balanceInputs);
  assert.equal(balance.status, 'ready', balance.warnings.join(' '));
  assert.ok(Math.abs(balance.model!.numerator[0] - (-0.2)) < 1e-12);
  assert.ok(Math.abs(balance.model!.denominator[0] - 0.06) < 1e-12);
  assert.ok(Math.abs(balance.model!.denominator[2] - (-1.96133)) < 1e-12);
  assert.equal(polynomialStability(balance.model!.denominator), 'unstable');
  assert.ok(balance.assumptions.some(item => item.includes('忽略轮转动惯量')));
  assert.ok(balance.warnings.some(item => item.includes('开环不稳定')));
  assert.equal(deriveScenarioPlant('balance-car', 'upright', 'upright', { ...balanceInputs, total_mass: 0.5 }).status, 'unsupported');
  const flight = deriveScenarioPlant('flight-control', 'rate', 'rate', { axis_inertia: 0.02, torque_gain: 0.3, axis_damping: 0, actuator_time: 0.04, delay: 0.002 });
  assert.equal(flight.status, 'ready');
  assert.deepEqual(flight.model!.denominator, [0.0008, 0.02, 0]);
  const attitudeInputs = { inner_feedback_gain: 1, inner_derivative_filter_time: 0, angle_rate_unit_scale: 1, delay: 0 };
  assert.equal(deriveScenarioPlant('flight-control', 'rate-attitude', 'attitude', { inner_bandwidth: 20, delay: 0 }).status, 'needs-input');
  assert.equal(deriveScenarioPlant('flight-control', 'rate-attitude', 'attitude', attitudeInputs).status, 'needs-input');
  const attitude = deriveScenarioPlant('flight-control', 'rate-attitude', 'attitude', attitudeInputs, { plant: { family: 'fopdt', k: 2, t: 0.5, tau: 0 }, params: { kp: 4, ki: 0, kd: 0, tf: 0 }, feedbackGain: 1 });
  assert.equal(attitude.status, 'ready', attitude.warnings.join(' '));
  assert.deepEqual(attitude.model!.numerator, [8]);
  assert.deepEqual(attitude.model!.denominator, [0.5, 9, 0]);

  const parsed = parseTransferFunctionInput('[2]', '0.3, 1', 0.02);
  assert.ok(parsed.model);
  assert.deepEqual(parsed.model!.numerator, [2]);
  for (const [num, den, delay] of [['', '1,1', 0], ['1', '0,1', 0], ['0', '1,1', 0], ['1,1,1', '1,1', 0], ['NaN', '1,1', 0], ['1', '1,1', -1], ['1', '0,0', 0]] as const) {
    assert.equal(parseTransferFunctionInput(num, den, delay).model, null, `${num}/${den}, tau=${delay}`);
  }
  const rational: TransferFunctionModel = { family: 'transfer_function', numerator: [2], denominator: [0.3, 1], tau: 0.02 };
  assert.equal(validatePlantModel(rational).length, 0);
  assert.equal(getPlantControlGain(rational), 2 / 0.3);
  assert.deepEqual((withPlantGainMultiplier(rational, -1) as TransferFunctionModel).numerator, [-2]);
  for (const omega of [0.1, 1, 10, 100]) {
    const actual = evalPlantFreq(rational, omega);
    const expected = evalPlantFreq({ family: 'fopdt', k: 2, t: 0.3, tau: 0.02 }, omega);
    assert.ok(Math.abs(actual.mag - expected.mag) < 1e-10);
    assert.ok(Math.abs(actual.phaseRad - expected.phaseRad) < 1e-10);
  }
  const pid = { kp: 1, ki: 2, kd: 0.03, tf: 0.01 };
  const rationalSim = simulateClosedLoop({ plant: rational, pid, sampleTime: 0.002, simTime: 2, outputLimits: [-10, 10] });
  const familySim = simulateClosedLoop({ plant: { family: 'fopdt', k: 2, t: 0.3, tau: 0.02 }, pid, sampleTime: 0.002, simTime: 2, outputLimits: [-10, 10] });
  assert.ok(rationalSim.values.every((value, i) => Math.abs(value - familySim.values[i]) < 1e-5), '有理对象实现应复现同一一阶对象');
  assert.ok(rationalSim.controls.every(value => value >= -10 && value <= 10));
  const staticSim = simulateClosedLoop({ plant: { family: 'transfer_function', numerator: [2], denominator: [1], tau: 0 }, pid: { kp: 0.1 }, sampleTime: 0.01, simTime: 1 });
  assert.ok(Math.abs(staticSim.values.at(-1)! - 1 / 6) < 1e-4, '静态直接馈通按采样前保持输入实现，稳定反馈应收敛');
  assert.throws(() => simulateClosedLoop({ plant: rational, pid, sampleTime: -1 }), /采样/);
  assert.throws(() => simulateClosedLoop({ plant: rational, pid, sampleTime: 1e-8, simTime: 1 }), /预算/);

  const filtered = solvePid(rational, { target_omega_c: 15, target_phase_margin: 55, sampleTime: 0.001, tf: 0.015, structure: 'PID' });
  assert.equal(filtered.success, true, filtered.message);
  assert.ok(Math.abs(filtered.achieved_omega_c! - 15) < 0.1);
  assert.ok(Math.abs(filtered.achieved_phase_margin! - 55) < 0.1);
  assert.ok(Math.abs(filtered.kd * filtered.ki - 0.25 * filtered.kp ** 2) / filtered.kp ** 2 < 1e-9);
  const unstable: TransferFunctionModel = { family: 'transfer_function', numerator: [1], denominator: [1, 0, -4], tau: 0 };
  const uprightPid = solvePid(unstable, { target_omega_c: 5, target_phase_margin: 60, sampleTime: 0.001, structure: 'PD' });
  assert.equal(uprightPid.success, true, uprightPid.message);
  assert.equal(polynomialStability(closedLoopPolynomial(unstable, uprightPid)), 'stable');
  assert.equal(computeBode(unstable, uprightPid, { sampleTime: 0.001 }).is_stable, null, '开环不稳定对象不能仅凭常规裕度报告稳定');
  assert.equal(solvePid({ ...unstable, tau: 0.01 }, { target_omega_c: 5, target_phase_margin: 60, sampleTime: 0.001, structure: 'PD' }).success, false, '延时不稳定对象没有完整证明时拒绝成功');
  assert.equal(solvePid(rational, { target_omega_c: NaN, target_phase_margin: 55 }).success, false);
  assert.equal(solvePid(rational, { target_omega_c: 1000, target_phase_margin: 55, sampleTime: 0.01 }).success, false);
  assert.equal(polynomialStability([1, 3, 2]), 'stable');
  assert.equal(polynomialStability([1, 1, 1, 10]), 'unstable');
  assert.equal(polynomialStability([1, 0, 1]), 'unknown');
  assert.equal(polynomialStability([1, 1, 0]), 'marginal');

  assert.equal(evaluateModelExpression('1 / (mass * radius^2)', { mass: 2, radius: 0.5 }), 2);
  assert.equal(evaluateModelExpression('sqrt(9)+abs(-2)', {}), 5);
  assert.equal(evaluateModelExpression('-2^2', {}), -4);
  assert.equal(evaluateModelExpression('2^3^2', {}), 512);
  for (const expression of ['process.exit()', 'globalThis.x', 'constructor', '1/0', 'sqrt(-1)', 'mass;1', 'missing+1', '(1+2', '2**2']) assert.throws(() => evaluateModelExpression(expression, { mass: 2 }), expression);
  const draft = { numerator: ['gain'], denominator: ['mass', 'damping'], tau: '0', physicalFields: [{ id: 'gain', label: '增益', unit: 'N', required: true }, { id: 'mass', label: '质量', unit: 'kg', required: true, min: 0.001 }, { id: 'damping', label: '阻尼', unit: 'N·s/m', required: true, min: 0 }], assumptions: ['单轴线性近似'] };
  assert.equal(materializeTransferFunctionDraft(draft, {}).status, 'needs-input');
  const materialized = materializeTransferFunctionDraft(draft, { gain: 2, mass: 0.5, damping: 1 });
  assert.equal(materialized.status, 'ready');
  assert.deepEqual(materialized.model!.denominator, [0.5, 1]);
  assert.equal(materializeTransferFunctionDraft({ ...draft, numerator: ['hidden'] }, { gain: 2, mass: 0.5, damping: 1, hidden: 99 }).status, 'unsupported', '草稿只能引用声明的物理字段');
  assert.equal(materializeTransferFunctionDraft({ ...draft, physicalFields: [...draft.physicalFields, draft.physicalFields[0]] }, {}).status, 'unsupported');
  assert.equal(materializeTransferFunctionDraft(draft, { gain: 2, mass: 0, damping: 1 }).status, 'unsupported');
  console.log('✓ 场景套组、物理前提、有理对象、滤波 PID、闭环检查和安全公式测试通过。');
}

runTuningScenarioTests();
