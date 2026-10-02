import assert from 'node:assert/strict';
import { calculateModelCandidate, createCandidateRecord, evaluateResponse, formatTuningParameter, importCapabilityPlan, isTrialForPlan, matchesParameterReadback, packagePlan, trialBudgetUsed, validateCandidate, validateCandidateInputs, validateCapabilityPackage, validatePlan } from '../src/core/tuning/engine.ts';
import { buildFeedbackRequest, parsePlantModelDraft, proposeFeedbackCandidate, validateFeedbackObservation } from '../src/services/tuningAgent.ts';
import { cascadeStageConfigurationSignature } from '../src/core/tuning/cascadeDependencies.ts';
import type { TelemetryEvidence } from '../src/core/tuning/feedbackEvidence.ts';
import { loadTuningSession, loadTuningStageSession, loadTuningGroupSessions, saveTuningSession, updateTuningTrialReceipt } from '../src/core/tuning/sessionStore.ts';
import type { TuningPlan } from '../src/core/tuning/types.ts';
import type { TuningSession } from '../src/core/tuning/types.ts';
import { isAcknowledgementForWrite, isFreshChannelValue, isWriteResultForTrial } from '../src/core/tuning/write-correlation.ts';
import { executionSafetyStopReason, manualCandidateEligibility } from '../src/core/tuning/flow.ts';
import { createScenarioContext } from '../src/core/tuning/scenarios.ts';

function createValidPlan(): TuningPlan {
  return {
    id: 'test-session',
    version: 1,
    name: '速度环试验',
    project: '台架电机',
    description: '测试对象',
    prompt: '请仅根据给定指标提出受限候选。',
    route: 'feedback',
    mode: 'manual',
    loopId: 'speed',
    structure: 'PI',
    controlDirection: 'direct',
    sampleTimeSeconds: 0.01,
    commandTemplate: 'PID,{id},{kp},{ki},{kd}',
    baseline: {
      params: { kp: 2, ki: 0.5, kd: 0 },
      source: 'manual',
      confirmed: true,
      stableBaseConfirmed: false,
    },
    bounds: {
      kp: { min: 0, max: 10 },
      ki: { min: 0, max: 2 },
      kd: { min: 0, max: 0 },
    },
    maxParameterChangePercent: 20,
    maximumTrials: 5,
    evaluationWindowSeconds: 2,
    maximumTelemetryAgeSeconds: 0.5,
    maximumOutputMagnitude: 100,
    channels: {
      setpoint: 'setpoint',
      feedback: 'feedback',
      output: 'output',
      parameters: {},
    },
    units: {
      setpoint: 'rpm',
      feedback: 'rpm',
      output: '%',
      parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' },
    },
    confirmation: {
      mode: 'manual',
      acknowledgementText: '',
      timeoutSeconds: null,
      parameterTolerance: null,
    },
    goal: {
      mode: 'settle',
      maximumSteadyError: 0.1,
      maximumOvershootPct: null,
      maximumTrackingError: null,
      targetPhaseMarginDeg: null,
      targetCrossoverRadPerSec: null,
    },
    model: null,
  };
}

const plan = createValidPlan();
assert.deepEqual(validatePlan(plan), [], 'a complete manually confirmed plan passes preflight');

assert.equal(manualCandidateEligibility({
  planErrorCount: 0,
  isWorking: false,
  sessionStatus: 'ready',
  route: 'model',
  connected: false,
  telemetryFresh: false,
}).allowed, true, 'a valid model route can propose a manual candidate without device telemetry');
assert.equal(manualCandidateEligibility({
  planErrorCount: 0,
  isWorking: true,
  sessionStatus: 'ready',
  route: 'model',
  connected: true,
  telemetryFresh: true,
}).allowed, false, 'an active experiment blocks a second manual candidate');
assert.equal(manualCandidateEligibility({
  planErrorCount: 0,
  isWorking: false,
  sessionStatus: 'ready',
  route: 'feedback',
  connected: false,
  telemetryFresh: true,
}).allowed, false, 'feedback candidates require an active connection');

