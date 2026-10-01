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
import type { ChannelViewBatch, ChannelSubscriber, SubscribeOptions } from '../../src/core/channel/types';
import type { TuningPlan, TuningSession } from '../../src/core/tuning/types';

// These independent origins expose only literal fixture bytes and local HTTP.
if (location.hostname !== '127.0.0.1' || !['5202', '5203'].includes(location.port)) {
  throw new Error('Background delivery fixture requires independent localhost:5202 or baseline localhost:5203');
}
const caseIds = ['normal', 'confirmation-timeout', 'output-limit'] as const;
type CaseId = typeof caseIds[number];
const selected = localStorage.getItem('fixture.background-delivery.case');
const caseId: CaseId = caseIds.includes(selected as CaseId) ? selected as CaseId : 'normal';
const planId = 'background-delivery-plan';
const model = `background-delivery-${caseId}-${crypto.randomUUID()}`;
const channels = ['setpoint', 'actual', 'output', 'ch3', 'ch4'];
const events: Array<{ at: number; event: string; detail?: unknown }> = [];
const runtimeErrors: string[] = [];
const record = (event: string, detail?: unknown) => events.push({ at: Date.now(), event, detail });
const status = (text: string) => { document.getElementById('fixture-control-status')!.textContent = text; };
window.addEventListener('error', event => runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => runtimeErrors.push(String(event.reason)));
const visibilityEvents: Array<{ at: number; visibilityState: DocumentVisibilityState; hidden: boolean }> = [];
const recordVisibility = () => {
  const value = { at: Date.now(), visibilityState: document.visibilityState, hidden: document.hidden };
  visibilityEvents.push(value); record('actual-visibility-state', value);
};
recordVisibility();
document.addEventListener('visibilitychange', recordVisibility);
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); record('real-worker-created', { url: String(url), type: options?.type });
  }
};

// All requested frames use fixture handles. Holding frames never changes clocks,
// timers, ingestion, or any product safety limit.
const nativeRequestFrame = window.requestAnimationFrame.bind(window);
const nativeCancelFrame = window.cancelAnimationFrame.bind(window);
let framesHeld = false;
let nextFrameHandle = -1;
const frameQueue = new Map<number, { callback: FrameRequestCallback; nativeHandle: number | null; requestedAt: number }>();
const frameStats = { requested: 0, delivered: 0, queuedWhileHeld: 0, cancelled: 0, cancelledWhileHeld: 0, rescheduledOnResume: 0 };
function scheduleNativeFrame(handle: number) {
  const entry = frameQueue.get(handle);
  if (!entry) return;
  entry.nativeHandle = nativeRequestFrame(timestamp => {
    const active = frameQueue.get(handle);
    if (!active) return;
    active.nativeHandle = null;
    if (framesHeld) { frameStats.queuedWhileHeld++; return; }
    frameQueue.delete(handle); frameStats.delivered++; active.callback(timestamp);
  });
}
window.requestAnimationFrame = callback => {
  const handle = nextFrameHandle--;
  frameStats.requested++;
  frameQueue.set(handle, { callback, nativeHandle: null, requestedAt: Date.now() });
  if (framesHeld) frameStats.queuedWhileHeld++;
  else scheduleNativeFrame(handle);
  return handle;
};
window.cancelAnimationFrame = handle => {
  const entry = frameQueue.get(handle);
  if (!entry) { if (handle >= 0) nativeCancelFrame(handle); return; }
  if (entry.nativeHandle !== null) nativeCancelFrame(entry.nativeHandle);
  frameQueue.delete(handle); frameStats.cancelled++;
  if (framesHeld) frameStats.cancelledWhileHeld++;
};
function holdFrames() {
  framesHeld = true;
  let moved = 0;
  for (const entry of frameQueue.values()) {
    if (entry.nativeHandle !== null) {
      nativeCancelFrame(entry.nativeHandle); entry.nativeHandle = null; moved++;
    }
  }
  frameStats.queuedWhileHeld += moved;
  record('fixture-all-raf-held', { queued: frameQueue.size, moved });
  status('全部 rAF 已截留；真实计时器、Worker 与原始入库继续。');
}
function resumeFrames() {
  framesHeld = false;
  let rescheduled = 0;
  for (const [handle, entry] of frameQueue) {
    if (entry.nativeHandle === null) { scheduleNativeFrame(handle); rescheduled++; }
  }
  frameStats.rescheduledOnResume += rescheduled;
  record('fixture-all-raf-resumed', { rescheduled });
  status('rAF 已恢复；仍待下一次浏览器真实帧。');
}

