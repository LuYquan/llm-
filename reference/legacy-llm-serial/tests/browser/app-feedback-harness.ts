import { createApp, nextTick } from 'vue';
import App from '../../src/App.vue';
import '../../src/style.css';
import { TransportFactory } from '../../src/services/transport/factory';
import { WebSerialTransport } from '../../src/services/transport/web-serial-transport';
import { saveBrowserWorkspace } from '../../src/services/workspace/browser-storage';
import { createDefaultVofaPreset } from '../../src/core/widget/schema';
import { createScenarioContext } from '../../src/core/tuning/scenarios';
import { saveTuningSession } from '../../src/core/tuning/sessionStore';
import { globalProjectModel } from '../../src/core/project/ProjectModel';
import { globalChannelStore } from '../../src/core/channel/ChannelStore';
import type { TuningPlan, TuningSession } from '../../src/core/tuning/types';

// This origin owns only synthetic configuration. No real browser port is exposed.
if (location.origin !== 'http://127.0.0.1:5197') throw new Error('App feedback fixture requires isolated localhost:5197');
const caseIds = ['two-rounds', 'early-ack', 'stale-ack', 'failed-write', 'stop-observation', 'stop-write'] as const;
type CaseId = typeof caseIds[number];
const selected = localStorage.getItem('fixture.app-feedback.case');
const caseId: CaseId = caseIds.includes(selected as CaseId) ? selected as CaseId : 'two-rounds';
const planId = 'app-feedback-plan';
const model = `app-feedback-${caseId}-${crypto.randomUUID()}`;
const events: Array<{ at: number; event: string; detail?: unknown }> = [];
const runtimeErrors: string[] = [];
const record = (event: string, detail?: unknown) => events.push({ at: Date.now(), event, detail });
window.addEventListener('error', event => runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => runtimeErrors.push(String(event.reason)));
const OriginalWorker = window.Worker;
window.Worker = class extends OriginalWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); record('real-worker-created', { url: String(url), type: options?.type }); }
};

const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let opened = false;
let error = 2;
let writes = 0;
let stopWrites = 0;
const bytesToDevice: Array<{ text: string; hex: string; params?: { kp: number; ki: number; kd: number } }> = [];
const ingest = (text: string) => { if (opened && controller) { controller.enqueue(encoder.encode(text)); if (text.startsWith('PID_APPLIED')) record('synthetic-rx-ack-bytes', text.trim()); } };
// The response is a scripted sequence of numbers, not a physical plant model.
const port = {
  readable: null as ReadableStream<Uint8Array> | null,
  writable: null as WritableStream<Uint8Array> | null,
  getInfo: () => ({ usbVendorId: 0xf17e, usbProductId: 1 }),
  async open(options: unknown) {
    opened = true; record('synthetic-port-open', options);
    this.readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { controller = null; } });
    this.writable = new WritableStream<Uint8Array>({
      async write(data) {
        const text = new TextDecoder().decode(data);
        const hex = Array.from(data, value => value.toString(16).padStart(2, '0')).join(' ');
        if (text === 'STOP\n') { stopWrites++; bytesToDevice.push({ text, hex }); record('synthetic-stop-write'); return; }
        const [prefix, requestId, kp, ki, kd] = text.trim().split(',');
        if (prefix !== 'PID' || !requestId || ![kp, ki, kd].every(value => Number.isFinite(Number(value)))) throw new Error('Fixture rejects unexpected wire command');
        const params = { kp: Number(kp), ki: Number(ki), kd: Number(kd) };
        writes++; bytesToDevice.push({ text, hex, params }); record('synthetic-pid-write-start', { requestId, params, count: writes });
        error = caseId === 'two-rounds' ? writes === 1 ? 1 : .02 : .02;
        setTimeout(() => ingest(`PID_APPLIED ${caseId === 'stale-ack' ? 'previous-request' : requestId}\n`), 30);
        await new Promise(resolve => setTimeout(resolve, caseId === 'stop-write' ? 1800 : caseId === 'early-ack' ? 1000 : caseId === 'failed-write' ? 260 : 65));
        if (caseId === 'failed-write') { record('synthetic-pid-write-failed', requestId); throw new Error('Synthetic WritableStream rejected this write'); }
        record('synthetic-pid-write-complete', requestId);
      },
    });
    timer = setInterval(() => ingest(`10,${10 - error},1\n`), 20);
  },
  async close() { opened = false; if (timer) clearInterval(timer); timer = null; controller = null; record('synthetic-port-close'); },
  async setSignals() {}, async getSignals() { return { dataCarrierDetect: true, clearToSend: true, ringIndicator: false, dataSetReady: true }; },
};
Object.defineProperty(navigator, 'serial', { configurable: true, value: {
  getPorts: async () => [port], requestPort: async () => port,
  addEventListener() {}, removeEventListener() {},
} });
const driver = new WebSerialTransport();
const available = await driver.listPorts();
const syntheticPort = available.find(value => value.id !== 'mock' && value.id !== 'VIRTUAL_COM');
if (!syntheticPort) throw new Error('Real WebSerialTransport did not enumerate synthetic port');
TransportFactory.create = async () => driver;
const realWrite = driver.write.bind(driver);
driver.write = async bytes => {
  record('real-transport-write-called', { byteCount: bytes.length });
  try { const receipt = await realWrite(bytes); record('real-transport-written-receipt', receipt); return receipt; }
  catch (reason) { record('real-transport-write-rejected', String(reason)); throw reason; }
};
driver.onStatusChange(status => record('real-transport-status', status));
driver.onBatch(batch => { for (const log of batch.logLines) record('real-parser-rx-log', log); });
let parsedBatchCount = 0;
driver.onWaveformBatch(batch => { parsedBatchCount++; if (parsedBatchCount === 1) record('real-waveform-first-batch', { sessionId: batch.session_id, epoch: batch.channel_epoch, channels: batch.channel_names }); });