const missingDirection = { ...plan, controlDirection: null };
assert.ok(validatePlan(missingDirection).some((error) => error.includes('控制方向')));

const mismatchedUnits = { ...plan, units: { ...plan.units, feedback: 'rad/s' } };
assert.ok(validatePlan(mismatchedUnits).some((error) => error.includes('不一致')));

const baselineOutsideBounds = { ...plan, baseline: { ...plan.baseline, params: { kp: 12, ki: 0.5, kd: 0 } } };
assert.ok(validatePlan(baselineOutsideBounds).some((error) => error.includes('基线超出')));

const autoWithoutDeviceConfirmation: TuningPlan = {
  ...plan,
  mode: 'bounded-auto',
  baseline: { ...plan.baseline, stableBaseConfirmed: false },
};
assert.ok(validatePlan(autoWithoutDeviceConfirmation).some((error) => error.includes('参数回传或写入应答')));
assert.ok(validatePlan(autoWithoutDeviceConfirmation).some((error) => error.includes('稳定控制')));
const autoWithGenericAck = {
  ...autoWithoutDeviceConfirmation,
  confirmation: { ...autoWithoutDeviceConfirmation.confirmation, mode: 'acknowledgement' as const, acknowledgementText: 'OK' },
};
assert.ok(validatePlan(autoWithGenericAck).some((error) => error.includes('{request_id}')));
const autoWithCorrelatedAck = {
  ...autoWithGenericAck,
  commandTemplate: 'PID,{request_id},{id},{kp},{ki},{kd}',
  confirmation: { ...autoWithGenericAck.confirmation, acknowledgementText: 'PID_APPLIED {request_id}' },
};
assert.equal(validatePlan(autoWithCorrelatedAck).some((error) => error.includes('{request_id}')), false);
assert.ok(validatePlan({ ...autoWithCorrelatedAck, commandTemplate: plan.commandTemplate }).some((error) => error.includes('参数命令必须发送')));

const offlineModelPlan: TuningPlan = {
  ...plan, route: 'model', model: { family: 'fopdt', k: 2, t: 1, tau: 0 },
  baseline: { params: null, source: 'unset', confirmed: false, stableBaseConfirmed: false },
  bounds: { kp: null, ki: null, kd: null }, channels: { setpoint: '', feedback: '', output: '', parameters: {} },
  commandTemplate: '', goal: { ...plan.goal, targetCrossoverRadPerSec: 1, targetPhaseMarginDeg: 60 },
};
assert.deepEqual(validateCandidateInputs(offlineModelPlan), [], 'physical-model computation works before connecting or entering hardware limits');
assert.ok(validatePlan(offlineModelPlan).length > 0, 'offline computation does not grant hardware write eligibility');
assert.equal(calculateModelCandidate(offlineModelPlan.model!, offlineModelPlan).result.success, true);
const modelWithReverseGain = { ...offlineModelPlan, controlDirection: 'reverse' as const, model: { family: 'fopdt' as const, k: -2, t: 1, tau: 0 } };
assert.equal(calculateModelCandidate(modelWithReverseGain.model, modelWithReverseGain).result.success, true, 'reverse device direction uses positive coefficients without losing the physical sign');

