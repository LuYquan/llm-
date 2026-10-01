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
import type { WorkerOutMessage } from '../../src/services/transport/worker/types';

// This independent origin exposes only our scripted byte stream, never a real port.
if (location.origin !== 'http://127.0.0.1:5198') throw new Error('ACK causality fixture requires isolated localhost:5198');
const caseIds = ['delayed-prewrite-ack', 'split-prewrite-ack', 'postwrite-early-ack'] as const;
type CaseId = typeof caseIds[number];
const selected = localStorage.getItem('fixture.ack-causality.case');
const caseId: CaseId = caseIds.includes(selected as CaseId) ? selected as CaseId : 'delayed-prewrite-ack';
const planId = 'ack-causality-plan';
const model = `ack-causality-${caseId}-${crypto.randomUUID()}`;
const events: Array<{ at: number; event: string; detail?: unknown }> = [];
const runtimeErrors: string[] = [];
const record = (event: string, detail?: unknown) => events.push({ at: Date.now(), event, detail });
window.addEventListener('error', event => runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => runtimeErrors.push(String(event.reason)));
let holdAck = false;
const heldAcks: Array<{ message: WorkerOutMessage; release: () => void }> = [];
const NativeWorker = window.Worker;
// The native module Worker performs all parsing. Only delivery of its already
// parsed ACK logs is delayed. Other logs, samples, frames and controls still pass.
// Every field on each real log is retained, including future provenance fields.
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    record('real-worker-created', { url: String(url), type: options?.type });
    let consumer: ((this: Worker, event: MessageEvent<WorkerOutMessage>) => unknown) | null = null;
    Object.defineProperty(this, 'onmessage', { configurable: true,
      get: () => consumer,
      set: (value: typeof consumer) => { consumer = value; },
    });
    this.addEventListener('message', (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      if (msg?.type !== 'BATCH') { consumer?.call(this, event); return; }
      const acks = msg.batch.logLines.filter(log => log.text.startsWith('PID_APPLIED '));
      if (acks.length) record('real-worker-ack-parsed', { logs: acks, held: holdAck });
      if (!holdAck || !acks.length) { consumer?.call(this, event); return; }
      const remaining = msg.batch.logLines.filter(log => !log.text.startsWith('PID_APPLIED '));
      const delivered: WorkerOutMessage = { ...msg, batch: { ...msg.batch, logLines: remaining } };
      if (remaining.length || msg.batch.samples.length || msg.batch.frames?.length || msg.batch.droppedBytes || msg.batch.protocolErrors) {
        consumer?.call(this, new MessageEvent('message', { data: delivered }));
      }
      const held: WorkerOutMessage = { ...msg, batch: { ...msg.batch, samples: [], frames: undefined, logLines: acks, droppedBytes: 0, protocolErrors: 0 } };
      heldAcks.push({ message: held, release: () => consumer?.call(this, new MessageEvent('message', { data: held })) });
      record('real-worker-ack-delivery-held', held);
    });
  }
};

