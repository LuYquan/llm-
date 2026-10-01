import assert from 'node:assert/strict';
import { selectFeedbackEvidence, validTelemetryEvidenceShape } from '../src/core/tuning/feedbackEvidence';
import type { BaselineObservationBoundary, EvaluatedTrialContext, FeedbackEvidenceInput, TelemetryEvidence } from '../src/core/tuning/feedbackEvidence';
import type { TuningMetrics, TuningTrial } from '../src/core/tuning/types';

const metrics = (): TuningMetrics => ({ steadyError: 0.4, peakError: 0.8, rmsTrackingError: 0.5, overshootPercent: null, maximumOutputMagnitude: 2, sampleCount: 20 });
function baseline(): FeedbackEvidenceInput {
  const params = { kp: 2, ki: 0.5, kd: 0 };
  const boundary: BaselineObservationBoundary = {
    confirmedAt: 1_000, fromTelemetryTimestamp: 5, generation: 12, sessionId: 'device-current', epoch: 7,
    params: { ...params }, configurationSignature: 'current-config',
  };
  return {
    plan: { baseline: { params, source: 'manual', confirmed: true, stableBaseConfirmed: true }, evaluationWindowSeconds: 2 },
    currentConfigurationSignature: 'current-config', generation: 12, sessionContext: { sessionId: 'device-current', epoch: 7 },
    now: 3_000, currentTelemetryTimestamp: 7, lastConfirmed: null, trials: [], trialContexts: new Map(), baselineBoundary: boundary,
  };
}
function evaluated(): FeedbackEvidenceInput {
  const input = baseline();
  input.now = 5_000;
  input.currentTelemetryTimestamp = 8;
  const params = { ...input.plan.baseline.params! };
  const trial: TuningTrial = {
    id: 'trial-current', createdAt: 1_800, status: 'evaluated', before: { kp: 1.8, ki: 0.5, kd: 0 }, candidate: { ...params },
    sourceChannelGeneration: 12, writeRequestId: 'write-current', writeSessionId: 'device-current', writeEpoch: 7,
    writeCompletedAt: 2_000, writeChannelGeneration: 12, confirmationMode: 'parameter-channels',
    sampleWindowStart: 5.2, sampleWindowEnd: 7.2, metrics: metrics(), note: '目标尚未达成，窗口有效。',
  };
  const proof: EvaluatedTrialContext = {
    trialId: trial.id, configurationSignature: input.currentConfigurationSignature, generation: 12,
    sessionId: 'device-current', epoch: 7, params: { ...params }, windowStart: 5.2, windowEnd: 7.2,
    confirmedAt: 2_010, metrics: metrics(),
  };
  input.lastConfirmed = { params: { ...params }, mode: 'parameter-channels', at: proof.confirmedAt };
  input.trials = [trial];
  input.trialContexts = new Map([[trial.id, proof]]);
  return input;
}
function proof(input: FeedbackEvidenceInput): EvaluatedTrialContext { return input.trialContexts.get('trial-current')!; }