const proposalTrial = createCandidateRecord({ kp: 2.3, ki: 0.55, kd: 0 }, plan, plan.baseline.params!, '受限候选');
assert.equal(proposalTrial.protocolRequestId, proposalTrial.id, 'device ACK identity exists before rendering the payload');
assert.equal(isTrialForPlan(proposalTrial, plan), true);
assert.equal(isTrialForPlan({ ...proposalTrial, sourceChannelGeneration: 5 }, plan, 5), true);
assert.equal(isTrialForPlan({ ...proposalTrial, sourceChannelGeneration: 5 }, plan, 6), false, 'a proposal from another device generation cannot be sent');
assert.equal(isTrialForPlan(proposalTrial, plan, 5), false, 'historic proposals without device identity must be regenerated before device execution');
for (const value of [0.000011, 1.23456789123456, 1e-12, 1e12, -0.000011]) {
  assert.equal(Number(formatTuningParameter(value)), value, 'the sent numeric token roundtrips to the reviewed parameter');
}
assert.throws(() => formatTuningParameter(Infinity));
assert.equal(isTrialForPlan(proposalTrial, { ...plan, commandTemplate: 'OTHER,{kp}' }), false, 'a changed command cannot send an older candidate');
assert.equal(isTrialForPlan({ ...proposalTrial, planSignature: undefined }, plan), false, 'legacy unbound candidates need regeneration');
assert.equal(trialBudgetUsed([proposalTrial, { ...proposalTrial, status: 'failed', writeStartedAt: 1000 }]), 1, 'an attempted write still consumes a trial when no evaluation completes');
assert.ok(validatePlan({ ...plan, maximumTrials: 101 }).some((error) => error.includes('1 到 100')));

const safeCandidate = validateCandidate(
  { kp: 2.3, ki: 0.55, kd: 0 },
  plan,
  plan.baseline.params!,
);
assert.equal(safeCandidate.valid, true, safeCandidate.errors.join(' '));

const inactiveTermWithoutBounds = validateCandidate(
  { kp: 2.3, ki: 0.55, kd: 0 },
  { ...plan, bounds: { ...plan.bounds, kd: null } },
  plan.baseline.params!,
);
assert.equal(inactiveTermWithoutBounds.valid, true, inactiveTermWithoutBounds.errors.join(' '));
const nonzeroInactiveTerm = validateCandidate(
  { kp: 2, ki: 0.5, kd: 0.01 },
  { ...plan, bounds: { ...plan.bounds, kd: null } },
  plan.baseline.params!,
);
assert.ok(nonzeroInactiveTerm.errors.some((error) => error.includes('不允许修改 KD')));

const outOfBoundsCandidate = validateCandidate(
  { kp: 11, ki: 0.5, kd: 0 },
  plan,
  plan.baseline.params!,
);
assert.equal(outOfBoundsCandidate.valid, false);
assert.ok(outOfBoundsCandidate.errors.some((error) => error.includes('超出用户确认的范围')));

const excessiveStepCandidate = validateCandidate(
  { kp: 3, ki: 0.5, kd: 0 },
  plan,
  plan.baseline.params!,
);
assert.equal(excessiveStepCandidate.valid, false);
assert.ok(excessiveStepCandidate.errors.some((error) => error.includes('单轮变化上限')));

const illegalStructureCandidate = validateCandidate(
  { kp: 2, ki: 0.5, kd: 0 },
  { ...plan, structure: 'P' },
  plan.baseline.params!,
);
assert.equal(illegalStructureCandidate.valid, false);
assert.ok(illegalStructureCandidate.errors.some((error) => error.includes('不允许修改 KI')));

const settled = evaluateResponse(
  Array(12).fill(1),
  Array(12).fill(0.99),
  Array(12).fill(4),
  plan.goal,
  5,
);
assert.equal(settled.passed, true);
assert.equal(settled.metrics?.sampleCount, 12);

const overOutput = evaluateResponse(
  Array(12).fill(1),
  Array(12).fill(0.99),
  Array(12).fill(6),
  plan.goal,
  5,
);
assert.equal(overOutput.passed, false);
assert.match(overOutput.message, /控制输出超过/);

