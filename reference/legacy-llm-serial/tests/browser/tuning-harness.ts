import { createApp, h, reactive, nextTick } from 'vue';
import type { App } from 'vue';
import TuningWorkbench from '../../src/components/TuningWorkbench.vue';
import { globalChannelStore } from '../../src/core/channel/ChannelStore';
import { globalProjectModel } from '../../src/core/project/ProjectModel';
import { ProtocolEngine } from '../../src/core/protocol/ProtocolEngine';
import type { ProtocolConfig } from '../../src/core/protocol/types';
import { createScenarioContext } from '../../src/core/tuning/scenarios';
import { saveTuningSession } from '../../src/core/tuning/sessionStore';
import type { PlantModelDraft, TuningPlan, TuningSession } from '../../src/core/tuning/types';
import { tuningCommandBytes } from '../../src/core/tuning/commandContract';
import type { TuningCommandPayload } from '../../src/core/tuning/commandContract';
import type { AiConfig } from '../../src/services/ai';
import type { TuningWriteResult } from '../../src/core/tuning/execution-lease';
import { SyntheticTelemetryClock } from './synthetic-telemetry-clock';

// This guard prevents fixture code from touching the main development origin's
// local settings. The only writable browser storage is this synthetic origin.
if (location.hostname !== '127.0.0.1' || location.port !== '5191') throw new Error('Fixture requires its independent localhost:5191 origin.');

type CaseId = 'ack-two-rounds' | 'ack-before-receipt' | 'readback-before-receipt' | 'old-ack' | 'old-readback' | 'failed-write' | 'stop-last-window' | 'stop-unconfirmed' | 'binary-ack-gate' | 'ordinary-ready-gate' | 'ordinary-revision-invalidation' | 'candidate-mutual-exclusion' | 'candidate-stop-reenter' | 'model-stop-reenter' | 'stale-write-lease' | 'late-write-receipt' | 'late-receipt-preserves-stage' | 'duplicate-written-idempotent' | 'telemetry-expired';
type FixtureCase = { id: CaseId; title: string; expectedWrites: number; success: boolean; confirmation?: 'parameter-channels'; protocol?: ProtocolConfig };
const cases: FixtureCase[] = [
  { id: 'ack-two-rounds', title: 'ACK 两轮：基线 → 本轮评价 → 下一轮窗口 → 达标', expectedWrites: 2, success: true },
  { id: 'ack-before-receipt', title: '精准 ACK 先到、written 回执后到', expectedWrites: 1, success: true },
  { id: 'readback-before-receipt', title: '一次性参数回读先到、written 回执后到', expectedWrites: 1, success: true, confirmation: 'parameter-channels' },
  { id: 'old-ack', title: '旧 request_id ACK 不得确认', expectedWrites: 1, success: false },
  { id: 'old-readback', title: '旧 ingestion revision 回读不得确认', expectedWrites: 1, success: false, confirmation: 'parameter-channels' },
  { id: 'failed-write', title: '写失败，即使收到精准 ACK 也不得确认', expectedWrites: 1, success: false },
  { id: 'stop-last-window', title: '末次观察等待时停止，不得 completed', expectedWrites: 1, success: false },
  { id: 'stop-unconfirmed', title: '第二次已派发未确认时停止，旧参数证据失效', expectedWrites: 2, success: false },
  { id: 'binary-ack-gate', title: 'JustFloat 不支持文本 ACK：执行入口必须阻止', expectedWrites: 0, success: false, protocol: { type: 'justfloat', channels: 3 } },
  { id: 'ordinary-ready-gate', title: '普通写入未结束：不能确认基线或请求 AI / 启动', expectedWrites: 0, success: false },
  { id: 'ordinary-revision-invalidation', title: '普通命令提交：已就绪基线窗口与保护确认失效', expectedWrites: 0, success: false },
  { id: 'candidate-mutual-exclusion', title: '候选请求未完成时旧候选不能下发', expectedWrites: 0, success: false },
  { id: 'candidate-stop-reenter', title: '停止候选后重入：旧响应和 finally 不影响新请求', expectedWrites: 0, success: false },
  { id: 'model-stop-reenter', title: '停止建模后重入：旧草稿不覆盖新请求', expectedWrites: 0, success: false },
  { id: 'stale-write-lease', title: '旧执行身份 ready 不能授权新轮次写入', expectedWrites: 0, success: false },
  { id: 'late-write-receipt', title: '停止并新建后原回执只留在原轮次', expectedWrites: 1, success: false },
  { id: 'late-receipt-preserves-stage', title: '迟到回执保留重载环节的新配置与新候选', expectedWrites: 1, success: false },
  { id: 'duplicate-written-idempotent', title: '重复 written 不降级已评价轮次与最佳记录', expectedWrites: 1, success: true },
  { id: 'telemetry-expired', title: '有效设备确认后停止遥测：5秒保护停止且无下一次下发', expectedWrites: 1, success: false },
];
type FixtureLog = { id: number; time: string; at: number; tag: string; level: string; text: string; rx_origin?: import('../../src/types/ipc').RxOrigin };
type FixtureReceipt = TuningWriteResult | null;
type EventRecord = { at: number; event: string; detail?: unknown };
type CaseResult = { id: CaseId; title: string; passed: boolean; reason: string; writes: number; aiRequests: number; session: TuningSession | null; events: EventRecord[]; hardwareAcceptance: 'not-run'; nativeAcceptance: 'not-run' };

