import '../../src/style.css';
import { createApp, h, nextTick, reactive } from 'vue';
import type { App } from 'vue';
import TuningWorkbench from '../../src/components/TuningWorkbench.vue';
import { globalChannelStore } from '../../src/core/channel/ChannelStore';
import { globalProjectModel } from '../../src/core/project/ProjectModel';
import { ProtocolEngine } from '../../src/core/protocol/ProtocolEngine';
import { createScenarioContext } from '../../src/core/tuning/scenarios';
import { loadTuningSession, saveTuningSession } from '../../src/core/tuning/sessionStore';
import type { TuningPlan, TuningSession } from '../../src/core/tuning/types';
import type { AiConfig } from '../../src/services/ai';

if (location.hostname !== '127.0.0.1' || location.port !== '5196') throw new Error('Step fixture requires isolated localhost:5196.');
type CaseId = 'offline' | 'valid' | 'legacy' | 'repeated' | 'ramp' | 'unsettled' | 'output' | 'track';
const host = document.querySelector<HTMLElement>('#component-host')!;
const selection = document.querySelector<HTMLSelectElement>('#fixture-case')!;
const status = document.querySelector<HTMLElement>('#fixture-status')!;
const proof = document.querySelector<HTMLElement>('#proof-json')!;
let app: App | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let parser = new ProtocolEngine('firewater');
let tick = 0;
let run = 0;
let currentCase: CaseId = 'valid';
let model = '';
let held = { target: 0, feedback: 0, output: 1 };
let windowAdded = false;
let writes = 0;
let events: Array<{ at: number; event: string; detail?: unknown }> = [];
const record = (event: string, detail?: unknown) => events.push({ at: Date.now(), event, ...(detail === undefined ? {} : { detail }) });
function ingest(target: number, feedback: number, output: number) {
  tick++;
  globalChannelStore.pushProtocolOutput(parser.feed(new TextEncoder().encode(`${target},${feedback},${output}\n`), tick * 10_000));
}
async function prepare() {
  if (timer) clearInterval(timer);
  app?.unmount();
  currentCase = selection.value as CaseId;
  run++; tick = 0; writes = 0; events = []; windowAdded = false; held = { target: 0, feedback: 0, output: 1 };
  parser = new ProtocolEngine('firewater');
  globalChannelStore.clear();
  globalChannelStore.setSessionContext(`flow-fixture-${run}`, run);
  model = `fixture-flow-${run}-${crypto.randomUUID()}`;
  const plan: TuningPlan = {
    id: `flow-fixture-plan-${run}`, version: 1, name: '单次阶跃合成检查', project: '合成 PI 对象', description: '夹具的有限采样，不是实机测量。', prompt: '仅给 PI 小幅候选。',
    route: 'feedback', mode: 'manual', loopId: 'flow-fixture-stage', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .01,
    commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
    baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: false, stableBaseConfirmed: false },
    bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } },
    maxParameterChangePercent: 20, maximumTrials: 2, evaluationWindowSeconds: .15, maximumTelemetryAgeSeconds: 5, maximumOutputMagnitude: 5,
    channels: { setpoint: '!0', feedback: '!1', output: '!2', parameters: {} }, units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
    confirmation: { mode: 'manual', acknowledgementText: '', timeoutSeconds: null, parameterTolerance: null },
    goal: { mode: currentCase === 'track' ? 'track' : 'step-response', maximumSteadyError: .1, maximumOvershootPct: 0, maximumTrackingError: .1, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null,
      ...(currentCase === 'legacy' ? {} : { stepSetpointTolerance: 0 }) },
    model: null, suite: createScenarioContext('custom', 'single', 'flow-fixture-stage', [{ id: 'flow-fixture-stage', title: '合成 PI 环', structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] }]),
  };
  const offline = currentCase === 'offline';
  if (offline) {
    plan.route = 'model'; plan.mode = 'manual';
    plan.model = { family: 'transfer_function', numerator: [1], denominator: [.5, 1], tau: 0 };
    plan.goal.targetCrossoverRadPerSec = 1; plan.goal.targetPhaseMarginDeg = 60;
    plan.baseline.params = null; plan.bounds = { kp: null, ki: null, kd: null };
    plan.commandTemplate = ''; plan.channels = { setpoint: '', feedback: '', output: '', parameters: {} };
    plan.units = { setpoint: '', feedback: '', output: '', parameters: {} };
    plan.maximumOutputMagnitude = plan.maximumTelemetryAgeSeconds = plan.evaluationWindowSeconds = plan.maximumTrials = plan.maxParameterChangePercent = null;
    plan.suite!.modelOrigin = 'user-transfer-function';
  }
  globalProjectModel.addLoop({ id: plan.loopId, name: '合成 PI 环', order: 0, structure: 'PI', plant_family: 'first_order', channels: { setpoint: '!0', feedback: '!1', output: '!2' }, param_limits: { kp: [0,10], ki: [0,2], kd: [0,0] }, cmd_template: plan.commandTemplate, state: 'untuned' });
  const session: TuningSession = { id: plan.id, scenarioGroupId: plan.id, plan, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null,
    formDraft: { modelSource: 'transfer', numerator: offline ? '1' : '', denominator: offline ? '.5, 1' : '', delay: offline ? '0' : '', parameters: { kp: '2', ki: '.5', kd: '0' } } };
  // Only this synthetic origin's single tuning fixture key is reset.
  localStorage.removeItem('llm-serial-tuning-sessions-v1');
  if (!saveTuningSession(session)) throw new Error('Fixture plan rejected by actual session validation.');
  ingest(0, 0, 1);
  const config: AiConfig = { provider: 'openai', api_key: 'synthetic-flow-fixture-key', api_url: `${location.origin}/fixture-ai/v1`, model };
  const props = reactive({ connected: !offline, demo: false, connectionLabel: '合成设备 · 非硬件验收', aiConfig: config, logs: [], writeResult: null, stopToken: 0,
    writeAccessReady: true, writeAccessExecutionId: null as string | null, executionEnabled: !offline, protocolConfig: { type: 'firewater' as const }, ordinaryWritesReady: true, ordinaryWriteRevision: 0 });
  app = createApp({ render: () => h(TuningWorkbench, { ...props,
    onSendCommand: () => { writes++; record('unexpected-write'); throw new Error('Step fixture never authorizes device writes.'); },
    onExecutionState: (state: { executionId: string; working: boolean }) => { record('execution-state', state); if (state.working) { props.writeAccessExecutionId = state.executionId; props.writeAccessReady = true; } else if (props.writeAccessExecutionId === state.executionId) { props.writeAccessReady = false; props.writeAccessExecutionId = null; } },
    onSafetyStop: (reason: string) => { record('safety-stop', reason); props.executionEnabled = false; props.ordinaryWritesReady = false; props.stopToken++; },
  }) });
  app.mount(host);
  if (!offline) timer = setInterval(() => ingest(held.target, held.feedback, held.output), 50);
  await nextTick();
  record('prepared', { currentCase, model, origin: location.origin });
  status.textContent = `已载入：${selection.selectedOptions[0].textContent}`;
  proof.textContent = '{}';
}
function addWindow() {
  const session = loadTuningSession();
  // Reader clears confirmation by design; inspect only identity, never restore it.
  if (!session || windowAdded) { status.textContent = '每次载入只补充一个窗口。'; return; }
  const reference = currentCase === 'repeated' || currentCase === 'output' || currentCase === 'track'
    ? [...Array(5).fill(0), 1, 0, 1, 0, ...Array(7).fill(1)]
    : currentCase === 'ramp' ? [...Array(5).fill(0), .25, .5, .75, ...Array(7).fill(1)] : [...Array(5).fill(0), ...Array(7).fill(1)];
  const response = reference.map((value, index) => currentCase === 'unsettled' && index < 5 ? .3 : value);
  const outputs = reference.map((_, index) => currentCase === 'output' && index === 7 ? 6 : 1);
  reference.forEach((value, index) => ingest(value, response[index], outputs[index]));
  held = { target: 1, feedback: 1, output: 1 }; windowAdded = true;
  record('window', { reference, response, outputs });
  status.textContent = `已补充窗口：${selection.selectedOptions[0].textContent}`;
}
async function capture() {
  const history: unknown[] = await fetch(`/fixture-ai/history?model=${encodeURIComponent(model)}`).then(response => response.json());
  const sessions = JSON.parse(localStorage.getItem('llm-serial-tuning-sessions-v1') ?? '[]') as TuningSession[];
  proof.textContent = JSON.stringify({ recordedAt: new Date().toISOString(), currentCase, origin: location.origin, windowAdded, writes, localHttpAiRequests: history.length, externalAiRequests: 0, jevCalls: 0,
    session: sessions.find(value => value.id === `flow-fixture-plan-${run}`) ?? null, events, requestHistory: history, nativeInteractive: 'not-run', hardware: 'not-run' }, null, 2);
}
document.querySelector<HTMLButtonElement>('#prepare')!.addEventListener('click', () => { void prepare(); });
document.querySelector<HTMLButtonElement>('#window')!.addEventListener('click', addWindow);
document.querySelector<HTMLButtonElement>('#capture')!.addEventListener('click', () => { void capture(); });
window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); app?.unmount(); });
void prepare();
