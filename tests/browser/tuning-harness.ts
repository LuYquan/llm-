import { createApp, h, reactive, nextTick } from 'vue';
import type { App } from 'vue';
import TuningWorkbench from '../../src/components/TuningWorkbench.vue';
import { globalChannelStore } from '../../src/core/channel/ChannelStore';
import { globalProjectModel } from '../../src/core/project/ProjectModel';
import { ProtocolEngine } from '../../src/core/protocol/ProtocolEngine';
import type { ProtocolConfig } from '../../src/core/protocol/types';
import { createScenarioContext } from '../../src/core/tuning/scenarios';
import { saveTuningSession } from '../../src/core/tuning/sessionStore';
import type { TuningPlan, TuningSession } from '../../src/core/tuning/types';
import { tuningCommandBytes } from '../../src/core/tuning/commandContract';
import type { TuningCommandPayload } from '../../src/core/tuning/commandContract';
import type { AiConfig } from '../../src/services/ai';

// This guard prevents fixture code from touching the main development origin's
// local settings. The only writable browser storage is this synthetic origin.
if (location.hostname !== '127.0.0.1' || location.port !== '5191') throw new Error('Fixture requires its independent localhost:5191 origin.');

type CaseId = 'ack-two-rounds' | 'ack-before-receipt' | 'readback-before-receipt' | 'old-ack' | 'old-readback' | 'failed-write' | 'stop-last-window' | 'stop-unconfirmed' | 'binary-ack-gate' | 'ordinary-ready-gate' | 'ordinary-revision-invalidation';
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
];
type FixtureLog = { id: number; time: string; at: number; tag: string; level: string; text: string };
type FixtureReceipt = { id: string; requestId: string; sessionId: string; epoch: number; status: 'written' | 'failed'; at: number; error?: string } | null;
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
let activeRun = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let currentCase: FixtureCase = cases[0];
let events: EventRecord[] = [];
let writes: Array<{ trialId: string; params: { kp: number; ki: number; kd: number }; payload: TuningCommandPayload }> = [];
let responseError = 2;
let props: ReturnType<typeof fixtureProps>;
let parser = new ProtocolEngine('firewater');
let runBusy = false;