const host = document.querySelector<HTMLElement>('#component-host')!;
const caseSelect = document.querySelector<HTMLSelectElement>('#case-select')!;
const status = document.querySelector<HTMLElement>('#fixture-status')!;
const eventOutput = document.querySelector<HTMLElement>('#event-log')!;
const resultOutput = document.querySelector<HTMLElement>('#result-json')!;
const resultsList = document.querySelector<HTMLElement>('#case-results')!;
const results: CaseResult[] = [];
let component: App | null = null;
let streamTimer: ReturnType<typeof setInterval> | null = null;
let frameIndex = 0;
let serial = 0;
let syntheticRxSequence = 0;
let activeRun = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let currentCase: FixtureCase = cases[0];
let events: EventRecord[] = [];
let writes: Array<{ trialId: string; params: { kp: number; ki: number; kd: number }; payload: TuningCommandPayload }> = [];
let responseError = 2;
let props: ReturnType<typeof fixtureProps>;
let parser = new ProtocolEngine('firewater');
let runBusy = false;
let delayedAiCalls = 0;
const SYNTHETIC_SAMPLE_MS = 10;
const SYNTHETIC_PUMP_MS = 100;
const SYNTHETIC_MAX_AGE_SECONDS = 5;
// External observation includes local HTTP, Vue rendering, device confirmation
// and debounced persistence. It never changes the product's protection clocks.
const COMPLETION_OBSERVATION_TIMEOUT_MS = 30_000;
let telemetryClock = new SyntheticTelemetryClock(performance.now(), SYNTHETIC_SAMPLE_MS, SYNTHETIC_MAX_AGE_SECONDS * 1000);
let timingFailure: string | null = null;
let lastTelemetryAt = 0;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  const delayed = ['candidate-mutual-exclusion', 'candidate-stop-reenter', 'model-stop-reenter'].includes(currentCase.id)
    && url.startsWith(`${location.origin}/fixture-ai/v1/`) && init?.method === 'POST';
  if (!delayed) return realFetch(input, init);
  const call = ++delayedAiCalls;
  record('local-ai-request-dispatch', { call });
  // Simulate an uncancellable backend completion. The production service still
  // receives the AbortSignal; only this synthetic fetch ignores delivery abort.
  const result = await realFetch(input, { ...init, signal: undefined });
  const delay = currentCase.id === 'candidate-mutual-exclusion' ? call === 1 ? 20 : 900 : call === 1 ? 800 : 1600;
  await new Promise(resolve => setTimeout(resolve, delay));
  record('deliberately-late-local-ai-completion', { call, signalAborted: init?.signal?.aborted === true });
  return result;
};

function fixtureProps(config: AiConfig, protocol: ProtocolConfig) {
  return reactive({ connected: true, demo: false, connectionLabel: '合成设备 · 不代表硬件验收', aiConfig: config,
    logs: [] as FixtureLog[], writeResult: null as FixtureReceipt, lateWriteResult: null as FixtureReceipt, stopToken: 0,
    writeAccessReady: false, writeAccessExecutionId: null as string | null, executionEnabled: true, protocolConfig: protocol,
    ordinaryWritesReady: true, ordinaryWriteRevision: 0 });
}

function record(event: string, detail?: unknown) {
  events.push({ at: Date.now(), event, detail });
  eventOutput.textContent = JSON.stringify(events, null, 2);
  eventOutput.scrollTop = eventOutput.scrollHeight;
}
function later(callback: () => void, delay: number) {
  const run = activeRun;
  timers.push(setTimeout(() => { if (run === activeRun) callback(); }, delay));
}
function ingest(bytes: Uint8Array) {
  // This component fixture has one complete-line synthetic chunk per feed;
  // it does not exercise actual Web/native dispatch. The 5198 fixture does.
  const rxSequence = ++syntheticRxSequence;
  const output = parser.feed(bytes, Math.round(frameIndex * 10_000));
  globalChannelStore.pushProtocolOutput(output);
  for (const log of output.logs) {
    const at = Date.now();
    props.logs.push({ id: ++serial, time: new Date(at).toLocaleTimeString('zh-CN'), at, tag: '[RX]', level: log.level.toLowerCase(), text: log.text,
      rx_origin: { source: 'web-serial-read', session_id: `fixture-session-${activeRun}`, epoch: activeRun, first_rx_sequence: rxSequence, last_rx_sequence: rxSequence } });
    record('parsed-rx-log', { logId: serial, text: log.text });
  }
}
function ingestText(text: string) { ingest(new TextEncoder().encode(text)); }
function pushTelemetry() {
  lastTelemetryAt = Date.now();
  frameIndex += 1;
  if (props.protocolConfig.type === 'justfloat') {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    [10, 10 - responseError, 1].forEach((value, index) => view.setFloat32(index * 4, value, true));
    bytes.set([0, 0, 0x80, 0x7f], 12);
    ingest(bytes);
  } else ingestText(`10,${10 - responseError},1\n`);
}
function pumpTelemetry() {
  const clock = telemetryClock.take(performance.now());
  if (clock.unsupportedGap) {
    timingFailure = `合成页 callback 间隔 ${Math.round(clock.gapMs)}ms 超过明确5秒时限；不补数据，不算通过。`;
    record('synthetic-timing-contract-exceeded', clock);
    return;
  }
  if (clock.gapMs > 300) record('synthetic-buffered-telemetry-delivery', clock);
  for (let index = 0; index < clock.samples; index += 1) pushTelemetry();
  // This synthetic input contract explicitly delivers the buffered batch to
  // subscribers. A hidden page's rendering cadence is not a device cadence;
  // the real transport fixtures exercise the production scheduler separately.
  globalChannelStore.flushDispatch();
}
function sendReadback(params: { kp: number; ki: number }) {
  ingestText(`>fixture_kp:${params.kp}\n>fixture_ki:${params.ki}\n`);
  record('parameter-ingested', { ...params, kpRevision: globalChannelStore.getChannelRevision('fixture_kp'), kiRevision: globalChannelStore.getChannelRevision('fixture_ki') });
}
function syntheticWrite(request: { executionId: string; trialId: string; command: string; payload: TuningCommandPayload }) {
  if (!props.writeAccessReady || props.writeAccessExecutionId !== request.executionId) throw new Error('Synthetic write has no matching execution owner.');
  const rxDispatch = { source: 'web-serial-read' as const, session_id: `fixture-session-${activeRun}`, epoch: activeRun, rx_sequence: syntheticRxSequence };
  // Pending tuning bytes affect quiescence, but do not revoke the experiment's
  // execution permission or pretend an ordinary command changed its revision.
  props.ordinaryWritesReady = false;
  const bytes = tuningCommandBytes(request.payload, request.command);
  const wireText = new TextDecoder().decode(bytes);
  const [prefix, protocolId, kp, ki, kd] = wireText.trim().split(',');
  if (prefix !== 'PID' || protocolId !== request.trialId || ![kp, ki, kd].every(value => Number.isFinite(Number(value)))) throw new Error('Synthetic driver rejected the frozen wire payload.');
  const params = { kp: Number(kp), ki: Number(ki), kd: Number(kd) };
  writes.push({ trialId: request.trialId, params, payload: request.payload });
  const count = writes.length;
  record('driver-dispatch', { executionId: request.executionId, trialId: request.trialId, params, hex: request.payload.hex, byteLength: bytes.length, visibleText: request.payload.visibleText,
    startParameterRevisions: { kp: globalChannelStore.getChannelRevision('fixture_kp'), ki: globalChannelStore.getChannelRevision('fixture_ki') } });
  responseError = currentCase.id === 'ack-two-rounds' || currentCase.id === 'stop-unconfirmed' ? count === 1 ? 1 : .02 : .02;
  const earlyResponse = currentCase.id === 'ack-before-receipt' || currentCase.id === 'readback-before-receipt';
  const receive = () => {
    if (currentCase.id === 'old-readback') return;
    if (currentCase.confirmation === 'parameter-channels') sendReadback(params);
    else ingestText(`PID_APPLIED ${currentCase.id === 'old-ack' ? 'fixture-previous-request' : request.trialId}\n`);
  };
  later(receive, currentCase.id === 'late-receipt-preserves-stage' ? 4400 : currentCase.id === 'late-write-receipt' ? 1000 : currentCase.id === 'stop-unconfirmed' && count === 2 ? 900 : earlyResponse ? 35 : 110);
  later(() => {
    const failed = currentCase.id === 'failed-write';
    const receipt: TuningWriteResult = { id: request.trialId, executionId: request.executionId, requestId: `fixture-driver-${count}`, sessionId: `fixture-session-${activeRun}`, epoch: activeRun,
      rxDispatch,
      status: failed ? 'failed' : 'written', at: Date.now(), ...(failed ? { error: 'Synthetic driver write failed' } : {}) };
    const retired = props.writeAccessExecutionId !== request.executionId;
    if (retired) props.lateWriteResult = receipt;
    else props.writeResult = receipt;
    // A late successful receipt cannot unlock a prior software safety stop.
    props.ordinaryWritesReady = !failed && props.executionEnabled;
    record('driver-receipt', { ...receipt, propChannel: retired ? 'lateWriteResult' : 'writeResult' });
  }, currentCase.id === 'late-receipt-preserves-stage' ? 4000 : currentCase.id === 'late-write-receipt' ? 850 : earlyResponse ? 260 : 65);
  if (currentCase.id === 'stop-unconfirmed' && count === 2) later(() => {
    clickButton('停止调参流程');
    record('synthetic-stop-during-unconfirmed-write');
  }, 180);
  if (currentCase.id === 'stop-last-window') void stopDuringWindow(activeRun);
  if (currentCase.id === 'telemetry-expired') void stopTelemetryDuringWindow(activeRun);
}