type BatchSummary = {
  callbackArrivedAt: number; deliveredAt: number | null; batchTimestamp: number; generation: number; updatedChannelIds: string[];
  updatedAtMs: Record<string, number>; updatedRevisions: Record<string, number>;
  latest: ChannelViewBatch['latest']; counts: Record<string, number>;
};
type SubscriberRecord = {
  id: number; channelIds: string[]; options: SubscribeOptions; active: boolean;
  callbackArrivals: number; deliveredCount: number; heldCount: number; discardedHeldCount: number;
  lastDelivered: BatchSummary | null; lastHeld: BatchSummary | null;
};
let subscribersHeld = false;
let nextSubscriberId = 1;
const subscriberRecords: SubscriberRecord[] = [];
const originalSubscribe = globalChannelStore.subscribe.bind(globalChannelStore);
function summarizeBatch(batch: ChannelViewBatch): BatchSummary {
  return {
    callbackArrivedAt: Date.now(), deliveredAt: null, batchTimestamp: batch.timestamp, generation: batch.generation,
    updatedChannelIds: [...batch.updatedChannelIds], updatedAtMs: { ...batch.updatedAtMs },
    updatedRevisions: { ...batch.updatedRevisions },
    latest: Object.fromEntries(Object.entries(batch.latest).map(([key, point]) => [key, point ? { ...point } : undefined])),
    counts: Object.fromEntries(Object.entries(batch.views).map(([key, view]) => [key, view.count])),
  };
}
// Explicitly wrap actual subscribers before App mounts. Only callback delivery is
// withheld. Raw buffers and the actual ChannelStore scheduler remain unmodified.
globalChannelStore.subscribe = (ids: string[], callback: ChannelSubscriber, options: SubscribeOptions = {}) => {
  const entry: SubscriberRecord = {
    id: nextSubscriberId++, channelIds: [...ids], options: { ...options }, active: true,
    callbackArrivals: 0, deliveredCount: 0, heldCount: 0, discardedHeldCount: 0,
    lastDelivered: null, lastHeld: null,
  };
  subscriberRecords.push(entry);
  const unsubscribe = originalSubscribe(ids, batch => {
    entry.callbackArrivals++;
    const summary = summarizeBatch(batch);
    if (subscribersHeld) { entry.heldCount++; entry.lastHeld = summary; return; }
    summary.deliveredAt = Date.now(); entry.deliveredCount++; entry.lastDelivered = summary; callback(batch);
  }, options);
  return () => { entry.active = false; entry.lastHeld = null; unsubscribe(); };
};
function holdSubscribers() {
  subscribersHeld = true;
  record('fixture-subscriber-deliveries-held');
  status('实际 ChannelStore 订阅回调已截留；UI 缓存停止更新，真实原始入库继续。');
}
function resumeSubscribers() {
  subscribersHeld = false;
  const discarded = subscriberRecords.reduce((total, entry) => {
    const count = entry.heldCount - entry.discardedHeldCount;
    entry.discardedHeldCount = entry.heldCount; entry.lastHeld = null; return total + count;
  }, 0);
  record('fixture-subscriber-deliveries-resumed', { discarded, replayed: 0 });
  status('订阅已恢复；截留批次已丢弃，只等待下一次自然分发。');
}