const hiddenSteadySpike = evaluateResponse(
  Array(12).fill(1),
  [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 2, 0.99],
  Array(12).fill(4),
  plan.goal,
  5,
);
assert.equal(hiddenSteadySpike.passed, false, 'a spike in the final validation samples cannot be hidden by a median');
assert.equal(evaluateResponse(Array(12).fill(1), [NaN, ...Array(11).fill(1)], Array(12).fill(4), plan.goal, 5).metrics, null, 'invalid numeric evidence never reaches AI feedback');
assert.equal(evaluateResponse(Array(12).fill(1), Array(11).fill(1), Array(12).fill(4), plan.goal, 5).metrics, null, 'mismatched arrays are not silently treated as synchronized');

const movingTargetAsSettle = evaluateResponse(
  [0, 0, 0, 0, 0, 0.5, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0.5, 1, 1, 1, 1, 1, 1],
  Array(12).fill(4),
  plan.goal,
  5,
);
assert.equal(movingTargetAsSettle.passed, false, 'a moving reference is not accepted as a static settle goal');
assert.match(movingTargetAsSettle.message, /平台条件/);

const stepResponse = evaluateResponse(
  [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0.9, 1, 1, 1, 1, 1, 1],
  Array(12).fill(4),
  { ...plan.goal, mode: 'step-response', maximumOvershootPct: 5, stepSetpointTolerance: 0 },
  5,
);
assert.equal(stepResponse.passed, true);

const tracking = evaluateResponse(
  [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1],
  [0.005, 0.105, 0.205, 0.305, 0.405, 0.505, 0.605, 0.705, 0.805, 0.905, 1.005, 1.105],
  Array(12).fill(4),
  { ...plan.goal, mode: 'track', maximumTrackingError: 0.01 },
  5,
);
assert.equal(tracking.passed, true);
assert.ok((tracking.metrics?.rmsTrackingError ?? Infinity) < 0.01);

assert.equal(matchesParameterReadback({ kp: 2, ki: 0.5, kd: 0 }, { kp: 2.08, ki: 0.52 }, 5, 'PI'), true);
assert.equal(matchesParameterReadback({ kp: 2, ki: 0.5, kd: 0 }, { kp: 2.2, ki: 0.5 }, 5, 'PI'), false);

const writeCorrelation = { requestId: 'tx-17', protocolRequestId: 'trial-1', startedAt: 1000, completedAt: 1100, channelGeneration: 4, startRevision: 10, startLogId: 20,
  writeStatus: 'written' as const, sessionId: 'device-1', epoch: 0, currentSessionId: 'device-1', currentEpoch: 0,
  rxDispatch: { source: 'web-serial-read' as const, session_id: 'device-1', epoch: 0, rx_sequence: 10 } };
const ackOrigin = { source: 'web-serial-read' as const, session_id: 'device-1', epoch: 0, first_rx_sequence: 11, last_rx_sequence: 11 };
assert.equal(isWriteResultForTrial({ trialId: 'trial-1', requestId: 'tx-17', status: 'written' }, 'trial-1'), true);
assert.equal(isWriteResultForTrial({ trialId: 'trial-1', requestId: 'tx-16', status: 'written' }, 'trial-1', writeCorrelation.requestId), false, 'a previous request cannot advance the current trial');
assert.equal(isWriteResultForTrial({ trialId: 'trial-1', status: 'written' }, 'trial-1'), false, 'a result without a request id is not correlated');
assert.equal(isFreshChannelValue({ value: 2.3, receivedAt: 1100, generation: 4, revision: 11 }, writeCorrelation), true);
assert.equal(isFreshChannelValue({ value: 2.3, receivedAt: 1099, generation: 4, revision: 11 }, writeCorrelation), true, 'a current readback can precede the frontend receipt callback');
assert.equal(isFreshChannelValue({ value: 2.3, receivedAt: 1200, generation: 3, revision: 11 }, writeCorrelation), false, 'a value from a cleared/reconnected display generation is stale');
assert.equal(isAcknowledgementForWrite({ id: 21, tag: '[RX]', level: 'info', text: 'PID_APPLIED trial-1', at: 1110, rx_origin: ackOrigin }, 'PID_APPLIED trial-1', writeCorrelation), true);
assert.equal(isAcknowledgementForWrite({ id: 19, tag: '[RX]', level: 'info', text: 'PID_APPLIED trial-1', at: 1110, rx_origin: ackOrigin }, 'PID_APPLIED trial-1', writeCorrelation), false);
assert.equal(isAcknowledgementForWrite({ id: 22, tag: '[RX]', level: 'info', text: 'PID_APPLIED trial-1', at: 1090, rx_origin: ackOrigin }, 'PID_APPLIED trial-1', writeCorrelation), true, 'a unique current ACK can precede the frontend receipt callback');