const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let opened = false;
let pausedForPrefix = false;
let error = 2;
let writes = 0;
let stopWrites = 0;
let preparedRequestId: string | null = null;
let pendingSuffix: string | null = null;
const bytesToDevice: Array<{ text: string; hex: string; params?: { kp: number; ki: number; kd: number } }> = [];
const ingest = (text: string, event = 'synthetic-rx-bytes') => {
  if (!opened || !controller) throw new Error('Synthetic port must be connected before fixture RX');
  controller.enqueue(encoder.encode(text));
  if (event !== 'synthetic-rx-telemetry') record(event, { text, byteCount: encoder.encode(text).length });
};
const port = {
  readable: null as ReadableStream<Uint8Array> | null,
  writable: null as WritableStream<Uint8Array> | null,
  getInfo: () => ({ usbVendorId: 0xf17e, usbProductId: 2 }),
  async open(options: unknown) {
    opened = true; record('synthetic-port-open', options);
    this.readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { controller = null; } });
    this.writable = new WritableStream<Uint8Array>({ async write(data) {
      const text = new TextDecoder().decode(data);
      const hex = Array.from(data, value => value.toString(16).padStart(2, '0')).join(' ');
      if (text === 'STOP\n') { stopWrites++; bytesToDevice.push({ text, hex }); record('synthetic-stop-write'); return; }
      const [prefix, requestId, kp, ki, kd] = text.trim().split(',');
      if (prefix !== 'PID' || !requestId || ![kp, ki, kd].every(value => Number.isFinite(Number(value)))) throw new Error('Fixture rejects unexpected wire command');
      const params = { kp: Number(kp), ki: Number(ki), kd: Number(kd) };
      writes++; bytesToDevice.push({ text, hex, params }); record('synthetic-pid-write-start', { requestId, params, count: writes });
      error = .02;
      if (caseId === 'split-prewrite-ack') {
        if (preparedRequestId !== requestId || !pendingSuffix) throw new Error('Prepare matching prewrite prefix using visible approval before sending');
        ingest(pendingSuffix, 'synthetic-rx-postwrite-ack-suffix'); pendingSuffix = null; pausedForPrefix = false;
      } else if (caseId === 'postwrite-early-ack') {
        setTimeout(() => ingest(`PID_APPLIED ${requestId}\n`, 'synthetic-rx-postwrite-ack'), 30);
      } else if (preparedRequestId !== requestId) {
        throw new Error('Prepare matching parsed prewrite ACK using visible approval before sending');
      }
      await new Promise(resolve => setTimeout(resolve, caseId === 'postwrite-early-ack' ? 1000 : 65));
      record('synthetic-pid-write-complete', requestId);
    } });
    timer = setInterval(() => { if (opened && controller && !pausedForPrefix) ingest(`10,${10 - error},1\n`, 'synthetic-rx-telemetry'); }, 20);
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
driver.onWriteResult(result => record('real-transport-write-result', result));
driver.onBatch(batch => { for (const log of batch.logLines) record('real-parser-rx-log-delivered', log); });
let parsedBatchCount = 0;
driver.onWaveformBatch(batch => { parsedBatchCount++; if (parsedBatchCount === 1) record('real-waveform-first-batch', { sessionId: batch.session_id, epoch: batch.channel_epoch, channels: batch.channel_names }); });

const plan: TuningPlan = {
  id: planId, version: 1, name: '实际 App ACK 因果验收', project: 'ACK 因果合成测试对象', description: '独立软件集成验收；没有物理模型或硬件证明。', prompt: '只允许当前 PI 参数的 10% 小幅候选。',
  route: 'feedback', mode: 'manual', loopId: 'fixture-stage', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .02,
  commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
  baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: false, stableBaseConfirmed: false },
  bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } },
  maxParameterChangePercent: 20, maximumTrials: 1, evaluationWindowSeconds: .7,
  maximumTelemetryAgeSeconds: 2, maximumOutputMagnitude: 10,
  channels: { setpoint: 'setpoint', feedback: 'actual', output: 'output', parameters: { kp: 'app_kp', ki: 'app_ki' } },
  units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
  confirmation: { mode: 'acknowledgement', acknowledgementText: 'PID_APPLIED {request_id}', timeoutSeconds: 3, parameterTolerance: .01 },
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
style.textContent = 'html,body{height:100%;overflow:hidden}#app{height:calc(100% - 80px)}#app>.workbench-vofa-app{height:100%;width:100%}#fixture-bar{height:80px;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px;color:var(--text-main);background:var(--bg-base);font:12px sans-serif;border-top:1px solid var(--border-strong)}#fixture-bar button,#fixture-bar select,.fixture-approval-controls button{color:var(--text-main);background:var(--bg-surface);border:1px solid var(--border-strong);padding:5px}#fixture-bar details[open]{position:absolute;bottom:0;right:0;z-index:300;background:var(--bg-base);width:700px;max-width:90vw}#fixture-proof{display:block;max-height:400px;overflow:auto;white-space:pre-wrap;font:11px monospace}.fixture-approval-controls{margin:12px 0;padding:10px;border:1px dashed var(--border-strong);font:12px sans-serif}.fixture-approval-controls p{white-space:normal;margin:0 0 8px}.fixture-approval-controls output{display:block;margin-top:6px}';
document.head.append(style);
createApp(App).mount('#app'); record('real-App-mounted', { caseId, model, portId: syntheticPort.id });

