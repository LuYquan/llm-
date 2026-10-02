import assert from 'node:assert/strict';
import {
  buildCascadeDependencySnapshot,
  cascadeStageConfigurationSignature,
  checkCascadeDependencySnapshot,
  checkCascadeDeviceDependencies,
  isCascadeDependencySnapshot,
} from '../src/core/tuning/cascadeDependencies.ts';
import type { CascadeDependencyInput, CascadeDependencySnapshot, CascadeRuntimeEvidence } from '../src/core/tuning/cascadeDependencies';
import { createScenarioContext } from '../src/core/tuning/scenarios.ts';
import type { ScenarioStage, TuningScenarioId } from '../src/core/tuning/scenarios';
import type { TuningPlan, TuningSession } from '../src/core/tuning/types';

let cases = 0;
function check(name: string, verify: () => void) { verify(); cases++; console.log('  cascade dependencies: ' + name); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
const groupId = 'group-one';
const stages: ScenarioStage[] = ['inner', 'middle', 'outer'].map((id, index) => ({ id, title: `环 ${index + 1}`, structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] }));

function makePlan(stage: string, order: readonly ScenarioStage[] = stages, scenario: TuningScenarioId = 'custom', topology = 'cascade'): TuningPlan {
  const context = createScenarioContext(scenario, topology, stage, scenario === 'custom' ? clone([...order]) : undefined);
  context.modelOrigin = 'user-transfer-function';
  const structure = scenario === 'custom' ? order.find(entry => entry.id === stage)!.structure : stage === 'rate' ? 'PID' : 'P';
  return {
    id: 'plan-' + stage, version: 1, name: '调参 ' + stage, project: 'project', description: '', prompt: '',
    route: 'model', mode: 'manual', loopId: stage, structure, controlDirection: 'direct', sampleTimeSeconds: 0.001,
    commandTemplate: 'SET:' + stage + ':{kp},{ki},{kd}',
    baseline: { params: { kp: 1, ki: structure === 'P' || structure === 'PD' ? 0 : 0.2, kd: structure === 'PID' || structure === 'PD' ? 0.01 : 0 }, source: 'manual', confirmed: true, stableBaseConfirmed: true },
    bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 10 }, kd: { min: 0, max: 10 } },
    maxParameterChangePercent: 10, maximumTrials: 5, evaluationWindowSeconds: 1, maximumTelemetryAgeSeconds: 0.1, maximumOutputMagnitude: 5,
    channels: { setpoint: stage + '.r', feedback: stage + '.y', output: stage + '.u', parameters: { kp: stage + '.kp', ki: stage + '.ki', kd: stage + '.kd' } },
    units: { setpoint: 'rad/s', feedback: 'rad/s', output: 'V', parameters: { kp: 'V/(rad/s)', ki: 'V/rad', kd: 'V*s²/rad' } },
    confirmation: { mode: 'parameter-channels', acknowledgementText: '', timeoutSeconds: 1, parameterTolerance: 0.1 },
    goal: { mode: 'settle', maximumSteadyError: 0.1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: 60, targetCrossoverRadPerSec: 10 },
    model: { family: 'fopdt', k: 1, t: 0.1, tau: 0 }, suite: context,
  };
}

function makeSession(plan: TuningPlan, sessionGroup = groupId): TuningSession {
  return { id: 'session-' + plan.loopId, scenarioGroupId: sessionGroup, plan, status: 'completed', trials: [], bestVerified: null,
    lastConfirmed: null, startedAt: null, updatedAt: 10, stopReason: null };
}

function fixture(count = 3): CascadeDependencyInput {
  const selected = stages.slice(0, count);
  return { groupId, plan: makePlan(selected[count - 1].id, selected), sessions: selected.map(entry => makeSession(makePlan(entry.id, selected))) };
}

function bind(input: CascadeDependencyInput): CascadeDependencySnapshot {
  const built = buildCascadeDependencySnapshot(input);
  assert.equal(built.ready, true, built.issues.join(' '));
  assert.ok(built.snapshot);
  return built.snapshot;
}