const packageValue = packagePlan(plan, '速度环项目套件') as Record<string, any>;
assert.deepEqual(validateCapabilityPackage(packageValue), []);
assert.equal(packageValue.plan.baseline.params, null, 'exported packages never carry the device baseline');
assert.equal(packageValue.plan.prompt, '', 'project guidance is represented as a declarative skill');
assert.equal(packageValue.skills[0].instructions, plan.prompt);
assert.ok(validateCapabilityPackage({ ...packageValue, tools: ['remote.shell'] }).some((error) => error.includes('工具')));
assert.ok(validateCapabilityPackage({ ...packageValue, plan: { ...packageValue.plan, channels: null } }).some((error) => error.includes('通道')));
assert.ok(validateCapabilityPackage({ ...packageValue, plan: { ...packageValue.plan, confirmation: { mode: 'other' } } }).length > 0);
const imported = importCapabilityPlan({ ...packageValue, plan: { ...plan } });
assert.equal(imported.baseline.confirmed, false, 'imported device confirmation never authorizes a new device');
assert.equal(imported.baseline.params, null);
assert.equal(imported.prompt, plan.prompt, 'declarative guidance is materialized on import');

const feedbackInputs = buildFeedbackRequest(plan, plan.baseline.params!, settled.metrics!);
plan.goal.maximumSteadyError = 99;
assert.equal(feedbackInputs.evidence.target.maximumSteadyError, 0.1, 'asynchronous AI evidence owns an immutable request snapshot');
plan.goal.maximumSteadyError = 0.1;
assert.equal(feedbackInputs.operatingGuidance.userConstraints, plan.prompt);
assert.equal(feedbackInputs.evidence.telemetryWindow, null, 'a pure legacy snapshot does not manufacture window provenance');
const observation: TelemetryEvidence = { source: 'baseline-window', configurationSignature: cascadeStageConfigurationSignature(plan).signature!,
  generation: 2, sessionId: 'device-current', epoch: 0, params: { ...plan.baseline.params! }, windowStart: 10, windowEnd: 100,
  baselineConfirmedAt: 1000, sampleCount: settled.metrics!.sampleCount };
validateFeedbackObservation(plan, plan.baseline.params!, settled.metrics!, observation);
const windowRequest = buildFeedbackRequest(plan, plan.baseline.params!, settled.metrics!, observation);
observation.params.kp = 99;
observation.windowEnd = 101;
assert.equal(windowRequest.evidence.telemetryWindow?.params.kp, plan.baseline.params!.kp, 'request owns copied observation params');
assert.equal(windowRequest.evidence.telemetryWindow?.windowEnd, 100, 'request owns copied window identity');
const validObservation = windowRequest.evidence.telemetryWindow!;
for (const bad of [null, { ...validObservation, configurationSignature: 'old' }, { ...validObservation, sampleCount: 1 },
  { ...validObservation, params: { ...validObservation.params, kp: 9 } }, { ...validObservation, windowEnd: validObservation.windowStart },
  { ...validObservation, unexpected: 'unbounded' }]) assert.throws(() => validateFeedbackObservation(plan, plan.baseline.params!, settled.metrics!, bad), /反馈窗口/);
