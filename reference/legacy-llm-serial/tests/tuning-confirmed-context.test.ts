import assert from 'node:assert/strict';
import { confirmedTrialContextFailure } from '../src/core/tuning/flow';
import type { TuningPlan, TuningTrial } from '../src/core/tuning/types';

type ConfirmedContext = Parameters<typeof confirmedTrialContextFailure>[0];

function context(): ConfirmedContext {
  const candidate = { kp: 2, ki: 0.5, kd: 0.1 };
  const plan: TuningPlan = {
    id: 'current-plan', version: 1, name: '当前评价', project: '台架', description: '', prompt: '',
    route: 'feedback', mode: 'bounded-auto', loopId: 'inner', structure: 'PID', controlDirection: 'direct',
    sampleTimeSeconds: 0.001, commandTemplate: 'PID,{request_id},{kp},{ki},{kd}',
    baseline: { params: { ...candidate }, source: 'parameter-channels', confirmed: true, stableBaseConfirmed: true },
    bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 10 }, kd: { min: 0, max: 10 } },
    maxParameterChangePercent: 10, maximumTrials: 5, evaluationWindowSeconds: 2,
    maximumTelemetryAgeSeconds: 0.2, maximumOutputMagnitude: 10,
    channels: { setpoint: 'r', feedback: 'y', output: 'u', parameters: { kp: 'kp', ki: 'ki', kd: 'kd' } },
    units: { setpoint: 'rad/s', feedback: 'rad/s', output: 'V', parameters: { kp: 'V/(rad/s)', ki: 'V/rad', kd: 'V/(rad/s²)' } },
    confirmation: { mode: 'parameter-channels', acknowledgementText: '', timeoutSeconds: 1, parameterTolerance: 1e-6 },
    goal: { mode: 'settle', maximumSteadyError: 0.1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null },
    model: null,
  };
  const trial: TuningTrial = {
    id: 'trial-current', protocolRequestId: 'protocol-current', createdAt: 90,
    status: 'confirmed', before: { kp: 1.9, ki: 0.49, kd: 0.1 }, candidate: { ...candidate }, note: '',
    writeRequestId: 'transport-write-current', writeSessionId: 'device-session-current', writeEpoch: 7,
    writeCompletedAt: 100, sourceChannelGeneration: 12, writeChannelGeneration: 12, confirmationMode: 'parameter-channels',
  };
  return {
    trial, plan, lastConfirmed: { params: { ...candidate }, mode: 'parameter-channels', at: 101 },
    generation: 12, sessionContext: { sessionId: 'device-session-current', epoch: 7 },
    authorizedScopeMatches: true, working: true, stopped: false, connected: true, executionEnabled: true,
  };
}