function deviceProofs(binding: CascadeDependencySnapshot, generation = 7): Map<string, CascadeRuntimeEvidence> {
  return new Map(binding.dependencies.map(entry => [entry.sessionId, { groupId: binding.groupId, sessionId: entry.sessionId,
    scenarioId: binding.scenarioId, topologyId: binding.topologyId, stageId: entry.stageId, configSignature: entry.configSignature,
    generation, trialId: 'trial-' + entry.stageId }]));
}

check('three-stage binding includes every inner stage in physical order', () => {
  const input = fixture();
  input.sessions.reverse();
  const snapshot = bind(input);
  assert.deepEqual(snapshot.dependencies.map(entry => entry.stageId), ['inner', 'middle']);
  assert.deepEqual(snapshot.stages.map(entry => entry.id), ['inner', 'middle', 'outer']);
  assert.equal(isCascadeDependencySnapshot(snapshot), true);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot: snapshot }).ready, true);
});

check('two-stage binding includes exactly the direct inner stage', () => {
  assert.deepEqual(bind(fixture(2)).dependencies.map(entry => entry.stageId), ['inner']);
});

check('single and innermost loops do not require artificial dependencies', () => {
  const single = makePlan('inner', stages.slice(0, 1), 'custom', 'single');
  assert.deepEqual(buildCascadeDependencySnapshot({ plan: single, groupId, sessions: [] }), { ready: true, snapshot: null, issues: [] });
  assert.equal(buildCascadeDependencySnapshot({ ...fixture(), plan: makePlan('inner') }).ready, true);
  const ordinary = makePlan('inner');
  delete ordinary.suite;
  assert.equal(checkCascadeDeviceDependencies({ plan: ordinary, groupId, sessions: [], generation: -1, evidence: new Map() }).ready, true);
});

check('preset stages come from the real suite rather than caller-invented order', () => {
  const rate = makePlan('rate', [], 'flight-control', 'rate-attitude');
  const attitude = makePlan('attitude', [], 'flight-control', 'rate-attitude');
  const input = { plan: attitude, groupId, sessions: [makeSession(rate)] };
  assert.deepEqual(bind(input).dependencies.map(entry => entry.stageId), ['rate']);
  input.plan.suite!.customStages = clone(stages);
  assert.equal(buildCascadeDependencySnapshot(input).ready, false);
});

check('an outer model must be explicitly bound before it can be reused', () => {
  const result = checkCascadeDependencySnapshot(fixture());
  assert.equal(result.ready, false);
  assert.ok(result.issues.some(issue => issue.includes('尚未绑定')));
  assert.ok(result.snapshot);
});

check('no saved inner configuration is invented from the outer form', () => {
  const result = buildCascadeDependencySnapshot({ ...fixture(), sessions: [] });
  assert.equal(result.ready, false);
  assert.equal(result.snapshot, null);
  assert.ok(result.issues.some(issue => issue.includes('inner') || issue.includes('环 1')));
});

check('same stage from another group, scene or topology cannot supply the dependency', () => {
  for (const change of [
    (session: TuningSession) => { session.scenarioGroupId = 'different-group'; },
    (session: TuningSession) => { session.plan.suite!.id = 'flight-control'; },
    (session: TuningSession) => { session.plan.suite!.topologyId = 'single'; },
  ]) {
    const input = fixture(2);
    change(input.sessions[0]);
    assert.equal(buildCascadeDependencySnapshot(input).ready, false);
  }
});

check('duplicate source sessions fail instead of silently selecting newest', () => {
  const input = fixture(2);
  input.sessions = [...input.sessions, { ...input.sessions[0], id: 'different-session' }];
  assert.equal(buildCascadeDependencySnapshot(input).ready, false);
});

check('a different source session requires explicit rebinding even for same configuration', () => {
  const input = fixture(2), boundSnapshot = bind(input);
  input.sessions[0].id = 'replacement-inner-session';
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, false);
});