assert.throws(() => validateFeedbackObservation(plan, plan.baseline.params!, { ...settled.metrics!, extra: 1 } as any, validObservation), /实测指标/);
await assert.rejects(() => proposeFeedbackCandidate({ config: { provider: 'ollama' } as any, plan, params: plan.baseline.params!,
  metrics: settled.metrics!, telemetryEvidence: { ...validObservation, configurationSignature: 'stale' } }), /反馈窗口/, 'stale observation is refused before network I/O');
const modelDraftRaw = {
  canModel: true, title: '单轴模型草稿', numerator: ['torque_gain'], denominator: ['axis_inertia', 'damping'], tau: '0',
  physicalFields: [{ id: 'torque_gain', label: '力矩增益', unit: 'N·m/%', required: true }, { id: 'axis_inertia', label: '轴惯量', unit: 'kg·m²', required: true, min: 0 }, { id: 'damping', label: '等效阻尼', unit: 'N·m·s/rad', required: true, min: 0 }],
  assumptions: ['单轴小角度线性化，忽略轴间耦合。'], explanation: '按用户提供惯量和力矩标定建立输入命令到角速度关系。',
};
assert.equal(parsePlantModelDraft(JSON.stringify(modelDraftRaw)).status, 'draft');
assert.throws(() => parsePlantModelDraft(JSON.stringify({ ...modelDraftRaw, physicalFields: [{ ...modelDraftRaw.physicalFields[0], default: 1 }] })), /默认值/);
assert.throws(() => parsePlantModelDraft(JSON.stringify({ ...modelDraftRaw, numerator: ['window.alert(1)'] })), /格式不受支持/);
assert.throws(() => parsePlantModelDraft(JSON.stringify({ ...modelDraftRaw, assumptions: [] })), /建模假设/);