function planFor(fixture: FixtureCase): TuningPlan {
  return {
    id: `fixture-plan-${activeRun}`, version: 1, name: fixture.title, project: '合成测试对象', description: '测试夹具的合成数据，不是设备测量或硬件证明。', prompt: '仅允许输入范围内的 PI 小幅候选。',
    route: 'feedback', mode: 'bounded-auto', loopId: 'fixture-stage', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .01,
    commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
    baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: false, stableBaseConfirmed: false },
    bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } },
    maxParameterChangePercent: 20, maximumTrials: 2, evaluationWindowSeconds: fixture.id === 'telemetry-expired' ? 7 : fixture.id === 'stop-last-window' ? 2 : .7,
    maximumTelemetryAgeSeconds: SYNTHETIC_MAX_AGE_SECONDS, maximumOutputMagnitude: 10,
    channels: { setpoint: '!0', feedback: '!1', output: '!2', parameters: { kp: 'fixture_kp', ki: 'fixture_ki' } },
    units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
    confirmation: { mode: fixture.confirmation ?? 'acknowledgement', acknowledgementText: 'PID_APPLIED {request_id}', timeoutSeconds: .8, parameterTolerance: .01 },
    goal: { mode: 'settle', maximumSteadyError: .1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null },
    model: null, suite: createScenarioContext('custom', fixture.id === 'late-receipt-preserves-stage' ? 'cascade' : 'single', 'fixture-stage',
      [{ id: 'fixture-stage', title: '合成 PI 控制环', structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] },
        ...(fixture.id === 'late-receipt-preserves-stage' ? [{ id: 'fixture-outer', title: '合成外环', structure: 'PI' as const, supportedStructures: ['PI' as const] }] : [])]),
  };
}