check('all materially changed inner inputs invalidate the saved outer binding', () => {
  const mutations: Array<(plan: TuningPlan) => void> = [
    plan => { plan.baseline.params!.kp += 1e-12; },
    plan => { plan.model = { family: 'fopdt', k: 1.2, t: 0.1, tau: 0 }; },
    plan => { plan.sampleTimeSeconds = 0.002; },
    plan => { plan.controlDirection = 'reverse'; },
    plan => { plan.channels.feedback = 'another-feedback'; },
    plan => { plan.units.output = 'PWM'; },
    plan => { plan.commandTemplate = 'OTHER:{kp},{ki},{kd}'; },
    plan => { plan.suite!.physicalInputs.new_mass = 2; },
    plan => { plan.suite!.prompt += ' changed constraints'; },
    plan => { plan.goal.maximumSteadyError = 0.2; },
    plan => { plan.bounds.kp!.max = 20; },
  ];
  for (const mutate of mutations) {
    const input = fixture(), boundSnapshot = bind(input);
    mutate(input.sessions[0].plan);
    const result = checkCascadeDependencySnapshot({ ...input, boundSnapshot });
    assert.equal(result.ready, false, mutate.toString());
  }
});

check('changing middle parameters also invalidates a three-stage outer binding', () => {
  const input = fixture(), boundSnapshot = bind(input);
  input.sessions[1].plan.baseline.params!.ki = 0.3;
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, false);
});

check('restoring attestation flags and historic trials does not change configuration identity', () => {
  const input = fixture(), boundSnapshot = bind(input);
  for (const session of input.sessions) {
    session.plan.baseline.confirmed = false;
    session.plan.baseline.stableBaseConfirmed = false;
    session.plan.baseline.source = 'parameter-channels';
    session.plan.suite!.modelConfirmed = false;
    session.lastConfirmed = { params: { kp: 9, ki: 9, kd: 9 }, at: 100, mode: 'manual' };
    session.trials.push({ id: 'historic', createdAt: 5, status: 'evaluated', before: { kp: 1, ki: 0.2, kd: 0 }, candidate: { kp: 9, ki: 9, kd: 9 }, note: 'history' });
  }
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, true);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence: new Map() }).ready, false);
});

check('baseline params rather than lastConfirmed or bestVerified determine identity', () => {
  const input = fixture(2), boundSnapshot = bind(input);
  input.sessions[0].bestVerified = { kp: 5, ki: 5, kd: 5 };
  input.sessions[0].lastConfirmed = { params: { kp: 5, ki: 5, kd: 5 }, at: 100, mode: 'manual' };
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, true);
  input.sessions[0].plan.baseline.params!.kp = 5;
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, false);
});

check('object key insertion order and same-value edits do not cause false invalidation', () => {
  const input = fixture(2), boundSnapshot = bind(input);
  const before = input.sessions[0].plan;
  input.sessions[0].plan = Object.fromEntries(Object.entries(before).reverse()) as unknown as TuningPlan;
  input.sessions[0].plan.baseline.params = { kd: 0, ki: 0.2, kp: 1 };
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, true);
});

check('binding itself cannot create recursive configuration identity', () => {
  const input = fixture(), signature = cascadeStageConfigurationSignature(input.sessions[1].plan).signature;
  (input.sessions[1].plan as TuningPlan & { cascadeBinding: unknown }).cascadeBinding = { arbitrary: 'old binding', nested: [bind(input)] };
  assert.equal(cascadeStageConfigurationSignature(input.sessions[1].plan).signature, signature);
});

check('changing custom order or declared structure requires a fresh binding', () => {
  for (const kind of ['order', 'structure']) {
    const input = fixture(), boundSnapshot = bind(input);
    for (const plan of [input.plan, ...input.sessions.map(session => session.plan)]) {
      if (kind === 'order') [plan.suite!.customStages![0], plan.suite!.customStages![1]] = [plan.suite!.customStages![1], plan.suite!.customStages![0]];
      else {
        plan.suite!.customStages![0].structure = 'P';
        if (plan.loopId === 'inner') { plan.structure = 'P'; plan.baseline.params!.ki = 0; }
      }
    }
    assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, false);
  }
});

check('different topology definitions within the same group are rejected', () => {
  const input = fixture();
  input.sessions[0].plan.suite!.customStages!.reverse();
  assert.equal(buildCascadeDependencySnapshot(input).ready, false);
});