type RawObservation = { point: { t: number; v: number }; updatedAtMs: number; revision: number; generation: number };
const observationStore = globalChannelStore as unknown as { observeLatest?: (channel: string) => RawObservation | undefined };
function captureRawObservations(now = Date.now()) {
  return Object.fromEntries(channels.map(channel => {
    const observation = observationStore.observeLatest?.(channel);
    return [channel, observation ? {
      ...observation, point: { ...observation.point }, ageMs: now - observation.updatedAtMs,
      finite: [observation.point.t, observation.point.v, observation.updatedAtMs, observation.revision, observation.generation].every(Number.isFinite),
      sameCurrentGeneration: observation.generation === globalChannelStore.getGeneration(),
    } : { observation: null, legacyLatestPoint: globalChannelStore.latest(channel) ?? null }];
  }));
}

const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let opened = false;
let rxPaused = false;
let writeHeld = false;
let error = 2;
let output = 1;
let currentParams = { kp: 2, ki: .5, kd: 0 };
let writes = 0;
let stopWrites = 0;
let rxFrameCount = 0;
let rxByteCount = 0;
let lastLiteralFrame: { at: number; text: string } | null = null;
const portCounts = { enumerations: 0, requested: 0, opened: 0, closed: 0 };
const bytesToDevice: Array<{ at: number; text: string; hex: string; params?: typeof currentParams }> = [];
const pendingWrites: Array<{ requestId: string; resolve: () => void; reject: (reason: Error) => void }> = [];
function emitLiteralFrame() {
  if (!opened || !controller || rxPaused) return;
  const text = `10,${10 - error},${output},${currentParams.kp},${currentParams.ki}\n`;
  const bytes = encoder.encode(text);
  controller.enqueue(bytes); rxFrameCount++; rxByteCount += bytes.length;
  lastLiteralFrame = { at: Date.now(), text };
  if (rxFrameCount === 1) record('synthetic-first-literal-frame', lastLiteralFrame);
}
const port = {
  readable: null as ReadableStream<Uint8Array> | null,
  writable: null as WritableStream<Uint8Array> | null,
  getInfo: () => ({ usbVendorId: 0xf17e, usbProductId: 5 }),
  async open(options: unknown) {
    opened = true; portCounts.opened++; record('synthetic-port-open', options);
    this.readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { controller = null; } });
    this.writable = new WritableStream<Uint8Array>({ async write(data) {
      const text = new TextDecoder().decode(data);
      const hex = Array.from(data, value => value.toString(16).padStart(2, '0')).join(' ');
      if (text === 'STOP\n') {
        stopWrites++; bytesToDevice.push({ at: Date.now(), text, hex }); record('synthetic-stop-write'); return;
      }
      const [prefix, requestId, kp, ki, kd] = text.trim().split(',');
      if (prefix !== 'PID' || !requestId || ![kp, ki, kd].every(value => Number.isFinite(Number(value)))) {
        throw new Error('Fixture rejects unexpected wire command');
      }
      const params = { kp: Number(kp), ki: Number(ki), kd: Number(kd) };
      writes++; bytesToDevice.push({ at: Date.now(), text, hex, params });
      record('synthetic-pid-write-start', { requestId, params, count: writes, held: writeHeld });
      if (writeHeld) await new Promise<void>((resolve, reject) => pendingWrites.push({ requestId, resolve, reject }));
      record('synthetic-pid-stream-write-complete', { requestId, params });
      // Parameter numbers change only after the real transport's written receipt,
      // in driver.write below. No old frame or synthetic ACK confirms this write.
    } });
    timer = setInterval(emitLiteralFrame, 20);
  },
  async close() {
    opened = false; portCounts.closed++; if (timer) clearInterval(timer); timer = null; controller = null;
    for (const pending of pendingWrites.splice(0)) pending.reject(new Error('Synthetic port closed before write completion'));
    record('synthetic-port-close');
  },
  async setSignals() {},
  async getSignals() { return { dataCarrierDetect: true, clearToSend: true, ringIndicator: false, dataSetReady: true }; },
};
Object.defineProperty(navigator, 'serial', { configurable: true, value: {
  getPorts: async () => { portCounts.enumerations++; return [port]; },
  requestPort: async () => { portCounts.requested++; return port; },
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
  try {
    const receipt = await realWrite(bytes);
    record('real-transport-written-receipt', receipt);
    const text = new TextDecoder().decode(bytes);
    const [prefix, requestId, kp, ki, kd] = text.trim().split(',');
    if (prefix === 'PID' && receipt.status === 'written') {
      if (caseId === 'confirmation-timeout') record('synthetic-readback-kept-old', { requestId, params: currentParams });
      else setTimeout(() => {
        if (!opened) return;
        currentParams = { kp: Number(kp), ki: Number(ki), kd: Number(kd) }; error = .02;
        if (caseId === 'output-limit') output = 11;
        record('synthetic-parameters-applied-after-written-receipt', { requestId, params: { ...currentParams }, output });
      }, 40);
    }
    return receipt;
  } catch (reason) { record('real-transport-write-rejected', String(reason)); throw reason; }
};
driver.onStatusChange(value => record('real-transport-status', value));
driver.onWriteResult(value => record('real-transport-write-result', value));
driver.onError(value => record('real-transport-error', value));
driver.onBatch(batch => { for (const log of batch.logLines) record('real-parser-rx-log', log); });
let parsedBatchCount = 0;
let lastParsedBatch: { at: number; sessionId: string; epoch: number; channels: string[]; samples: number } | null = null;
driver.onWaveformBatch(batch => {
  parsedBatchCount++;
  lastParsedBatch = { at: Date.now(), sessionId: batch.session_id, epoch: batch.channel_epoch, channels: batch.channel_names, samples: batch.timestamps.length };
  if (parsedBatchCount === 1) record('real-waveform-first-batch', lastParsedBatch);
});

const plan: TuningPlan = {
  id: planId, version: 1, name: '实际 App 后台遥测与渲染分离验收', project: '后台遥测合成测试对象',
  description: '独立软件集成验收；字节流不是物理模型，没有原生后台或硬件证明。', prompt: '只允许 PI 参数在 20% 边界以内的小幅候选。',
  route: 'feedback', mode: 'manual', loopId: 'fixture-stage', structure: 'PI', controlDirection: 'direct', sampleTimeSeconds: .02,
  commandTemplate: 'PID,{request_id},{kp},{ki},{kd}', commandFormat: { escapeText: false, lineEnding: 'lf' },
  baseline: { params: { kp: 2, ki: .5, kd: 0 }, source: 'manual', confirmed: false, stableBaseConfirmed: false },
  bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: { min: 0, max: 0 } },
  maxParameterChangePercent: 20, maximumTrials: 3, evaluationWindowSeconds: .7,
  maximumTelemetryAgeSeconds: .5, maximumOutputMagnitude: 10,
  channels: { setpoint: 'setpoint', feedback: 'actual', output: 'output', parameters: { kp: 'ch3', ki: 'ch4' } },
  units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)', kd: '%·s/rpm' } },
  confirmation: { mode: 'parameter-channels', acknowledgementText: '', timeoutSeconds: 1, parameterTolerance: .01 },
  goal: { mode: 'settle', maximumSteadyError: .1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null },
  model: null, suite: createScenarioContext('custom', 'single', 'fixture-stage', [{ id: 'fixture-stage', title: '合成 PI 控制环', structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] }]),
};
const session: TuningSession = {
  id: planId, scenarioGroupId: planId, plan, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null,
  startedAt: null, updatedAt: Date.now(), stopReason: null,
  formDraft: { modelSource: 'transfer', numerator: '', denominator: '', delay: '', parameters: { kp: '2', ki: '0.5', kd: '0' } },
};
localStorage.removeItem('llm-serial-tuning-sessions-v1');
if (!saveTuningSession(session)) throw new Error('Synthetic plan failed real configuration validation');
globalProjectModel.addLoop({ id: 'fixture-stage', name: '合成 PI 控制环', order: 0, structure: 'PI', plant_family: 'first_order', channels: { setpoint: 'setpoint', feedback: 'actual', output: 'output' }, param_limits: { kp: [0, 10], ki: [0, 2], kd: [0, 0] }, cmd_template: plan.commandTemplate, state: 'untuned' });
localStorage.setItem('llm-serial.vofa-dashboard.v2', JSON.stringify(createDefaultVofaPreset()));
await saveBrowserWorkspace(JSON.stringify({
  port_name: syntheticPort.id, mode: 'serial', baud_rate: 115200, protocol_config: { type: 'firewater' },
  quick_commands: [], emergency_command: 'STOP\\n',
  ai_config: { provider: 'custom', api_url: `${location.origin}/fixture-ai/v1`, model, api_key: '', api_key_configured: false },
}));
document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark');
const style = document.createElement('style');
style.textContent = 'html,body{height:100%;overflow:hidden}#app{height:calc(100% - 144px)}#app>.workbench-vofa-app{height:100%;width:100%}#fixture-bar{height:144px;box-sizing:border-box;display:flex;flex-wrap:wrap;align-content:center;align-items:center;gap:6px;padding:6px;color:var(--text-main);background:var(--bg-base);font:12px sans-serif;border-top:1px solid var(--border-strong)}#fixture-bar button,#fixture-bar select{color:var(--text-main);background:var(--bg-surface);border:1px solid var(--border-strong);padding:4px}#fixture-bar details[open]{position:absolute;bottom:0;right:0;z-index:300;background:var(--bg-base);width:760px;max-width:95vw}#fixture-proof{display:block;max-height:450px;overflow:auto;white-space:pre-wrap;font:11px monospace}#fixture-control-status{max-width:700px}';
document.head.append(style);
createApp(App).mount('#app');
record('real-App-mounted', { caseId, model, portId: syntheticPort.id });
// This actual subscriber also provides a scheduler probe even before the tuning
// panel is opened. Its callbacks use the same delivery wrapper as the product.
globalChannelStore.subscribe(channels, () => {}, { fps: 10, immediate: true });
(document.getElementById('fixture-case') as HTMLSelectElement).value = caseId;
document.getElementById('prepare-case')!.addEventListener('click', () => {
  localStorage.setItem('fixture.background-delivery.case', (document.getElementById('fixture-case') as HTMLSelectElement).value); location.reload();
});
document.getElementById('hold-frames')!.addEventListener('click', holdFrames);
document.getElementById('resume-frames')!.addEventListener('click', resumeFrames);
document.getElementById('hold-subscribers')!.addEventListener('click', holdSubscribers);
document.getElementById('resume-subscribers')!.addEventListener('click', resumeSubscribers);
document.getElementById('pause-rx')!.addEventListener('click', () => { rxPaused = true; record('synthetic-rx-paused', { rxFrameCount }); status('合成 RX 已暂停；没有补发或回填。'); });
document.getElementById('resume-rx')!.addEventListener('click', () => { rxPaused = false; record('synthetic-rx-resumed', { rxFrameCount }); status('合成 RX 已恢复；下个真实 interval 生成新帧。'); });
document.getElementById('force-output')!.addEventListener('click', () => { output = 11; record('synthetic-next-literal-output', { value: output }); status('下个新生成的数值帧将包含 output=11。'); });
document.getElementById('restore-output')!.addEventListener('click', () => { output = 1; record('synthetic-next-literal-output', { value: output }); status('下个新生成的数值帧将包含 output=1。'); });
document.getElementById('hold-write')!.addEventListener('change', event => { writeHeld = (event.target as HTMLInputElement).checked; record('synthetic-stream-write-hold', writeHeld); });
document.getElementById('complete-write')!.addEventListener('click', () => {
  const pending = pendingWrites.splice(0); record('synthetic-complete-held-writes', pending.map(value => value.requestId));
  for (const value of pending) value.resolve(); status(`已放行 ${pending.length} 个流写入完成承诺；参数回传仍等待 written receipt。`);
});
async function controlHttp(action: string) {
  const response = await fetch('/fixture-ai/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, action }) });
  const state = await response.json(); record('synthetic-http-control', { action, status: response.status, state });
  if (!response.ok) throw new Error(`Local fixture control HTTP ${response.status}`);
  status(`${action}: ${JSON.stringify(state)}`);
}
document.getElementById('hold-http')!.addEventListener('click', () => { void controlHttp('hold-next'); });
document.getElementById('release-http')!.addEventListener('click', () => { void controlHttp('release-all'); });
document.getElementById('clear-ki')!.addEventListener('click', () => {
  const before = { generation: globalChannelStore.getGeneration(), channels: captureRawObservations() };
  globalChannelStore.clear('ch4');
  const after = { generation: globalChannelStore.getGeneration(), channels: captureRawObservations() };
  record('actual-partial-channel-clear', { channel: 'ch4', before, after });
  status('已调用实际 ChannelStore.clear(ch4)；before/after 已记录，可核对其它通道入库身份。');
});
document.getElementById('capture-proof')!.addEventListener('click', async () => {
  const button = document.getElementById('capture-proof') as HTMLButtonElement;
  const proof = document.getElementById('fixture-proof')!;
  if (button.disabled) return;
  button.disabled = true; proof.textContent = ''; status('正在记录新的实际 App 软件证据…');
  try {
    await nextTick();
    const response = await fetch(`/fixture-ai/history?model=${encodeURIComponent(model)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Fixture history returned HTTP ${response.status}`);
    const history = await response.json();
    const stored: TuningSession[] = JSON.parse(localStorage.getItem('llm-serial-tuning-sessions-v1') ?? '[]');
    const capturedAtMs = Date.now();
    const capturedAt = new Date(capturedAtMs).toISOString();
    record('fixture-proof-captured', { capturedAt });
    proof.textContent = JSON.stringify({
      capturedAt, capturedAtMs, testType: 'real-App-real-WebSerialTransport-real-module-parser-synthetic-RX-local-HTTP',
      origin: location.origin, caseId, model, nativeInteractive: 'not-run', hardware: 'not-run', liveAi: 'not-run', jevCalls: 0,
      scriptedResponse: true, actualHiddenTabAcceptance: 'not-established-by-fixture-hold',
      visibilityState: document.visibilityState, hidden: document.hidden, visibilityEvents,
      observeLatestSupported: typeof observationStore.observeLatest === 'function',
      context: globalChannelStore.getSessionContext(), generation: globalChannelStore.getGeneration(),
      rawObservations: captureRawObservations(capturedAtMs), bufferSummary: globalChannelStore.getBufferSummary(),
      frames: { held: framesHeld, stats: { ...frameStats }, queued: frameQueue.size, queue: [...frameQueue].map(([id, entry]) => ({ id, requestedAt: entry.requestedAt, nativePending: entry.nativeHandle !== null })) },
      subscribers: { held: subscribersHeld, records: subscriberRecords },
      syntheticRx: { paused: rxPaused, rxFrameCount, rxByteCount, lastLiteralFrame, currentParams, output },
      ports: { ...portCounts, opened, portId: syntheticPort.id },
      writes, stopWrites, bytesToDevice, writeHeld, pendingWriteIds: pendingWrites.map(value => value.requestId),
      parsedBatchCount, lastParsedBatch, history, session: stored.find(value => value.id === planId), runtimeErrors, events,
      visibleButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('#app button')).map(value => ({ text: value.textContent?.trim(), disabled: value.disabled, visible: value.getClientRects().length > 0 })),
      visibleAppText: document.getElementById('app')!.textContent,
    }, null, 2);
    status(`新证据已记录：${capturedAt}`);
  } catch (reason) { record('fixture-proof-capture-failed', String(reason)); status(`证据记录失败：${String(reason)}`); }
  finally { button.disabled = false; }
});