function fixtureProps(config: AiConfig, protocol: ProtocolConfig) {
  return reactive({ connected: true, demo: false, connectionLabel: '合成设备 · 不代表硬件验收', aiConfig: config,
    logs: [] as FixtureLog[], writeResult: null as FixtureReceipt, stopToken: 0,
    writeAccessReady: false, executionEnabled: true, protocolConfig: protocol,
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
  const output = parser.feed(bytes, Math.round(frameIndex * 10_000));
  globalChannelStore.pushProtocolOutput(output);
  for (const log of output.logs) {
    const at = Date.now();
    props.logs.push({ id: ++serial, time: new Date(at).toLocaleTimeString('zh-CN'), at, tag: '[RX]', level: log.level.toLowerCase(), text: log.text });
    record('parsed-rx-log', { logId: serial, text: log.text });
  }
}
function ingestText(text: string) { ingest(new TextEncoder().encode(text)); }
function pushTelemetry() {
  frameIndex += 1;
  if (props.protocolConfig.type === 'justfloat') {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    [10, 10 - responseError, 1].forEach((value, index) => view.setFloat32(index * 4, value, true));
    bytes.set([0, 0, 0x80, 0x7f], 12);
    ingest(bytes);
  } else ingestText(`10,${10 - responseError},1\n`);
}
function sendReadback(params: { kp: number; ki: number }) {
  ingestText(`>fixture_kp:${params.kp}\n>fixture_ki:${params.ki}\n`);
  record('parameter-ingested', { ...params, kpRevision: globalChannelStore.getChannelRevision('fixture_kp'), kiRevision: globalChannelStore.getChannelRevision('fixture_ki') });
}
function syntheticWrite(request: { trialId: string; command: string; payload: TuningCommandPayload }) {
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
  record('driver-dispatch', { trialId: request.trialId, params, hex: request.payload.hex, byteLength: bytes.length, visibleText: request.payload.visibleText,
    startParameterRevisions: { kp: globalChannelStore.getChannelRevision('fixture_kp'), ki: globalChannelStore.getChannelRevision('fixture_ki') } });
  responseError = currentCase.id === 'ack-two-rounds' || currentCase.id === 'stop-unconfirmed' ? count === 1 ? 1 : .02 : .02;
  const earlyResponse = currentCase.id === 'ack-before-receipt' || currentCase.id === 'readback-before-receipt';
  const receive = () => {
    if (currentCase.id === 'old-readback') return;
    if (currentCase.confirmation === 'parameter-channels') sendReadback(params);
    else ingestText(`PID_APPLIED ${currentCase.id === 'old-ack' ? 'fixture-previous-request' : request.trialId}\n`);
  };
  later(receive, currentCase.id === 'stop-unconfirmed' && count === 2 ? 900 : earlyResponse ? 35 : 110);
  later(() => {
    const failed = currentCase.id === 'failed-write';
    props.writeResult = { id: request.trialId, requestId: `fixture-driver-${count}`, sessionId: `fixture-session-${activeRun}`, epoch: activeRun,
      status: failed ? 'failed' : 'written', at: Date.now(), ...(failed ? { error: 'Synthetic driver write failed' } : {}) };
    // A late successful receipt cannot unlock a prior software safety stop.
    props.ordinaryWritesReady = !failed && props.executionEnabled;
    record('driver-receipt', props.writeResult);
  }, earlyResponse ? 260 : 65);
  if (currentCase.id === 'stop-unconfirmed' && count === 2) later(() => {
    clickButton('停止调参流程');
    record('synthetic-stop-during-unconfirmed-write');
  }, 180);
  if (currentCase.id === 'stop-last-window') void stopNearWindowEnd(activeRun);
}

function planFor(fixture: FixtureCase): TuningPlan {
  return {
    id: `fixture-plan-${activeRun}`, version: 1, name: fixture.title, project: '合成测试对象', description: '测试夹具的合成数据，不是设备测量或硬件证明。', prompt: '仅允许输入范围内的 PI 小幅候选。',
    route: 'feedback', mode: 'bounded-auto', loopId: 'fixture-stage', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .01,
    commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
    baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: false, stableBaseConfirmed: false },
    bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } },
    maxParameterChangePercent: 20, maximumTrials: 2, evaluationWindowSeconds: .7, maximumTelemetryAgeSeconds: .5, maximumOutputMagnitude: 10,
    channels: { setpoint: '!0', feedback: '!1', output: '!2', parameters: { kp: 'fixture_kp', ki: 'fixture_ki' } },
    units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
    confirmation: { mode: fixture.confirmation ?? 'acknowledgement', acknowledgementText: 'PID_APPLIED {request_id}', timeoutSeconds: .8, parameterTolerance: .01 },
    goal: { mode: 'settle', maximumSteadyError: .1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null },
    model: null, suite: createScenarioContext('custom', 'single', 'fixture-stage', [{ id: 'fixture-stage', title: '合成 PI 控制环', structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] }]),
  };
}