check('invalid topology, duplicate IDs and stage mismatch cannot fall back to first', () => {
  const mutations: Array<(plan: TuningPlan) => void> = [
    plan => { plan.suite!.topologyId = 'nonexistent'; },
    plan => { plan.suite!.stageId = 'nonexistent'; },
    plan => { plan.loopId = 'different'; },
    plan => { plan.suite!.customStages![1].id = 'inner'; },
    plan => { plan.suite!.customStages![0].id = '!invalid'; },
    plan => { plan.suite!.customStages = undefined; },
    plan => { plan.suite!.customStages![0].supportedStructures = ['PI', 'PI']; },
    plan => { plan.suite!.customStages = [null] as unknown as ScenarioStage[]; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input.plan);
    assert.equal(buildCascadeDependencySnapshot(input).ready, false);
  }
});

check('incomplete inner parameters, period, units, model or invalid provided bounds fail explicitly', () => {
  const mutations: Array<(plan: TuningPlan) => void> = [
    plan => { plan.baseline.params = null; }, plan => { plan.sampleTimeSeconds = null; },
    plan => { plan.units.output = ''; }, plan => { plan.units.parameters.ki = ''; },
    plan => { plan.units.feedback = 'degrees'; },
    plan => { plan.controlDirection = null; }, plan => { plan.bounds.ki = { min: 2, max: 1 }; },
    plan => { plan.baseline.params!.kp = Infinity; }, plan => { plan.model = null; },
  ];
  for (const mutate of mutations) {
    const input = fixture(2); mutate(input.sessions[0].plan);
    const result = buildCascadeDependencySnapshot(input);
    assert.equal(result.ready, false); assert.ok(result.issues.length);
  }
});

check('offline binding does not require unused serial commands, live channel names or write bounds', () => {
  const input = fixture(2);
  input.sessions[0].plan.commandTemplate = '';
  input.sessions[0].plan.channels = { setpoint: '', feedback: '', output: '', parameters: {} };
  input.sessions[0].plan.bounds = { kp: null, ki: null, kd: null };
  const boundSnapshot = bind(input);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, true);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence: new Map() }).ready, false);
});

check('adding a future outer stage can rebind without rewriting saved inner stage graphs', () => {
  const prior = fixture(2);
  const oldBinding = bind(prior);
  const input = { ...fixture(), sessions: prior.sessions };
  const rebound = bind(input);
  assert.deepEqual(rebound.dependencies.map(entry => entry.stageId), ['inner', 'middle']);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot: oldBinding }).ready, false);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot: rebound }).ready, true);
});

check('changing only future structure does not change an inner configuration signature', () => {
  const input = fixture(), oldBinding = bind(input);
  const inner = input.sessions[0].plan;
  const originalSignature = cascadeStageConfigurationSignature(inner).signature;
  inner.suite!.customStages![2].structure = 'P';
  assert.equal(cascadeStageConfigurationSignature(inner).signature, originalSignature);
  input.plan.suite!.customStages![2].structure = 'P';
  input.plan.structure = 'P';
  input.plan.baseline.params!.ki = 0;
  const rebound = bind(input);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot: oldBinding }).ready, false);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot: rebound }).ready, true);
});

check('feedback-only inner configuration can be bound without inventing a model', () => {
  const input = fixture(2);
  input.sessions[0].plan.route = 'feedback';
  input.sessions[0].plan.model = null;
  input.sessions[0].plan.suite!.modelOrigin = 'pending';
  assert.equal(buildCascadeDependencySnapshot(input).ready, true);
});

check('physical or AI model routes cannot bind unresolved required inputs', () => {
  const input = fixture(2);
  input.sessions[0].plan.suite!.modelOrigin = 'ai-proposal';
  assert.equal(buildCascadeDependencySnapshot(input).ready, false);
  input.sessions[0].plan.suite!.modelDraft = { numerator: ['mass'], denominator: ['1', '1'], tau: '0', assumptions: [], physicalFields: [{ id: 'mass', label: '质量', unit: 'kg', required: true, min: 0.1 }] };
  assert.equal(buildCascadeDependencySnapshot(input).ready, false);
  input.sessions[0].plan.suite!.physicalInputs.mass = 1;
  assert.equal(buildCascadeDependencySnapshot(input).ready, true);
});