function visibleRequestId(dialog: HTMLDialogElement): string {
  const visibleCopy = dialog.querySelector('.approval-copy')?.textContent ?? '';
  const match = visibleCopy.match(/PID,([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}),/i);
  if (!dialog.open || !match) throw new Error('Final visible command approval with UUID is required');
  record('visible-approval-command-read', { requestId: match[1], visibleCopy });
  return match[1];
}
function preparePrewrite(dialog: HTMLDialogElement, output: HTMLOutputElement): void {
  if (caseId === 'postwrite-early-ack') throw new Error('Positive case does not prepare a prewrite ACK');
  if (preparedRequestId) throw new Error('ACK preparation is single use; reload for another trial');
  const requestId = visibleRequestId(dialog); preparedRequestId = requestId;
  if (caseId === 'delayed-prewrite-ack') {
    holdAck = true;
    ingest(`PID_APPLIED ${requestId}\n`, 'synthetic-rx-prewrite-complete-ack');
    output.textContent = '已输入真实串口流。请等到下面显示 Worker 已解析并缓存，再批准发送。';
    const update = setInterval(() => {
      if (heldAcks.length) { output.textContent = `真实 Worker 已解析并缓存 ${heldAcks.length} 个 ACK 批次；遥测继续正常派发。现在可批准发送，再用底部按钮放行。`; clearInterval(update); }
      if (!dialog.open) clearInterval(update);
    }, 20);
  } else {
    pausedForPrefix = true;
    const prefix = `PID_APPLIED ${requestId.slice(0, -4)}`;
    pendingSuffix = `${requestId.slice(-4)}\n`;
    ingest(prefix, 'synthetic-rx-prewrite-ack-prefix');
    output.textContent = '真实串口流已输入无换行 ACK 前缀，暂时暂停遥测避免混入同一行。请立即批准发送；真实 write 会输入后缀并恢复遥测。';
  }
}
// Modal dialogs correctly prevent clicks outside them. Own synthetic controls
// are visibly inserted inside the actual final approval dialog; no Vue state is
// inspected, mutated or authorized. The user still approves the normal button.
const approvalObserver = new MutationObserver(() => {
  const dialog = document.querySelector<HTMLDialogElement>('#app dialog.approval-dialog[open]');
  if (!dialog || dialog.querySelector('.fixture-approval-controls')) return;
  if (!/可见文本：\s*"?PID,/.test(dialog.querySelector('.approval-copy')?.textContent ?? '')) return;
  const controls = document.createElement('section'); controls.className = 'fixture-approval-controls'; controls.setAttribute('aria-label', '发送审批内的合成 ACK 控件');
  const caption = document.createElement('p'); caption.textContent = '独立测试夹具：这里只操作合成字节流，不批准发送、不操作 Vue 内部状态。'; controls.append(caption);
  const output = document.createElement('output'); output.setAttribute('aria-label', '发送前 ACK 准备状态');
  if (caseId === 'postwrite-early-ack') output.textContent = '正向用例：批准真实发送后，合成端输入精准 ACK；实际 written 回执延迟 1 秒。';
  else {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = caseId === 'delayed-prewrite-ack' ? '输入审批中的完整 ACK 并暂缓派发' : '输入审批中的 ACK 前缀（无换行）';
    button.addEventListener('click', () => { try { preparePrewrite(dialog, output); button.disabled = true; } catch (reason) { output.textContent = String(reason); record('fixture-control-error', String(reason)); } }); controls.append(button);
  }
  controls.append(output); dialog.querySelector('.approval-actions')?.before(controls);
});
approvalObserver.observe(document.getElementById('app')!, { subtree: true, attributes: true, attributeFilter: ['open'], childList: true, characterData: true });
(document.getElementById('fixture-case') as HTMLSelectElement).value = caseId;
document.getElementById('prepare-case')!.addEventListener('click', () => { localStorage.setItem('fixture.ack-causality.case', (document.getElementById('fixture-case') as HTMLSelectElement).value); location.reload(); });
document.getElementById('release-ack')!.addEventListener('click', () => {
  holdAck = false; const held = heldAcks.splice(0); record('fixture-release-held-acks', { count: held.length, writes });
  for (const item of held) { record('real-worker-held-ack-delivered', item.message); item.release(); }
});
document.getElementById('capture-proof')!.addEventListener('click', async () => {
  await nextTick();
  const history = await fetch(`/fixture-ai/history?model=${encodeURIComponent(model)}`).then(response => response.json());
  const stored: TuningSession[] = JSON.parse(localStorage.getItem('llm-serial-tuning-sessions-v1') ?? '[]');
  document.getElementById('fixture-proof')!.textContent = JSON.stringify({
    testType: 'real-App-real-WebSerialTransport-real-module-parser-synthetic-port-ACK-causality', origin: location.origin, caseId, model,
    nativeInteractive: 'not-run', hardware: 'not-run', liveAi: 'not-run', jevCalls: 0,
    scriptedResponse: true, writes, stopWrites, bytesToDevice, parsedBatchCount, preparedRequestId, pendingSuffix, heldAckCount: heldAcks.length,
    deliverySubstitute: 'only already parsed ACK logs are held; actual samples and all real log provenance fields are retained',
    context: globalChannelStore.getSessionContext(), history, session: stored.find(value => value.id === planId),
    runtimeErrors, events, visibleAppText: document.getElementById('app')!.textContent,
  }, null, 2);
});