export async function runTuningConfirmedContextTests(): Promise<void> {
  let checked = 0;
  for (const status of ['confirmed', 'evaluated'] as const) {
    const input = context();
    input.trial.status = status;
    assert.equal(confirmedTrialContextFailure(input), null, `${status}: the current confirmed device context may be evaluated`);
    checked++;
  }
  const sameMoment = context();
  sameMoment.lastConfirmed!.at = sameMoment.trial.writeCompletedAt!;
  assert.equal(confirmedTrialContextFailure(sameMoment), null, 'confirmation at the exact driver completion timestamp is allowed');
  checked++;

  const mutations: Array<[string, (input: ConfirmedContext) => void]> = [
    ['authorization revoked', input => { input.authorizedScopeMatches = false; }],
    ['worker ceased', input => { input.working = false; }],
    ['stop requested', input => { input.stopped = true; }],
    ['connection lost', input => { input.connected = false; }],
    ['execution permission disabled', input => { input.executionEnabled = false; }],
    ['baseline attestation cleared', input => { input.plan.baseline.confirmed = false; }],
    ['baseline params absent', input => { input.plan.baseline.params = null; }],
    ['last confirmed record absent', input => { input.lastConfirmed = null; }],
    ['last confirmation older than driver write', input => { input.lastConfirmed!.at = input.trial.writeCompletedAt! - 1; }],
    ['last confirmation timestamp nonfinite', input => { input.lastConfirmed!.at = NaN; }],
    ['current generation changed', input => { input.generation += 1; }],
    ['current generation fractional', input => { input.generation = 12.5; }],
    ['current generation negative', input => { input.generation = -1; }],
    ['current generation missing numeric identity', input => { input.generation = NaN; }],
    ['proposal generation changed', input => { input.trial.sourceChannelGeneration = input.trial.sourceChannelGeneration! - 1; }],
    ['driver generation changed', input => { input.trial.writeChannelGeneration = input.trial.writeChannelGeneration! - 1; }],
    ['current device session replaced', input => { input.sessionContext.sessionId = 'device-session-other'; }],
    ['current device session missing', input => { input.sessionContext.sessionId = null; }],
    ['current epoch advanced', input => { input.sessionContext.epoch = 8; }],
    ['current epoch missing', input => { input.sessionContext.epoch = null; }],
    ['current epoch fractional', input => { input.sessionContext.epoch = 7.5; }],
    ['negative matching epoch', input => { input.sessionContext.epoch = -1; input.trial.writeEpoch = -1; }],
    ['negative write timestamp', input => { input.trial.writeCompletedAt = -1; }],
    ['confirmation mode mismatch', input => { input.trial.confirmationMode = 'manual'; }],
    ['driver epoch from other parse context', input => { input.trial.writeEpoch = 6; }],
    ['historical request identity absent', input => { delete input.trial.writeRequestId; }],
    ['historical request identity empty', input => { input.trial.writeRequestId = ''; }],
    ['historical write timestamp absent', input => { delete input.trial.writeCompletedAt; }],
    ['historical write timestamp nonfinite', input => { input.trial.writeCompletedAt = Infinity; }],
    ['historical proposal generation absent', input => { delete input.trial.sourceChannelGeneration; }],
    ['historical driver generation absent', input => { delete input.trial.writeChannelGeneration; }],
    ['historical device session absent', input => { delete input.trial.writeSessionId; }],
    ['historical epoch absent', input => { delete input.trial.writeEpoch; }],
  ];
  for (const key of ['kp', 'ki', 'kd'] as const) {
    mutations.push(
      [`${key}: baseline drift`, input => { input.plan.baseline.params![key] += 0.0000001; }],
      [`${key}: last confirmed drift`, input => { input.lastConfirmed!.params[key] += 0.0000001; }],
      [`${key}: candidate replaced`, input => { input.trial.candidate[key] += 0.0000001; }],
      [`${key}: candidate nonfinite`, input => { input.trial.candidate[key] = NaN; }],
    );
  }
  for (const status of ['proposed', 'queued', 'sent', 'failed', 'rejected'] as const) {
    mutations.push([`${status}: no confirmed trial`, input => { input.trial.status = status; }]);
  }

  // These checks deliberately run after one final asynchronous boundary. A
  // previously good context must not be reused when the wait resumes.
  for (const [label, mutate] of mutations) {
    const input = context();
    assert.equal(confirmedTrialContextFailure(input), null, `${label}: valid before the last await`);
    await Promise.resolve().then(() => mutate(input));
    assert.equal(typeof confirmedTrialContextFailure(input), 'string', `${label}: stale context refused after the last await`);
    checked++;
  }

  const immutable = context();
  const original = JSON.stringify(immutable);
  Object.freeze(immutable.trial.candidate); Object.freeze(immutable.trial);
  Object.freeze(immutable.plan.baseline.params!); Object.freeze(immutable.plan.baseline); Object.freeze(immutable.plan);
  Object.freeze(immutable.lastConfirmed!.params); Object.freeze(immutable.lastConfirmed!);
  Object.freeze(immutable.sessionContext); Object.freeze(immutable);
  assert.equal(confirmedTrialContextFailure(immutable), null, 'read-only check accepts frozen current inputs');
  assert.equal(JSON.stringify(immutable), original, 'checking confirmation never changes the trial, baseline or evidence');
  checked++;
  console.log(`✓ 最后等待后的设备确认上下文测试通过（${checked} 项）：授权、基线、PID、generation/session/epoch、停止与执行权限。`);
}

await runTuningConfirmedContextTests();