async function prepare(fixture: FixtureCase) {
  if (streamTimer) clearInterval(streamTimer);
  timers.forEach(clearTimeout); timers = [];
  component?.unmount(); component = null;
  activeRun += 1; frameIndex = 0; serial = 0; currentCase = fixture; events = []; writes = []; responseError = 2;
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
    onExecutionState: (working: boolean) => { record('execution-state', { working }); props.writeAccessReady = working; },
    onSafetyStop: (reason: string) => { record('component-safety-stop', reason); props.ordinaryWritesReady = false; props.executionEnabled = false; props.stopToken += 1; },
    onOpenProtocolSettings: () => record('open-protocol-settings'),
    onOpenAiSettings: () => record('open-ai-settings'),
  }) });
  component.mount(host);
  streamTimer = setInterval(pushTelemetry, 10);
  await nextTick();
  record('prepared', { id: fixture.id, origin: location.origin, syntheticAuthorization: true, hardwareAcceptance: 'not-run' });
  status.textContent = `已准备：${fixture.title}`;
  status.className = 'status';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() <= deadline) { if (predicate()) return; await sleep(20); }
  throw new Error(`Timed out; visible component state: ${host.textContent?.slice(0, 1600)}`);
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
async function stopNearWindowEnd(run: number) {
  await until(() => Boolean(host.querySelector('.working-message')?.textContent?.includes('等待 0.7 秒')));
  if (activeRun !== run) return;
  later(() => { clickButton('停止调参流程'); record('synthetic-stop-in-final-observation-wait'); }, 650);
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
      await until(() => Boolean(savedSession() && !savedSession()!.plan.baseline.confirmed && !savedSession()!.plan.baseline.stableBaseConfirmed && savedSession()!.lastConfirmed === null));
      history = await aiHistory();
      if (baseline.checked || writes.length !== 0 || history.length !== 0 || host.querySelector<HTMLDialogElement>('dialog')?.open || !feedbackPending()) throw new Error('Disabled ordinary-write gate created baseline authority, AI requests, authorization, or device bytes.');
      record('ordinary-ready-gate-verified', { baselineDisabled: baseline.disabled, startDisabled: start.disabled, proposeDisabled: propose.disabled, writes: writes.length, aiRequests: history.length });
      passed = true; reason = '普通写入未结束时真实复选框与反馈入口禁用；保存基线未确认，AI / 字节均为 0。';
    } else {
      checkLabel('我已核对设备当前值与边界');
      await nextTick();
      checkLabel('当前控制器在稳定的保守基线下运行');
      await sleep(1000);
      if (fixture.id === 'ordinary-revision-invalidation') {
        await until(() => Boolean(findButton('检查并启动自动反馈') && !findButton('检查并启动自动反馈')!.disabled && !feedbackPending()));
        await until(() => Boolean(savedSession()?.plan.baseline.confirmed && savedSession()?.plan.baseline.stableBaseConfirmed));
        const savedBefore = savedSession()!;
        record('baseline-window-ready-before-ordinary-command', { updatedAt: savedBefore.updatedAt, baseline: savedBefore.plan.baseline, feedbackPending: false });
        props.ordinaryWriteRevision += 1;
        record('ordinary-command-revision', { revision: props.ordinaryWriteRevision });
        await nextTick();
        await until(() => {
          const saved = savedSession();
          return Boolean(saved && saved.updatedAt > savedBefore.updatedAt && !saved.plan.baseline.confirmed && !saved.plan.baseline.stableBaseConfirmed && saved.lastConfirmed === null);
        });
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
        await until(() => Boolean(findButton('检查并启动自动反馈') && !findButton('检查并启动自动反馈')!.disabled));
        clickButton('检查并启动自动反馈');
        await until(() => Boolean(host.querySelector<HTMLDialogElement>('dialog')?.open));
        record('real-approval-dialog-open', host.querySelector('.approval-copy')?.textContent);
        clickButton('确认此范围并继续');
        record('synthetic-user-approved-real-dialog');
        await until(() => !findButton('停止调参流程') && events.some(event => event.event === 'execution-state' && (event.detail as { working?: boolean })?.working === false), 10_000);
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
          if (fixture.id === 'stop-last-window' && saved.trials[0]?.status !== 'failed') throw new Error('Interrupted observation retained a successful trial state.');
        }
        passed = true; reason = fixture.success ? '冻结字节 → written → 本轮设备确认 → 新窗口评价成立。' : '旧/失败/停止证据未进入 completed；当前参数权限符合停止边界。';
      }
    }
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
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
    evidence: 'real-vue-component/synthetic-protocol-driver/local-ai-http', nativeAcceptance: 'not-run', hardwareAcceptance: 'not-run', results }, null, 2);
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