async function prepare(fixture: FixtureCase) {
  if (streamTimer) clearInterval(streamTimer);
  timers.forEach(clearTimeout); timers = [];
  component?.unmount(); component = null;
  activeRun += 1; frameIndex = 0; serial = 0; syntheticRxSequence = 0; currentCase = fixture; events = []; writes = []; responseError = 2; delayedAiCalls = 0; timingFailure = null;
  telemetryClock = new SyntheticTelemetryClock(performance.now(), SYNTHETIC_SAMPLE_MS, SYNTHETIC_MAX_AGE_SECONDS * 1000);
  globalChannelStore.clear();
  globalChannelStore.setSessionContext(`fixture-session-${activeRun}`, activeRun);
  globalProjectModel.addLoop({ id: 'fixture-stage', name: '合成 PI 控制环', order: 0, structure: 'PI', plant_family: 'first_order',
    channels: { setpoint: '!0', feedback: '!1', output: '!2' }, param_limits: { kp: [0, 10], ki: [0, 2], kd: [0, 0] }, cmd_template: 'PID,{request_id},{kp},{ki},{kd}', state: 'untuned' });
  const config: AiConfig = { provider: 'openai', api_key: 'synthetic-fixture-key', api_url: `${location.origin}/fixture-ai/v1`, model: `fixture-${fixture.id}-${activeRun}-${crypto.randomUUID()}` };
  props = fixtureProps(config, fixture.protocol ?? { type: 'firewater' });
  if (fixture.id === 'ordinary-ready-gate') props.ordinaryWritesReady = false;
  parser = new ProtocolEngine(props.protocolConfig.type, props.protocolConfig);
  const plan = planFor(fixture);
  const session: TuningSession = { id: plan.id, scenarioGroupId: plan.id, plan, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null,
    formDraft: { modelSource: 'transfer', numerator: '', denominator: '', delay: '', parameters: { kp: '2', ki: '0.5', kd: '0' } } };
  localStorage.removeItem('llm-serial-tuning-sessions-v1');
  if (!saveTuningSession(session)) throw new Error('Synthetic configuration failed the real persisted-session validation.');
  pushTelemetry();
  if (fixture.protocol?.type !== 'justfloat') sendReadback(fixture.id === 'old-readback' ? { kp: 2.2, ki: .55 } : { kp: 2, ki: .5 });
  component = createApp({ render: () => h(TuningWorkbench, { ...props,
    onSendCommand: syntheticWrite,
    onExecutionState: (state: { executionId: string; working: boolean }) => { record('execution-state', state); if (state.working) { props.writeAccessExecutionId = fixture.id === 'stale-write-lease' ? 'retired-fixture-execution' : state.executionId; props.writeAccessReady = true; } else if (props.writeAccessExecutionId === state.executionId) { props.writeAccessReady = false; props.writeAccessExecutionId = null; } },
    onSafetyStop: (reason: string) => { record('component-safety-stop', reason); props.ordinaryWritesReady = false; props.executionEnabled = false; props.stopToken += 1; },
    onOpenProtocolSettings: () => record('open-protocol-settings'),
    onOpenAiSettings: () => record('open-ai-settings'),
  }) });
  component.mount(host);
  streamTimer = setInterval(pumpTelemetry, SYNTHETIC_PUMP_MS);
  await nextTick();
  record('prepared', { id: fixture.id, origin: location.origin, syntheticAuthorization: true, hardwareAcceptance: 'not-run',
    timing: { sampleTimeMs: SYNTHETIC_SAMPLE_MS, browserPumpMs: SYNTHETIC_PUMP_MS, maximumTelemetryAgeSeconds: SYNTHETIC_MAX_AGE_SECONDS,
      evaluationWindowSeconds: plan.evaluationWindowSeconds, completionObservationTimeoutMs: COMPLETION_OBSERVATION_TIMEOUT_MS,
      delivery: 'bounded-buffered-synthetic-samples', subscriberDispatch: 'public-ChannelStore.flushDispatch-after-synthetic-batch', documentVisibility: document.visibilityState } });
  status.textContent = `已准备：${fixture.title}`;
  status.className = 'status';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 8000, phase = 'component-ui-condition') {
  const started = performance.now();
  const deadline = started + timeout;
  record('fixture-await-start', { phase, timeoutMs: timeout });
  while (performance.now() <= deadline) {
    if (predicate()) {
      record('fixture-await-satisfied', { phase, elapsedMs: Math.round(performance.now() - started) });
      return;
    }
    await sleep(20);
  }
  record('fixture-await-timeout', { phase, timeoutMs: timeout, elapsedMs: Math.round(performance.now() - started) });
  throw new Error(`Timed out in ${phase} (${timeout}ms fixture observation); visible component state: ${host.textContent?.slice(0, 1600)}`);
}
function findButton(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text);
}
function clickButton(text: string) {
  const button = findButton(text);
  if (!button || button.disabled) throw new Error(`Expected enabled real UI button: ${text}`);
  button.click();
}
function checkLabel(text: string) {
  const checkbox = labelCheckbox(text);
  if (!checkbox || checkbox.disabled) throw new Error(`Expected enabled real UI checkbox: ${text}`);
  const details = checkbox.closest<HTMLDetailsElement>('details');
  if (details && !details.open) details.open = true;
  if (!checkbox.checked) checkbox.click();
  record('synthetic-user-checkbox', text);
}
function labelCheckbox(text: string): HTMLInputElement | undefined {
  const label = [...host.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent?.includes(text));
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined;
}
function feedbackPending(): boolean {
  return [...host.querySelectorAll<HTMLElement>('[role="status"]')].some(item => item.textContent?.includes('反馈依据：'));
}
async function stopDuringWindow(run: number) {
  await until(() => Boolean(host.querySelector('.working-message')?.textContent?.includes('等待 2 秒')),
    COMPLETION_OBSERVATION_TIMEOUT_MS, 'final-observation-window-before-user-stop');
  if (activeRun !== run) return;
  clickButton('停止调参流程'); record('synthetic-stop-in-final-observation-wait');
}
async function stopTelemetryDuringWindow(run: number) {
  await until(() => Boolean(host.querySelector('.working-message')?.textContent?.includes('等待 7 秒')),
    COMPLETION_OBSERVATION_TIMEOUT_MS, 'confirmed-7s-observation-window-before-feed-stop');
  if (activeRun !== run) return;
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = null;
  record('synthetic-telemetry-feed-stopped-after-device-confirmation', { lastTelemetryAt,
    expiresAt: lastTelemetryAt + SYNTHETIC_MAX_AGE_SECONDS * 1000 });
}
function savedSession(): TuningSession | null {
  const parsed = JSON.parse(localStorage.getItem('llm-serial-tuning-sessions-v1') ?? '[]') as TuningSession[];
  return parsed.find(value => value.id === `fixture-plan-${activeRun}`) ?? null;
}
async function aiHistory() {
  const response = await fetch(`/fixture-ai/history?model=${encodeURIComponent(props.aiConfig.model)}`);
  if (!response.ok) throw new Error('Local AI transcript unavailable');
  return await response.json() as Array<{ evidence: { params: { kp: number; ki: number }; telemetryWindow: { source: string; trialId?: string }; measured: { sampleCount: number; steadyError: number } } }>;
}

