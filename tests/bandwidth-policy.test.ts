import assert from 'node:assert/strict';
import { BandwidthChecker } from '../src/core/control/bandwidthChecker.ts';
import { estimateLoopBandwidth } from '../src/core/control/loopBandwidth.ts';
import type { ControlLoop } from '../src/core/project/types';

let cases = 0;
function check(name: string, verify: () => void) { verify(); cases++; console.log('  bandwidth: ' + name); }
const inner = (omega_c = 300, sampleTime = 0.001) => ({ id: 'inner', order: 0, omega_c, sampleTime });
const outer = (omega_c = 50, sampleTime = 0.001) => ({ id: 'outer', order: 1, omega_c, sampleTime });

check('threshold decisions use the unrounded ratio', () => {
  const result = BandwidthChecker.checkPair(inner(299.6), outer(100));
  assert.equal(result.passed, false);
  assert.ok(result.ratio! < 3);
  assert.equal(result.risk_level, 'high');
  assert.equal(BandwidthChecker.checkPair(inner(300), outer(100)).passed, true);
  assert.equal(BandwidthChecker.checkPair(inner(100.4), outer(100)).risk_level, 'high');
  assert.equal(BandwidthChecker.checkPair(inner(499.6), outer(100)).risk_level, 'medium');
});
check('sampling warnings cannot be hidden by medium pair status', () => {
  const report = BandwidthChecker.checkHierarchy([inner(400, 0.01), outer(100, 0.01)]);
  assert.equal(report.pairs[0].passed, true);
  assert.equal(report.nyquist_warnings.length, 2);
  assert.equal(report.passed, false);
  assert.equal(report.overall_risk, 'high');
});
check('single-loop unknown/invalid frequencies cannot pass', () => {
  for (const value of [NaN, Infinity, -Infinity, 0, -1]) {
    const report = BandwidthChecker.checkHierarchy([inner(value)]);
    assert.equal(report.passed, false);
    assert.ok(report.input_errors.length > 0);
  }
});
check('missing/invalid periods cannot pass by skipping the check', () => {
  for (const sampleTime of [undefined, NaN, Infinity, 0, -1]) {
    assert.equal(BandwidthChecker.checkHierarchy([{ ...inner(), sampleTime }]).passed, false);
  }
});
check('empty hierarchy and ambiguous loop identity cannot pass', () => {
  assert.equal(BandwidthChecker.checkHierarchy([]).passed, false);
  assert.equal(BandwidthChecker.checkHierarchy([inner(), { ...outer(), id: 'inner' }]).passed, false);
  assert.equal(BandwidthChecker.checkHierarchy([inner(), { ...outer(), order: 0 }]).passed, false);
  assert.equal(BandwidthChecker.checkHierarchy([{ ...inner(), order: 0.5 }]).passed, false);
});
check('normal and inverted hierarchies remain distinct', () => {
  const good = BandwidthChecker.checkHierarchy([outer(), inner()]);
  assert.equal(good.passed, true);
  assert.equal(good.pairs[0].innerId, 'inner');
  assert.equal(good.pairs[0].ratio, 6);
  assert.ok(good.limitations.some(value => value.includes('不证明')));
  assert.equal(BandwidthChecker.checkHierarchy([inner(40), outer(80)]).passed, false);
});
check('small values and recommendations retain computation precision', () => {
  const recommendation = BandwidthChecker.recommendOuterBandwidth(0.001);
  assert.equal(recommendation.recommended_omega_c, 0.0002);
  assert.ok(recommendation.safe_range[0] > 0);
  assert.equal(recommendation.safe_range[1], 0.001 / 3);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => BandwidthChecker.recommendOuterBandwidth(value));
  assert.throws(() => BandwidthChecker.recommendOuterBandwidth(1, NaN));
  assert.throws(() => BandwidthChecker.recommendOuterBandwidth(1, 0));
});
check('unrepresentable derived ratio is explicitly unavailable', () => {
  const report = BandwidthChecker.checkPair(inner(Number.MAX_VALUE), outer(Number.MIN_VALUE));
  assert.equal(report.passed, false);
  assert.equal(report.ratio, null);
  assert.equal(report.suggestedOuterOmegaC, null);
});
const loop: ControlLoop = { id:'inner',order:0,structure:'P',plant_family:'first_order',channels:{setpoint:'r',feedback:'y',output:'u'},param_limits:{kp:[0,10],ki:[0,10],kd:[0,10]},cmd_template:'',state:'untuned',current_params:{kp:2,ki:0,kd:0} };
check('the UI source helper never fabricates period or model frequency', () => {
  assert.equal(estimateLoopBandwidth(loop).source, 'unavailable');
  assert.ok(Number.isNaN(estimateLoopBandwidth(loop).info.omega_c));
  assert.equal(estimateLoopBandwidth({ ...loop, sample_time:0.001 }).source, 'unavailable');
  assert.equal(estimateLoopBandwidth({ ...loop, sample_time:0.001,state:'identified' }).source, 'unavailable');
});
check('model estimate uses provided model and period rather than loop order', () => {
  const provided = { ...loop,state:'identified' as const,sample_time:0.001,identified_model:{family:'fopdt' as const,k:1,t:1,tau:0} };
  const result = estimateLoopBandwidth(provided);
  assert.equal(result.source,'model-estimate');
  assert.ok(Math.abs(result.info.omega_c-Math.sqrt(3)) < 0.01);
  assert.equal(estimateLoopBandwidth({ ...provided,order:3 }).info.omega_c,result.info.omega_c);
  assert.equal(estimateLoopBandwidth({ ...provided,sample_period_s:0 }).source,'unavailable');
  assert.equal(estimateLoopBandwidth({ ...provided,current_params:{kp:NaN,ki:0,kd:0} }).source,'unavailable');
  assert.equal(estimateLoopBandwidth({ ...provided,current_params:{kp:0.5,ki:0,kd:0} }).source,'unavailable');
});
console.log('Bandwidth policy regression: ' + cases + ' cases passed.');