export function runTuningFeedbackEvidenceTests(): void {
  let checked = 0;
  const assertPending = (input: FeedbackEvidenceInput, label: string) => {
    const selected = selectFeedbackEvidence(input);
    assert.equal(selected.status, 'pending', label);
    if (selected.status === 'pending') assert.ok(selected.reason.trim(), label);
    checked++;
  };
  const first = selectFeedbackEvidence(baseline());
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready' || first.source !== 'baseline-window') throw new Error('expected current baseline window');
  assert.equal(first.afterTimestamp, 5);
  assert.equal(first.throughTimestamp, 7);
  assert.equal(first.evidence.windowStart, 5);
  assert.equal(first.evidence.windowEnd, 7);
  assert.equal(first.evidence.baselineConfirmedAt, 1_000);
  assert.equal(first.evidence.sampleCount, undefined, 'sample count is not invented before the UI reads synchronized data');
  assert.equal(validTelemetryEvidenceShape(first.evidence), true);
  assert.equal(validTelemetryEvidenceShape({ ...first.evidence, sampleCount: 10 }), true);
  checked++;

  const later = evaluated();
  const selected = selectFeedbackEvidence(later);
  assert.equal(selected.status, 'ready');
  if (selected.status !== 'ready' || selected.source !== 'evaluated-trial') throw new Error('expected one completed current trial');
  assert.equal(selected.evidence.trialId, 'trial-current');
  assert.equal(selected.evidence.windowStart, 5.2);
  assert.equal(selected.evidence.windowEnd, 7.2);
  assert.equal(selected.evidence.sampleCount, 20);
  assert.equal(selected.metrics.steadyError, 0.4, 'a complete evaluated window remains usable even when its goal was not reached');
  assert.equal(validTelemetryEvidenceShape(selected.evidence), true);
  selected.metrics.steadyError = 999;
  selected.evidence.params.kp = 999;
  assert.equal(later.trials[0].metrics!.steadyError, 0.4);
  assert.equal(later.plan.baseline.params!.kp, 2);
  assert.equal(proof(later).metrics.steadyError, 0.4, 'returned payload never aliases saved trial, plan or volatile proof');
  checked++;

  const old = evaluated();
  const historic: TuningTrial = { ...old.trials[0], id: 'old-pid', candidate: { kp: 0.5, ki: 0, kd: 0 }, metrics: { ...metrics(), steadyError: 1000 } };
  old.trials = [historic, ...old.trials];
  const current = selectFeedbackEvidence(old);
  assert.equal(current.status, 'ready');
  if (current.status !== 'ready' || current.source !== 'evaluated-trial') throw new Error('expected current trial independent of array order');
  assert.equal(current.evidence.trialId, 'trial-current');
  assert.equal(current.metrics.steadyError, 0.4, 'old PID statistics do not enter the selected current window');
  checked++;

  const baselineMutations: Array<[string, (input: FeedbackEvidenceInput) => void]> = [
    ['unconfirmed baseline', input => { input.plan.baseline.confirmed = false; }],
    ['missing current PID', input => { input.plan.baseline.params = null; }],
    ['nonfinite current PID', input => { input.plan.baseline.params!.kp = NaN; }],
    ['negative current PID', input => { input.plan.baseline.params!.kp = -1; }],
    ['missing volatile boundary', input => { input.baselineBoundary = null; }],
    ['boundary configuration changed', input => { input.baselineBoundary!.configurationSignature = 'old-config'; }],
    ['boundary PID changed', input => { input.baselineBoundary!.params.ki += 0.0000001; }],
    ['boundary generation changed', input => { input.baselineBoundary!.generation = 11; }],
    ['boundary device changed without generation update', input => { input.baselineBoundary!.sessionId = 'device-old'; }],
    ['boundary epoch changed without generation update', input => { input.baselineBoundary!.epoch = 6; }],
    ['future baseline confirmation', input => { input.baselineBoundary!.confirmedAt = input.now + 1; }],
    ['missing baseline timestamp', input => { input.baselineBoundary!.fromTelemetryTimestamp = NaN; }],
    ['wait incomplete by one millisecond', input => { input.now = 2_999; }],
    ['telemetry has not advanced', input => { input.currentTelemetryTimestamp = 5; }],
    ['telemetry clock went backward', input => { input.currentTelemetryTimestamp = 4; }],
    ['observation duration absent', input => { input.plan.evaluationWindowSeconds = null; }],
    ['observation duration zero', input => { input.plan.evaluationWindowSeconds = 0; }],
    ['observation duration overflow', input => { input.plan.evaluationWindowSeconds = Number.MAX_VALUE; }],
    ['current configuration identity missing', input => { input.currentConfigurationSignature = ''; }],
    ['current generation invalid', input => { input.generation = -1; }],
    ['current device identity missing', input => { input.sessionContext.sessionId = null; }],
    ['current epoch invalid', input => { input.sessionContext.epoch = 7.5; }],
    ['current wall time invalid', input => { input.now = Infinity; }],
    ['current telemetry time invalid', input => { input.currentTelemetryTimestamp = NaN; }],
  ];
  for (const [label, mutate] of baselineMutations) {
    const input = baseline(); mutate(input); assertPending(input, label);
  }
  const recreated = baseline();
  recreated.plan.baseline.confirmed = false;
  recreated.baselineBoundary = null;
  assertPending(recreated, 'a restored baseline does not grant a current-page observation boundary');

  const trialMutations: Array<[string, (input: FeedbackEvidenceInput) => void]> = [
    ['persisted evaluated trial without volatile context', input => { input.trialContexts = new Map(); }],
    ['current trial not fully evaluated', input => { input.trials[0].status = 'confirmed'; }],
    ['last confirmation PID changed', input => { input.lastConfirmed!.params.kd = 0.1; }],
    ['last confirmation timestamp changed', input => { input.lastConfirmed!.at += 1; }],
    ['last confirmation timestamp precedes write', input => { input.lastConfirmed!.at = 1_999; }],
    ['last confirmation in the future', input => { input.lastConfirmed!.at = input.now + 1; }],
    ['last confirmation mode changed', input => { input.lastConfirmed!.mode = 'manual'; }],
    ['trial candidate changed', input => { input.trials[0].candidate.kp += 0.0000001; }],
    ['trial current generation changed', input => { input.generation += 1; }],
    ['trial source generation changed', input => { input.trials[0].sourceChannelGeneration = 11; }],
    ['trial driver generation changed', input => { input.trials[0].writeChannelGeneration = 11; }],
    ['trial device session changed', input => { input.trials[0].writeSessionId = 'device-old'; }],
    ['trial epoch changed', input => { input.trials[0].writeEpoch = 6; }],
    ['trial request missing', input => { delete input.trials[0].writeRequestId; }],
    ['trial request whitespace', input => { input.trials[0].writeRequestId = ' '; }],
    ['trial completed time missing', input => { delete input.trials[0].writeCompletedAt; }],
    ['trial metrics missing', input => { delete input.trials[0].metrics; }],
    ['trial sample count insufficient', input => { input.trials[0].metrics!.sampleCount = 9; }],
    ['trial metric changed after evaluation', input => { input.trials[0].metrics!.steadyError = 0.0001; }],
    ['trial metrics contain undeclared payload fields', input => { Object.assign(input.trials[0].metrics!, { unrelatedCount: 42 }); }],
    ['trial output metric nonfinite', input => { input.trials[0].metrics!.maximumOutputMagnitude = NaN; }],
    ['trial window start absent', input => { delete input.trials[0].sampleWindowStart; }],
    ['trial window end absent', input => { delete input.trials[0].sampleWindowEnd; }],
    ['trial zero span', input => { input.trials[0].sampleWindowEnd = input.trials[0].sampleWindowStart; }],
    ['trial ends after current telemetry', input => { input.trials[0].sampleWindowEnd = 9; }],
    ['volatile proof wrong trial', input => { proof(input).trialId = 'other-trial'; }],
    ['volatile proof old config', input => { proof(input).configurationSignature = 'old-config'; }],
    ['volatile proof old generation', input => { proof(input).generation = 11; }],
    ['volatile proof old session', input => { proof(input).sessionId = 'device-old'; }],
    ['volatile proof old epoch', input => { proof(input).epoch = 6; }],
    ['volatile proof PID changed', input => { proof(input).params.ki = 0.1; }],
    ['volatile proof confirmation changed', input => { proof(input).confirmedAt += 1; }],
    ['volatile proof window start changed', input => { proof(input).windowStart = 0; }],
    ['volatile proof window end changed', input => { proof(input).windowEnd += 1; }],
    ['volatile proof metric changed', input => { proof(input).metrics.steadyError = 0.01; }],
    ['volatile proof metrics contain undeclared fields', input => { Object.assign(proof(input).metrics, { unrelatedCount: 42 }); }],
  ];
  for (const [label, mutate] of trialMutations) {
    const input = evaluated(); mutate(input); assertPending(input, `${label}; never fall back to the older baseline window`);
  }
  const duplicate = evaluated(); duplicate.trials = [duplicate.trials[0], structuredClone(duplicate.trials[0])];
  assertPending(duplicate, 'ambiguous current evaluated windows are not guessed or combined');

  const validShape = { ...first.evidence, sampleCount: 12 };
  const malformed: unknown[] = [
    null, [], { ...validShape, source: 'simulation' }, { ...validShape, generation: -1 },
    { ...validShape, epoch: 0.5 }, { ...validShape, sessionId: ' ' }, { ...validShape, configurationSignature: '' },
    { ...validShape, params: { kp: 2, ki: 0.5, kd: 0, api_key: 'not-a-real-key' } },
    { ...validShape, windowEnd: validShape.windowStart }, { ...validShape, sampleCount: 9 },
    { ...validShape, sampleCount: 10.5 }, { ...validShape, baselineConfirmedAt: undefined },
    { ...validShape, trialId: 'unexpected-trial' }, { ...validShape, api_key: 'not-a-real-key' },
    { ...validShape, source: 'evaluated-trial', baselineConfirmedAt: undefined, trialId: undefined },
  ];
  for (const value of malformed) { assert.equal(validTelemetryEvidenceShape(value), false, JSON.stringify(value)); checked++; }
  const evaluatedShape: TelemetryEvidence = { ...validShape, source: 'evaluated-trial', baselineConfirmedAt: undefined, trialId: 'trial-current' };
  assert.equal(validTelemetryEvidenceShape(evaluatedShape), true); checked++;

  const immutable = evaluated();
  const before = JSON.stringify([immutable.plan, immutable.trials, immutable.lastConfirmed, [...immutable.trialContexts], immutable.baselineBoundary]);
  Object.freeze(immutable.plan.baseline.params!); Object.freeze(immutable.plan.baseline); Object.freeze(immutable.plan);
  Object.freeze(immutable.lastConfirmed!.params); Object.freeze(immutable.lastConfirmed!);
  Object.freeze(immutable.trials[0].candidate); Object.freeze(immutable.trials[0].metrics!); Object.freeze(immutable.trials[0]); Object.freeze(immutable.trials);
  Object.freeze(proof(immutable).params); Object.freeze(proof(immutable).metrics); Object.freeze(proof(immutable));
  assert.equal(selectFeedbackEvidence(immutable).status, 'ready');
  assert.equal(JSON.stringify([immutable.plan, immutable.trials, immutable.lastConfirmed, [...immutable.trialContexts], immutable.baselineBoundary]), before);
  checked++;
  console.log(`✓ 反馈候选遥测依据选择测试通过（${checked} 项）：当前 PID 窗口、volatile确认身份、首轮基线新观察窗与元数据格式。`);
}

runTuningFeedbackEvidenceTests();