async function approveVisibleDialog() {
  await until(() => Boolean(host.querySelector<HTMLDialogElement>('dialog')?.open), 8000, 'authorization-dialog-open');
  clickButton('确认此范围并继续');
  await nextTick();
}
async function startManualCandidate() {
  clickButton('场景与设置');
  await nextTick();
  await until(() => Boolean(findButton('先审阅一轮') && !findButton('先审阅一轮')!.disabled), 8000, 'manual-candidate-entry-ready');
  clickButton('先审阅一轮');
  await approveVisibleDialog();
}
function selectLabel(text: string, value: string) {
  const label = [...host.querySelectorAll<HTMLLabelElement>('label')].find(label => label.querySelector('span')?.textContent?.trim() === text);
  const select = label?.querySelector<HTMLSelectElement>('select');
  if (!select || select.matches(':disabled')) throw new Error(`Expected enabled real select: ${text}`);
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
}
function fillLabel(text: string, value: string) {
  const label = [...host.querySelectorAll<HTMLLabelElement>('label')].find(label => label.querySelector('span')?.textContent?.trim() === text);
  const input = label?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
  if (!input || input.matches(':disabled')) throw new Error(`Expected enabled real input: ${text}`);
  const details = input.closest<HTMLDetailsElement>('details'); if (details) details.open = true;
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function runOwnershipCase(fixture: FixtureCase): Promise<string> {
  if (fixture.id === 'model-stop-reenter') {
    const route = host.querySelector<HTMLButtonElement>('.route-choice button:nth-child(2)')!;
    route.click(); await nextTick();
    selectLabel('模型来源', 'ai'); await nextTick();
    clickButton('草拟模型与数据表'); await approveVisibleDialog();
    await until(() => delayedAiCalls === 1, 8000, 'first-model-request-dispatched');
    clickButton('取消本次请求'); await nextTick();
    clickButton('草拟模型与数据表'); await approveVisibleDialog();
    await until(() => delayedAiCalls === 2, 8000, 'second-model-request-dispatched');
    await sleep(950);
    if (!findButton('取消本次请求') || host.querySelector('.model-draft')) throw new Error('Old model completion released or replaced the new model operation.');
    await until(() => !findButton('取消本次请求'), COMPLETION_OBSERVATION_TIMEOUT_MS, 'second-model-operation-completed');
    await until(() => (savedSession()?.plan.suite?.modelDraft as Partial<PlantModelDraft> | undefined)?.title === '合成模型草稿 2',
      COMPLETION_OBSERVATION_TIMEOUT_MS, 'second-model-draft-persisted');
    if (writes.length !== 0 || host.textContent?.includes('模型推导没有完成')) throw new Error('Cancelled model operation caused device writes or a stale error.');
    return '旧模型响应在第二次请求等待期间到达；busy、模型草稿与提示只由第二次操作更新。';
  }
  await startManualCandidate();
  if (fixture.id === 'candidate-stop-reenter') {
    await until(() => delayedAiCalls === 1, 8000, 'first-candidate-request-dispatched');
    clickButton('取消本次请求'); await nextTick();
    await startManualCandidate();
    await until(() => delayedAiCalls === 2, 8000, 'second-candidate-request-dispatched');
    await sleep(950);
    if (!findButton('取消本次请求') || host.querySelector('.proposal-review')) throw new Error('Old candidate completion released or replaced the new request.');
    await until(() => Boolean(findButton('核对命令并发送')), COMPLETION_OBSERVATION_TIMEOUT_MS, 'second-candidate-review-ready');
    await until(() => savedSession()?.trials.length === 1, COMPLETION_OBSERVATION_TIMEOUT_MS, 'second-candidate-only-trial-persisted');
    if (!savedSession()!.trials[0].note.includes('合成候选 2') || writes.length !== 0 || host.textContent?.includes('AI 候选请求没有完成')) throw new Error('Cancelled candidate committed a trial, stale error, or write.');
    return '旧候选响应在第二次请求等待期间到达；仅第二次候选入档，旧 catch/finally 不覆盖新操作。';
  }
  await until(() => Boolean(findButton('核对命令并发送') && !findButton('核对命令并发送')!.disabled),
    COMPLETION_OBSERVATION_TIMEOUT_MS, 'manual-candidate-review-ready');
  if (fixture.id === 'candidate-mutual-exclusion') {
    // Persistence is intentionally debounced by the real component. Capture A
    // only after its record is saved, before beginning delayed request B.
    await until(() => savedSession()?.trials.length === 1, COMPLETION_OBSERVATION_TIMEOUT_MS, 'first-candidate-trial-persisted');
    const oldTrial = savedSession()?.trials[0]?.id;
    await startManualCandidate();
    await until(() => delayedAiCalls === 2, 8000, 'mutual-exclusion-second-candidate-request-dispatched');
    const tab = host.querySelector<HTMLButtonElement>('.assistant-tabs button:nth-child(2)')!;
    tab.click(); await nextTick();
    if (findButton('核对命令并发送') || findButton('忽略候选') || !findButton('取消本次请求')) throw new Error('Existing proposal actions were exposed while a new candidate operation owned the component.');
    await sleep(250);
    if (writes.length !== 0 || host.querySelector<HTMLDialogElement>('dialog')?.open || savedSession()?.trials[0]?.id !== oldTrial) throw new Error('Pending candidate overwrote state or sent old bytes.');
    await until(() => Boolean(findButton('核对命令并发送')), COMPLETION_OBSERVATION_TIMEOUT_MS, 'mutual-exclusion-second-candidate-review-ready');
    await until(() => savedSession()?.trials.length === 2, COMPLETION_OBSERVATION_TIMEOUT_MS, 'both-candidate-trials-persisted');
    return '第二个候选等待期间切到真实结果页：旧候选发送/忽略入口关闭，未派发字节；完成后恢复。';
  }
  clickButton('核对命令并发送');
  if (fixture.id === 'stale-write-lease') {
    await until(() => events.some(event => event.event === 'execution-state' && (event.detail as { working?: boolean }).working === true),
      8000, 'stale-lease-operation-owned-without-write');
    await sleep(300);
    if (writes.length || host.querySelector<HTMLDialogElement>('dialog')?.open) throw new Error('Retired execution ID incorrectly authorized new command preview/write.');
    clickButton('停止调参流程'); await nextTick(); await sleep(100);
    if (findButton('停止调参流程') || writes.length || !findButton('核对命令并发送')) throw new Error('Cancelled write-access wait did not release its component owner.');
    return 'ready=true 但 executionId 属于旧执行时不显示字节授权或下发；停止立即结束旧等待。';
  }
  await approveVisibleDialog();
  await until(() => writes.length === 1, 8000, 'manual-trial-first-driver-dispatch');
  if (fixture.id === 'duplicate-written-idempotent') {
    await until(() => !findButton('停止调参流程') && savedSession()?.status === 'completed',
      COMPLETION_OBSERVATION_TIMEOUT_MS, 'evaluated-completion-persisted-before-duplicate-written');
    const before = JSON.stringify(savedSession());
    const normal = props.writeResult!;
    props.lateWriteResult = { ...normal, at: Date.now() };
    await nextTick(); await sleep(450);
    if (JSON.stringify(savedSession()) !== before || savedSession()?.trials[0]?.status !== 'evaluated'
      || !savedSession()?.bestVerified || writes.length !== 1) throw new Error('Duplicate retired written downgraded or rewrote evaluated history.');
    record('duplicate-written-preserved-evaluated-history', { trialId: normal.id, executionId: normal.executionId });
    return '已评价并结束执行后，同 request 的重复 written 未改状态、配置、metrics 或 bestVerified。';
  }
  clickButton('停止调参流程'); await nextTick();
  if (fixture.id === 'late-receipt-preserves-stage') {
    clickButton('场景与设置'); await nextTick();
    selectLabel('当前控制环节', 'fixture-outer'); await nextTick();
    selectLabel('当前控制环节', 'fixture-stage'); await nextTick();
    fillLabel('补充提示词约束', '重载环节后编辑的最新约束，迟到回执必须保留。');
    host.querySelector<HTMLButtonElement>('.route-choice button:nth-child(2)')!.click(); await nextTick();
    selectLabel('模型来源', 'transfer'); await nextTick();
    fillLabel('G(s) 分子系数', '1'); fillLabel('G(s) 分母系数', '1,1'); fillLabel('纯延迟 τ · 秒', '0');
    // For G(s)=1/(s+1), ωc=.5 and PM=90° yield positive PI gains
    // near .5/.5 (including sample delay). PM=60° needs <-90° PI phase.
    fillLabel('剪切频率 · rad/s', '.5'); fillLabel('相位裕度 · °', '90'); await nextTick();
    checkLabel('我已核对输入输出、单位、物理数据和假设'); await nextTick();
    clickButton('计算 PID 候选');
    await until(() => savedSession()?.trials.length === 2, COMPLETION_OBSERVATION_TIMEOUT_MS, 'reloaded-stage-new-candidate-persisted');
    const newerTrialId = savedSession()!.trials[0].id;
    clickButton('场景与设置'); await nextTick();
    selectLabel('当前控制环节', 'fixture-outer'); await nextTick();
    await until(() => events.some(event => event.event === 'driver-receipt' && (event.detail as { propChannel?: string }).propChannel === 'lateWriteResult'),
      6000, 'retired-stage-late-driver-receipt-delivered');
    const latest = savedSession()!;
    const original = latest.trials.find(trial => trial.id === writes[0].trialId);
    if (latest.plan.prompt !== '重载环节后编辑的最新约束，迟到回执必须保留。' || latest.trials.length !== 2
      || latest.trials[0].id !== newerTrialId || latest.plan.route !== 'model' || !original?.writeCompletedAt
      || original.status !== 'failed' || latest.plan.baseline.confirmed || latest.lastConfirmed) throw new Error('Retired receipt replaced a newer stage plan/trial or restored device authority.');
    const stageSelect = [...host.querySelectorAll<HTMLLabelElement>('label')].find(label => label.querySelector('span')?.textContent?.trim() === '当前控制环节')?.querySelector<HTMLSelectElement>('select');
    if (stageSelect?.value !== 'fixture-outer' || writes.length !== 1) throw new Error('Retired receipt changed the active outer-stage UI or sent bytes.');
    record('latest-stage-plan-and-new-trial-preserved', { newerTrialId, originalTrialId: original.id, prompt: latest.plan.prompt });
    return 'A停止→B→恢复A并编辑/计算新候选→B，迟到A回执只补原trial；最新A配置/新trial与当前B界面保留。';
  }
  clickButton('新建'); await nextTick();
  const currentText = host.querySelector('.scene-state')?.textContent;
  await sleep(1200);
  const old = savedSession();
  if (writes.length !== 1 || old?.trials[0]?.status !== 'failed' || !old?.trials[0]?.writeCompletedAt || !old.trials[0].confirmation?.includes('停止后收到驱动回执')) throw new Error('Late receipt was lost or promoted the retired attempt.');
  if (host.querySelector('.proposal-review') || findButton('停止调参流程') || host.querySelector('.notice')) throw new Error('Late old receipt changed the new experiment UI.');
  record('late-receipt-original-session-only', { currentText, originalTrial: old.trials[0].id, receiptPreserved: true });
  return '停止后新建场景，迟到 written 保留在原轮次；新场景未被旧回执、等待或 finally 改动。';
}

async function runCase(fixture: FixtureCase): Promise<CaseResult> {
  await prepare(fixture);
  let reason = '';
  let passed = false;
  let history: Awaited<ReturnType<typeof aiHistory>> = [];
  try {
    if (fixture.id === 'ordinary-ready-gate') {
      const baseline = labelCheckbox('我已核对设备当前值与边界');
      const start = findButton('检查并启动自动反馈');
      const propose = findButton('先审阅一轮');
      if (!baseline?.disabled || baseline.checked || !start?.disabled || !propose?.disabled) throw new Error('Pending ordinary writes did not disable baseline confirmation and both feedback actions.');
      baseline.click(); start.click(); propose.click();
      await nextTick();
      await sleep(500);
      await until(() => Boolean(savedSession() && !savedSession()!.plan.baseline.confirmed && !savedSession()!.plan.baseline.stableBaseConfirmed && savedSession()!.lastConfirmed === null),
        8000, 'ordinary-write-gate-retained-unconfirmed-persisted-baseline');
      history = await aiHistory();
      if (baseline.checked || writes.length !== 0 || history.length !== 0 || host.querySelector<HTMLDialogElement>('dialog')?.open || !feedbackPending()) throw new Error('Disabled ordinary-write gate created baseline authority, AI requests, authorization, or device bytes.');
      record('ordinary-ready-gate-verified', { baselineDisabled: baseline.disabled, startDisabled: start.disabled, proposeDisabled: propose.disabled, writes: writes.length, aiRequests: history.length });
      passed = true; reason = '普通写入未结束时真实复选框与反馈入口禁用；保存基线未确认，AI / 字节均为 0。';
    } else {
      checkLabel('我已核对设备当前值与边界');
      await nextTick();
      checkLabel('当前控制器在稳定的保守基线下运行');
      await sleep(1000);
      if (['candidate-mutual-exclusion', 'candidate-stop-reenter', 'model-stop-reenter', 'stale-write-lease', 'late-write-receipt', 'late-receipt-preserves-stage', 'duplicate-written-idempotent'].includes(fixture.id)) {
        reason = await runOwnershipCase(fixture);
        history = await aiHistory();
        if (writes.length !== fixture.expectedWrites) throw new Error(`Expected ${fixture.expectedWrites} ownership-case writes, saw ${writes.length}.`);
        passed = true;
      } else if (fixture.id === 'ordinary-revision-invalidation') {
        await until(() => Boolean(findButton('检查并启动自动反馈') && !findButton('检查并启动自动反馈')!.disabled && !feedbackPending()),
          8000, 'baseline-window-ready-before-ordinary-revision');
        await until(() => Boolean(savedSession()?.plan.baseline.confirmed && savedSession()?.plan.baseline.stableBaseConfirmed),
          COMPLETION_OBSERVATION_TIMEOUT_MS, 'confirmed-baseline-persisted-before-ordinary-revision');
        const savedBefore = savedSession()!;
        record('baseline-window-ready-before-ordinary-command', { updatedAt: savedBefore.updatedAt, baseline: savedBefore.plan.baseline, feedbackPending: false });
        props.ordinaryWriteRevision += 1;
        record('ordinary-command-revision', { revision: props.ordinaryWriteRevision });
        await nextTick();
        await until(() => {
          const saved = savedSession();
          return Boolean(saved && saved.updatedAt > savedBefore.updatedAt && !saved.plan.baseline.confirmed && !saved.plan.baseline.stableBaseConfirmed && saved.lastConfirmed === null);
        }, COMPLETION_OBSERVATION_TIMEOUT_MS, 'ordinary-revision-invalidated-persisted-baseline');
        const baseline = labelCheckbox('我已核对设备当前值与边界');
        const protection = labelCheckbox('当前控制器在稳定的保守基线下运行');
        const start = findButton('检查并启动自动反馈');
        const propose = findButton('先审阅一轮');
        history = await aiHistory();
        if (!baseline || baseline.checked || !protection || protection.checked || !start?.disabled || !propose?.disabled || !feedbackPending()
          || writes.length !== 0 || history.length !== 0 || host.querySelector<HTMLDialogElement>('dialog')?.open) throw new Error('Ordinary command revision retained a confirmed baseline, stable-base authority, usable old observation window, or execution path.');
        record('ordinary-revision-invalidation-verified', { persistedBaselineConfirmed: false, persistedStableBaseConfirmed: false, persistedLastConfirmed: null, feedbackPending: true, writes: writes.length, aiRequests: history.length });
        passed = true; reason = '已就绪窗口经普通命令 revision 变化失效；真实 UI 与保存记录清除基线/保护确认，AI / 字节均为 0。';
      } else if (fixture.id === 'binary-ack-gate') {
        const start = findButton('检查并启动自动反馈');
        if (!start?.disabled || writes.length !== 0 || !host.textContent?.includes('ACK')) throw new Error('Binary protocol text-ACK capability gate did not block execution.');
        passed = true; reason = 'JustFloat 文本 ACK 执行入口禁用；未发送字节。';
      } else {
        await until(() => Boolean(findButton('检查并启动自动反馈') && !findButton('检查并启动自动反馈')!.disabled), 8000, 'automatic-feedback-entry-ready');
        clickButton('检查并启动自动反馈');
        await until(() => Boolean(host.querySelector<HTMLDialogElement>('dialog')?.open), 8000, 'automatic-range-authorization-dialog-open');
        record('real-approval-dialog-open', host.querySelector('.approval-copy')?.textContent);
        clickButton('确认此范围并继续');
        record('synthetic-user-approved-real-dialog');
        await until(() => !findButton('停止调参流程') && events.some(event => event.event === 'execution-state' && (event.detail as { working?: boolean })?.working === false),
          COMPLETION_OBSERVATION_TIMEOUT_MS, 'automatic-operation-final-window-and-owner-release');
        // Keep the stopped trial mounted through its deliberately late ACK. A
        // reset which merely cancels the pending callback would not test rejection.
        await sleep(fixture.id === 'stop-unconfirmed' ? 1100 : 450);
        history = await aiHistory();
        const saved = savedSession();
        if (!saved) throw new Error('No current synthetic session persisted.');
        if (writes.length !== fixture.expectedWrites) throw new Error(`Expected ${fixture.expectedWrites} wire writes; observed ${writes.length}.`);
        if (fixture.success) {
          if (saved.status !== 'completed' || !saved.bestVerified || saved.trials.filter(trial => trial.status === 'evaluated').length !== fixture.expectedWrites) throw new Error('Valid confirmed observation did not complete/evaluate the intended trial(s).');
          if (history.length !== fixture.expectedWrites || history.some(item => item.evidence.measured.sampleCount < 10)) throw new Error('AI requests lack the expected real service observation windows.');
          if (fixture.expectedWrites === 2 && (history[1].evidence.telemetryWindow.source !== 'evaluated-trial'
            || history[1].evidence.telemetryWindow.trialId !== writes[0].trialId || history[1].evidence.params.kp !== writes[0].params.kp
            || Math.abs(history[1].evidence.measured.steadyError - 1) > .001)) throw new Error('Second AI request reused a stale baseline or mixed observation window.');
        } else {
          if (saved.status === 'completed' || saved.bestVerified || saved.trials.some(trial => trial.status === 'evaluated' && fixture.expectedWrites === 1)) throw new Error('Incomplete/failed/stopped trial incorrectly promoted evaluation or completion evidence.');
          if (fixture.id !== 'stop-last-window' && (saved.plan.baseline.confirmed || saved.lastConfirmed)) throw new Error('Unknown post-write device parameters retained current authority.');
        if (fixture.id === 'stop-last-window' && (saved.trials[0]?.status !== 'failed'
          || !events.some(event => event.event === 'synthetic-stop-in-final-observation-wait'))) throw new Error('Final-window stop action did not occur or retained a successful trial state.');
        if (fixture.id === 'stop-unconfirmed' && (!events.some(event => event.event === 'synthetic-stop-during-unconfirmed-write')
          || saved.trials.filter(trial => trial.status === 'evaluated').length !== 1)) throw new Error('Unconfirmed stop did not occur after the first evaluated round.');
        if (['old-ack', 'old-readback'].includes(fixture.id) && !events.some(event => event.event === 'component-safety-stop'
          && String(event.detail).includes('没有确认写入生效'))) throw new Error('Old confirmation negative case stopped for an unrelated reason.');
        if (fixture.id === 'telemetry-expired') {
          const stoppedFeed = events.find(event => event.event === 'synthetic-telemetry-feed-stopped-after-device-confirmation');
          const safety = events.find(event => event.event === 'component-safety-stop' && String(event.detail).includes('遥测'));
          if (!stoppedFeed || !safety || safety.at < (stoppedFeed.detail as { expiresAt: number }).expiresAt
            || saved.trials[0]?.confirmationMode !== 'acknowledgement' || saved.trials.length !== 1 || history.length !== 1
            || saved.trials[0]?.status !== 'failed' || saved.status !== 'stopped') throw new Error('Telemetry expiry did not stop the confirmed original trial at its real deadline with no next AI/write.');
          record('telemetry-expiry-protection-verified', { written: 1, confirmed: true, expiryAt: (stoppedFeed.detail as { expiresAt: number }).expiresAt,
            safetyStopAt: safety.at, nextWrites: 0, nextAiRequests: 0, evaluated: 0, hardwareAcceptance: 'not-run' });
        }
        }
        passed = true; reason = fixture.success ? '冻结字节 → written → 本轮设备确认 → 新窗口评价成立。' : '旧/失败/停止证据未进入 completed；当前参数权限符合停止边界。';
      }
    }
    if (timingFailure) throw new Error(timingFailure);
  } catch (error) { passed = false; reason = error instanceof Error ? error.message : String(error); }
  const saved = savedSession();
  const result: CaseResult = { id: fixture.id, title: fixture.title, passed, reason, writes: writes.length, aiRequests: history.length, session: saved,
    events: [...events], hardwareAcceptance: 'not-run', nativeAcceptance: 'not-run' };
  results.push(result);
  renderResults();
  return result;
}
function renderResults() {
  resultsList.replaceChildren(...results.map(result => {
    const li = document.createElement('li'); li.className = result.passed ? 'passed' : 'failed';
    li.textContent = `${result.passed ? 'PASS' : 'FAIL'} · ${result.title} · ${result.reason}`; return li;
  }));
  resultOutput.textContent = JSON.stringify({ status: results.every(result => result.passed) ? 'passed' : 'failed', origin: location.origin,
    evidence: 'real-vue-component/synthetic-protocol-driver/local-ai-http', nativeAcceptance: 'not-run', hardwareAcceptance: 'not-run',
    timingContract: { sampleTimeMs: SYNTHETIC_SAMPLE_MS, browserPumpMs: SYNTHETIC_PUMP_MS, maximumTelemetryAgeSeconds: SYNTHETIC_MAX_AGE_SECONDS,
      completionObservationTimeoutMs: COMPLETION_OBSERVATION_TIMEOUT_MS,
      delivery: 'buffered-synthetic-sample-catchup-with-5s-gap-failure', subscriberDispatch: 'public-ChannelStore.flushDispatch-after-synthetic-batch', expiryCase: 'feed-stopped-after-confirmation/7s-window/5s-real-deadline' }, results }, null, 2);
}
async function runSelection(all: boolean) {
  if (runBusy) return;
  runBusy = true;
  document.querySelectorAll<HTMLButtonElement>('.controls button').forEach(button => { button.disabled = true; });
  try {
    results.splice(0);
    const selected = all ? cases : cases.filter(fixture => fixture.id === caseSelect.value);
    for (const fixture of selected) { status.textContent = `正在验证：${fixture.title}`; await runCase(fixture); }
    const failed = results.filter(result => !result.passed).length;
    status.textContent = `组件协议交互完成：${results.length - failed}/${results.length} 通过；原生 / 硬件未验收。`;
    status.className = failed ? 'failed' : 'passed';
  } finally {
    runBusy = false;
    document.querySelectorAll<HTMLButtonElement>('.controls button').forEach(button => { button.disabled = false; });
  }
}

caseSelect.replaceChildren(...cases.map(fixture => { const option = document.createElement('option'); option.value = fixture.id; option.textContent = fixture.title; return option; }));
document.querySelector<HTMLButtonElement>('#prepare-case')!.onclick = () => { if (!runBusy) void prepare(cases.find(fixture => fixture.id === caseSelect.value)!).catch(error => { status.textContent = String(error); }); };
document.querySelector<HTMLButtonElement>('#run-case')!.onclick = () => { void runSelection(false); };
document.querySelector<HTMLButtonElement>('#run-all')!.onclick = () => { void runSelection(true); };
void prepare(cases[0]).catch(error => { status.textContent = String(error); status.className = 'failed'; });