check('current-page evidence for every inner stage enables the device gate', () => {
  const input = fixture(), boundSnapshot = bind(input), evidence = deviceProofs(boundSnapshot);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence }).ready, true);
  evidence.delete(boundSnapshot.dependencies[1].sessionId);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence }).ready, false);
});

check('runtime identity mismatches cannot authorize the device gate', () => {
  const mutations: Array<(proof: CascadeRuntimeEvidence) => void> = [
    proof => { proof.groupId = 'wrong'; }, proof => { proof.sessionId = 'wrong'; },
    proof => { proof.stageId = 'wrong'; }, proof => { proof.scenarioId = 'flight-control'; },
    proof => { proof.topologyId = 'single'; }, proof => { proof.configSignature += 'changed'; },
    proof => { proof.generation = 6; }, proof => { proof.trialId = ''; },
  ];
  for (const mutate of mutations) {
    const input = fixture(2), boundSnapshot = bind(input), evidence = deviceProofs(boundSnapshot);
    mutate(evidence.get(boundSnapshot.dependencies[0].sessionId)!);
    assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence }).ready, false);
  }
});

check('reconnection clears authority even when saved configuration is unchanged', () => {
  const input = fixture(), boundSnapshot = bind(input), evidence = deviceProofs(boundSnapshot);
  assert.equal(checkCascadeDependencySnapshot({ ...input, boundSnapshot }).ready, true);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 8, evidence }).ready, false);
  evidence.clear();
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence }).ready, false);
});

check('changed inner configuration invalidates both offline binding and runtime proof', () => {
  const input = fixture(), boundSnapshot = bind(input), evidence = deviceProofs(boundSnapshot);
  input.sessions[0].plan.baseline.params!.kp = 1.5;
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence }).ready, false);
  const rebound = bind(input);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot: rebound, generation: 7, evidence }).ready, false);
});

check('serialized or fake map evidence does not become current-page authority', () => {
  const input = fixture(2), boundSnapshot = bind(input);
  const evidence = Object.fromEntries(deviceProofs(boundSnapshot));
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: 7, evidence: evidence as unknown as Map<string, CascadeRuntimeEvidence> }).ready, false);
  assert.equal(checkCascadeDeviceDependencies({ ...input, boundSnapshot, generation: NaN, evidence: deviceProofs(boundSnapshot) }).ready, false);
});

check('saved bindings have a bounded strict schema and ordered unique prefix', () => {
  const valid = bind(fixture());
  const variants = [
    { ...valid, version: 2 }, { ...valid, extra: true }, { ...valid, groupId: '' },
    { ...valid, topologyId: 'bad topology' }, { ...valid, targetStageId: 'missing' },
    { ...valid, stages: [valid.stages[0], valid.stages[0], valid.stages[2]] },
    { ...valid, stages: Array.from({ length: 7 }, (_, index) => ({ id: 'loop' + index, structure: 'PI' })) },
    { ...valid, dependencies: [...valid.dependencies].reverse() },
    { ...valid, dependencies: valid.dependencies.slice(0, 1) },
    { ...valid, dependencies: valid.dependencies.map(entry => ({ ...entry, sessionId: 'same' })) },
    { ...valid, dependencies: [{ ...valid.dependencies[0], configSignature: 'x'.repeat(262_145) }, valid.dependencies[1]] },
    { ...valid, dependencies: [{ ...valid.dependencies[0], configSignature: Infinity }, valid.dependencies[1]] },
  ];
  assert.equal(isCascadeDependencySnapshot(valid), true);
  for (const variant of variants) assert.equal(isCascadeDependencySnapshot(variant), false);
  assert.equal(isCascadeDependencySnapshot(null), false);
});

check('unrepresentable configuration data produces an issue instead of a comparison match', () => {
  const input = fixture(2);
  input.sessions[0].plan.suite!.physicalInputs.invalid = NaN;
  const result = buildCascadeDependencySnapshot(input);
  assert.equal(result.ready, false);
  assert.ok(result.issues.some(issue => issue.includes('非有限')));
});

console.log('Cascade dependency regression: ' + cases + ' cases passed.');
