import assert from 'node:assert/strict';
import { proposeFeedbackCandidate, proposePlantModelDraft } from '../src/services/tuningAgent';
import { cascadeStageConfigurationSignature } from '../src/core/tuning/cascadeDependencies';
import type { TuningPlan, TuningMetrics } from '../src/core/tuning/types';
import type { TelemetryEvidence } from '../src/core/tuning/feedbackEvidence';
import type { AiConfig } from '../src/services/ai';

const plan: TuningPlan = {
  id: 'agent-config-fixture', version: 1, name: '合成 PI', project: '合成', description: '不代表设备', prompt: '',
  route: 'feedback', mode: 'manual', loopId: 'speed', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .01,
  commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
  baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: true, stableBaseConfirmed: false },
  bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } }, maxParameterChangePercent: 20,
  maximumTrials: 2, evaluationWindowSeconds: 1, maximumTelemetryAgeSeconds: .5, maximumOutputMagnitude: 10,
  channels: { setpoint: 'sp', feedback: 'fb', output: 'out', parameters: {} },
  units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
  confirmation: { mode: 'manual', acknowledgementText: '', timeoutSeconds: null, parameterTolerance: null },
  goal: { mode: 'settle', maximumSteadyError: .1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null }, model: null,
};
const metrics: TuningMetrics = { steadyError: .2, peakError: .2, rmsTrackingError: .2, overshootPercent: null, maximumOutputMagnitude: 1, sampleCount: 10 };
const evidence: TelemetryEvidence = { source: 'baseline-window', configurationSignature: cascadeStageConfigurationSignature(plan).signature!,
  generation: 1, sessionId: 'synthetic', epoch: 1, params: { ...plan.baseline.params! }, windowStart: 1, windowEnd: 10,
  baselineConfirmedAt: 1000, sampleCount: 10 };
const draft = { canModel: true, title: '合成模型', numerator: ['1'], denominator: ['1', '1'], tau: '0', physicalFields: [], assumptions: ['合成线性模型'], explanation: '只验证函数行为。' };
const originalFetch = globalThis.fetch;
let calls = 0;
let hold: Promise<void> | null = null;
const configs = ['http://127.0.0.1:12345/v1', 'http://localhost:12345/v1', 'http://[::1]:12345/v1'].map(api_url => ({ provider: 'custom', api_url, model: 'synthetic', api_key: '' } as AiConfig));
const remote = { provider: 'custom', api_url: 'https://example.invalid/v1', model: 'synthetic', api_key: '' } as AiConfig;
try {
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assert.equal((init?.headers as Record<string, string>)?.Authorization, undefined);
    const state = JSON.parse(JSON.parse(String(init?.body)).messages.find((message: { role: string }) => message.role === 'user').content);
    if (hold) await hold; // Deliberately ignore AbortSignal, as a late backend might.
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(state.evidence
      ? { canRecommend: true, params: { kp: 2.2, ki: .55, kd: 0 }, rationale: '合成候选' } : draft) } }] }), { status: 200 });
  };
  for (const config of configs) {
    assert.equal((await proposePlantModelDraft({ config, description: '合成描述' })).title, draft.title);
    const candidate = await proposeFeedbackCandidate({ config, plan, params: plan.baseline.params!, metrics, telemetryEvidence: evidence });
    assert.equal(candidate.proposal.params.kp, 2.2);
  }
  const beforeRemote = calls;
  await assert.rejects(proposePlantModelDraft({ config: remote, description: '合成描述' }), /API Key/);
  await assert.rejects(proposeFeedbackCandidate({ config: remote, plan, params: plan.baseline.params!, metrics, telemetryEvidence: evidence }), /API Key/);
  assert.equal(calls, beforeRemote, 'remote no-key refusal precedes any network call');
  for (const kind of ['model', 'feedback'] as const) {
    let release!: () => void;
    hold = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const request = kind === 'model'
      ? proposePlantModelDraft({ config: configs[0], description: '合成描述', signal: controller.signal })
      : proposeFeedbackCandidate({ config: configs[0], plan, params: plan.baseline.params!, metrics, telemetryEvidence: evidence, signal: controller.signal });
    controller.abort(); release();
    await assert.rejects(request, error => error instanceof DOMException && error.name === 'AbortError');
    hold = null;
  }
  console.log('tuning-agent config: local custom IPv4/hostname/IPv6 model+feedback allowed, remote custom no-key refused, two late completions cancelled; 10 checks passed; no real network/AI/device.');
} finally { globalThis.fetch = originalFetch; }