const plan: TuningPlan = {
  id: planId, version: 1, name: '实际 App 合成 PI 反馈', project: '合成测试对象', description: '独立软件集成验收；没有物理模型或硬件证明。', prompt: '只允许当前 PI 参数的 10% 小幅候选。',
  route: 'feedback', mode: 'bounded-auto', loopId: 'fixture-stage', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .02,
  commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
  baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: false, stableBaseConfirmed: false },
  bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } },
  maxParameterChangePercent: 20, maximumTrials: 2, evaluationWindowSeconds: caseId === 'stop-observation' || caseId === 'two-rounds' ? 3 : .7,
  maximumTelemetryAgeSeconds: .5, maximumOutputMagnitude: 10,
  channels: { setpoint: 'setpoint', feedback: 'actual', output: 'output', parameters: { kp: 'app_kp', ki: 'app_ki' } },
  units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
  confirmation: { mode: 'acknowledgement', acknowledgementText: 'PID_APPLIED {request_id}', timeoutSeconds: .8, parameterTolerance: .01 },
  goal: { mode: 'settle', maximumSteadyError: .1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null },
  model: null, suite: createScenarioContext('custom', 'single', 'fixture-stage', [{ id: 'fixture-stage', title: '合成 PI 控制环', structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] }]),
};
const session: TuningSession = { id: planId, scenarioGroupId: planId, plan, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null,
  formDraft: { modelSource: 'transfer', numerator: '', denominator: '', delay: '', parameters: { kp: '2', ki: '0.5', kd: '0' } } };
localStorage.removeItem('llm-serial-tuning-sessions-v1');
if (!saveTuningSession(session)) throw new Error('Synthetic plan failed real configuration validation');
globalProjectModel.addLoop({ id: 'fixture-stage', name: '合成 PI 控制环', order: 0, structure: 'PI', plant_family: 'first_order', channels: { setpoint: 'setpoint', feedback: 'actual', output: 'output' }, param_limits: { kp: [0, 10], ki: [0, 2], kd: [0, 0] }, cmd_template: plan.commandTemplate, state: 'untuned' });
localStorage.setItem('llm-serial.vofa-dashboard.v2', JSON.stringify(createDefaultVofaPreset()));
await saveBrowserWorkspace(JSON.stringify({
  port_name: syntheticPort.id, mode: 'serial', baud_rate: 115200, protocol_config: { type: 'firewater' }, quick_commands: [], emergency_command: 'STOP\\n',
  ai_config: { provider: 'openai', api_url: `${location.origin}/fixture-ai/v1`, model, api_key: 'synthetic-fixture-key', api_key_configured: false },
}));
document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark');
const style = document.createElement('style');
style.textContent = 'html,body{height:100%;overflow:hidden}#app{height:calc(100% - 56px)}#app>.workbench-vofa-app{height:100%;width:100%}#fixture-bar{height:56px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:6px;color:var(--text-main);background:var(--bg-base);font:12px sans-serif;border-top:1px solid var(--border-strong)}#fixture-bar button,#fixture-bar select{color:var(--text-main);background:var(--bg-surface);border:1px solid var(--border-strong);padding:5px}#fixture-bar details[open]{position:absolute;bottom:0;right:0;z-index:300;background:var(--bg-base);width:600px;max-width:90vw}#fixture-proof{display:block;max-height:400px;overflow:auto;white-space:pre-wrap;font:11px monospace}';
document.head.append(style);
createApp(App).mount('#app'); record('real-App-mounted', { caseId, model, portId: syntheticPort.id });
(document.getElementById('fixture-case') as HTMLSelectElement).value = caseId;
document.getElementById('prepare-case')!.addEventListener('click', () => { localStorage.setItem('fixture.app-feedback.case', (document.getElementById('fixture-case') as HTMLSelectElement).value); location.reload(); });
document.getElementById('capture-proof')!.addEventListener('click', async () => {
  await nextTick();
  const history = await fetch(`/fixture-ai/history?model=${encodeURIComponent(model)}`).then(response => response.json());
  const stored: TuningSession[] = JSON.parse(localStorage.getItem('llm-serial-tuning-sessions-v1') ?? '[]');
  document.getElementById('fixture-proof')!.textContent = JSON.stringify({
    testType: 'real-App-real-WebSerialTransport-real-parser-synthetic-port', origin: location.origin, caseId, model,
    nativeInteractive: 'not-run', hardware: 'not-run', liveAi: 'not-run', jevCalls: 0,
    scriptedResponse: true, writes, stopWrites, bytesToDevice, parsedBatchCount,
    context: globalChannelStore.getSessionContext(), history, session: stored.find(value => value.id === planId),
    runtimeErrors, events, visibleAppText: document.getElementById('app')!.textContent,
  }, null, 2);
});