const priorStorage = globalThis.localStorage;
assert.equal(executionSafetyStopReason({ connected: true, telemetryFresh: true, output: 5, maximumOutputMagnitude: 5 }), null);
assert.ok(executionSafetyStopReason({ connected: true, telemetryFresh: true, output: -5.01, maximumOutputMagnitude: 5 }));
assert.ok(executionSafetyStopReason({ connected: true, telemetryFresh: false, output: 0, maximumOutputMagnitude: 5 }));
assert.ok(executionSafetyStopReason({ connected: true, telemetryFresh: true, output: NaN, maximumOutputMagnitude: 5 }));
assert.ok(executionSafetyStopReason({ connected: false, telemetryFresh: true, output: 0, maximumOutputMagnitude: 5 }));
const storageValues = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => storageValues.set(key, value),
    removeItem: (key: string) => storageValues.delete(key),
  },
});
try {
  const firstSession: TuningSession = {
    id: 'first-session', plan, status: 'collecting', trials: [], bestVerified: null,
    lastConfirmed: null, startedAt: Date.now(), updatedAt: Date.now(), stopReason: null,
  };
  const secondSession: TuningSession = {
    ...firstSession, id: 'second-session', status: 'awaiting-confirmation', updatedAt: Date.now() + 1,
  };
  assert.equal(saveTuningSession(firstSession), true);
  assert.equal(saveTuningSession(secondSession), true);
  assert.equal(loadTuningSession()?.id, 'second-session', 'the newest saved session is selected on restart');
  assert.equal(loadTuningSession()?.status, 'paused', 'pending device work does not resume automatically after restart');
  assert.equal(loadTuningSession()?.plan.baseline.confirmed, false, 'saved confirmation is historical and must be rechecked on the current device');
  assert.equal(storageValues.get('llm-serial-tuning-sessions-v1')?.startsWith('['), true);
  const uprightPlan = { ...plan, suite: createScenarioContext('balance-car', 'upright-velocity', 'upright'), commandTemplate: 'INNER {kp} {kd}' };
  const velocityPlan = { ...plan, suite: createScenarioContext('balance-car', 'upright-velocity', 'velocity'), commandTemplate: 'OUTER {kp} {ki}' };
  assert.equal(saveTuningSession({ ...firstSession, id: 'inner-session', scenarioGroupId: 'cascade-A', plan: uprightPlan,
    formDraft: { modelSource: 'transfer', numerator: '1', denominator: '1,', delay: '', parameters: { kp: '2', ki: '', kd: '0.1' } } }), true);
  assert.equal(saveTuningSession({ ...firstSession, id: 'outer-session', scenarioGroupId: 'cascade-A', plan: velocityPlan }), true);
  const restoredInner = loadTuningStageSession('cascade-A', 'balance-car', 'upright-velocity', 'upright');
  assert.equal(restoredInner?.plan.commandTemplate, 'INNER {kp} {kd}', 'restoring an inner loop never substitutes an outer-loop write command');
  assert.equal(restoredInner?.formDraft?.denominator, '1,', 'incomplete editable coefficient drafts survive stage switches');
  assert.equal(restoredInner?.plan.baseline.confirmed, false, 'stage restore grants no device authority');
  assert.equal(restoredInner?.plan.suite?.modelConfirmed, false, 'restored models require review');
  assert.equal(loadTuningStageSession('cascade-B', 'balance-car', 'upright-velocity', 'upright'), null, 'a different scenario session cannot borrow stage history');
  const groupDrafts = loadTuningGroupSessions('cascade-A');
  assert.equal(groupDrafts.length, 2, 'upstream configuration reads stay within the exact scenario group');
  assert.ok(groupDrafts.every((draft) => !draft.plan.baseline.confirmed && !draft.plan.baseline.stableBaseConfirmed
    && !draft.plan.suite?.modelConfirmed && draft.lastConfirmed === null), 'configuration/history reads never recreate current device evidence');
  groupDrafts[0].plan.baseline.params!.kp = 999;
  assert.notEqual(loadTuningGroupSessions('cascade-A')[0].plan.baseline.params?.kp, 999, 'readers receive independent configuration snapshots');
  assert.equal(loadTuningGroupSessions('cascade-B').length, 0);
  const retiredTrial = { ...createCandidateRecord({ kp: 2.2, ki: .55, kd: 0 }, plan, plan.baseline.params!, '原轮次'),
    status: 'failed' as const, writeStartedAt: 1000, writeRequestId: 'retired-request', writeSessionId: 'original-device', writeEpoch: 3 };
  const newerTrial = createCandidateRecord({ kp: 2.1, ki: .52, kd: 0 }, plan, plan.baseline.params!, '新的独立候选');
  const latestDraft: TuningSession = { ...firstSession, id: 'receipt-stage', status: 'paused', trials: [newerTrial, retiredTrial],
    plan: { ...plan, prompt: '最新编辑约束', baseline: { ...plan.baseline, confirmed: false, stableBaseConfirmed: false } },
    formDraft: { modelSource: 'transfer', numerator: '2', denominator: '1,2', delay: '0', parameters: { kp: '2', ki: '.5', kd: '0' } } };
  assert.equal(saveTuningSession(latestDraft), true);
  assert.equal(saveTuningSession({ ...secondSession, id: 'current-other-stage' }), true);
  const priorRaw = JSON.parse(storageValues.get('llm-serial-tuning-sessions-v1')!);
  const receiptPatch = { status: 'failed' as const, confirmation: '停止后 written，未确认', writeRequestId: 'retired-request',
    writeSessionId: 'original-device', writeEpoch: 3, writeCompletedAt: 2000,
    writeRxDispatch: { source: 'serial-read' as const, session_id: 'original-device', epoch: 3, rx_sequence: 12 } };
  assert.equal(updateTuningTrialReceipt('receipt-stage', retiredTrial.id, receiptPatch), true);
  const mergedRaw = JSON.parse(storageValues.get('llm-serial-tuning-sessions-v1')!);
  const merged: TuningSession = mergedRaw.find((value: TuningSession) => value.id === 'receipt-stage');
  assert.equal(merged.plan.prompt, latestDraft.plan.prompt, 'late receipt preserves latest edited plan');
  assert.deepEqual(merged.formDraft, latestDraft.formDraft, 'late receipt preserves latest editable form');
  assert.deepEqual(merged.trials[0], newerTrial, 'late receipt preserves new independent trials');
  assert.equal(merged.trials[1].writeCompletedAt, 2000, 'original trial gets its driver completion fact');
  assert.equal(merged.plan.baseline.confirmed, false, 'receipt never restores device authority');
  assert.deepEqual(mergedRaw[0], priorRaw[0], 'other active stage and list order remain unchanged');
  const rawAfterReceipt = storageValues.get('llm-serial-tuning-sessions-v1');
  for (const invalid of [
    { ...receiptPatch, writeRequestId: {} }, { ...receiptPatch, writeRequestId: ' ' }, { ...receiptPatch, writeSessionId: 'x'.repeat(161) },
    { ...receiptPatch, writeRequestId: 'different-request' }, { ...receiptPatch, writeSessionId: 'different-device' },
    { ...receiptPatch, writeEpoch: 4 }, { ...receiptPatch, status: 'confirmed' }, { ...receiptPatch, baseline: { confirmed: true } },
    { ...receiptPatch, writeRxDispatch: { ...receiptPatch.writeRxDispatch, source: 'synthetic' } },
    { ...receiptPatch, writeRxDispatch: { ...receiptPatch.writeRxDispatch, rx_sequence: -1 } },
    { ...receiptPatch, writeRxDispatch: { ...receiptPatch.writeRxDispatch, rx_sequence: 1.5 } },
    { ...receiptPatch, writeRxDispatch: { ...receiptPatch.writeRxDispatch, extra: true } },
  ]) {
    assert.equal(updateTuningTrialReceipt('receipt-stage', retiredTrial.id, invalid as any), false);
    assert.equal(storageValues.get('llm-serial-tuning-sessions-v1'), rawAfterReceipt, 'rejected receipt cannot modify storage');
  }
  const evaluated = { ...merged, status: 'completed' as const, bestVerified: { ...retiredTrial.candidate },
    trials: [{ ...merged.trials[1], status: 'evaluated' as const }, merged.trials[0]] };
  assert.equal(saveTuningSession(evaluated), true);
  const completedRaw = storageValues.get('llm-serial-tuning-sessions-v1');
  assert.equal(updateTuningTrialReceipt('receipt-stage', retiredTrial.id, { ...receiptPatch, writeCompletedAt: 3000 }), true);
  assert.equal(storageValues.get('llm-serial-tuning-sessions-v1'), completedRaw, 'duplicate written preserves evaluated state and bestVerified exactly');
  console.log('迟到回执按最新trial合并：配置/表单/新trial/其他stage保留，12项非法身份拒绝，evaluated重复written幂等通过。');
  storageValues.set('llm-serial-tuning-sessions-v1', JSON.stringify(firstSession));
  assert.equal(loadTuningSession()?.id, 'first-session', 'legacy single-session drafts remain readable');
  storageValues.set('llm-serial-tuning-sessions-v1', JSON.stringify({ ...firstSession, plan: { ...plan, channels: null } }));
  assert.equal(loadTuningSession(), null, 'malformed stored plans never reach Vue hydration');
} finally {
  if (priorStorage) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: priorStorage });
  else delete (globalThis as { localStorage?: Storage }).localStorage;
}

console.log('调参计划预检、候选约束、目标评价、回读确认、会话恢复与声明式套件检查通过。');
const { runStepResponseTests } = await import('./tuning-step-response.test.ts');
runStepResponseTests(createValidPlan());
