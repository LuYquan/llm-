import { createApp, h, reactive, nextTick, type App } from 'vue';
import RecordingReplayAnalysis from '../../src/components/RecordingReplayAnalysis.vue';
import { analysisWorker, type CancellableAnalysis, type FftAnalysisResult } from '../../src/services/analysis/analysis-worker-client';
import type { RecordingReplaySample } from '../../src/services/recording/replay-decoder';

if (location.hostname !== '127.0.0.1' || location.port !== '5192') throw new Error('Replay FFT fixture requires its independent localhost:5192 origin.');
const host = document.querySelector<HTMLElement>('#component-host')!;
const status = document.querySelector<HTMLElement>('#status')!;
const output = document.querySelector<HTMLElement>('#results')!;
const eventOutput = document.querySelector<HTMLElement>('#events')!;
type EventRecord = { at: number; event: string; detail?: unknown };
type CaseResult = { id: string; passed: boolean; reason: string; delivery: 'real-worker' | 'real-worker-delayed-delivery'; snapshot: ReturnType<typeof snapshot> };
const events: EventRecord[] = [];
const realRunFft = analysisWorker.runFft.bind(analysisWorker);
const NativeWorker = window.Worker;
let app: App | null = null;
let props: ReturnType<typeof inputProps>;
let run = 0;
let busy = false;
let delayDelivery = false;

function record(event: string, detail?: unknown) {
  events.push({ at: Date.now(), event, detail });
  eventOutput.textContent = JSON.stringify(events, null, 2);
}
// Observe the actual browser Worker constructor and termination, preserving its
// native implementation. This confirms normal FFT uses the module Worker path.
window.Worker = class ObservedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    record('native-module-worker-created', { url: String(url), type: options?.type });
  }
  terminate(): void { record('native-worker-terminated'); super.terminate(); }
};
analysisWorker.runFft = (...args): CancellableAnalysis<FftAnalysisResult> => {
  const job = realRunFft(...args);
  const delayed = delayDelivery;
  record('fft-request', { id: job.id, channels: args[3]?.channelIds, sessionId: args[3]?.sessionId, epoch: args[3]?.epoch, delayed });
  const promise = job.promise.then(response => {
    record('real-fft-completed', { id: job.id, peakFreq: response.result?.peakFreq, delayed });
    if (!delayed) return response;
    // The counterexample lets a completed result arrive after cancel(). The
    // actual worker/client calculation and provenance remain unmodified.
    return new Promise<FftAnalysisResult>(resolve => setTimeout(() => {
      record('delayed-result-delivered', { id: job.id }); resolve(response);
    }, 450));
  });
  return { id: job.id, promise, cancel: () => { record('component-cancel', { id: job.id }); job.cancel(); } };
};

function samples(offset = 0, count = 1024): RecordingReplaySample[] {
  return Array.from({ length: count }, (_, index) => {
    const timeSeconds = offset + index / 128;
    return [
      { channel: 'A', timeSeconds, value: Math.sin(2 * Math.PI * 5 * timeSeconds) },
      { channel: 'B', timeSeconds, value: Math.sin(2 * Math.PI * 11 * timeSeconds) },
    ];
  }).flat();
}
function inputProps() { return reactive({ samples: samples(), sessionId: `synthetic-replay-${run}`, epoch: 3, timeSource: 'synthetic-device-clock' }); }
async function mount() {
  app?.unmount(); app = null; run += 1; delayDelivery = false;
  props = inputProps();
  app = createApp({ render: () => h(RecordingReplayAnalysis, { ...props }) });
  app.mount(host); await nextTick();
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) { if (predicate()) return; await sleep(15); }
  throw new Error(`Timed out: ${host.textContent}`);
}
function select(channel: string) {
  const element = host.querySelector<HTMLSelectElement>('select')!;
  if (element.disabled) throw new Error('Channel selector must remain usable to cancel an in-flight analysis.');
  element.value = channel; element.dispatchEvent(new Event('change', { bubbles: true }));
}
function clickFft() {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === '计算 FFT');
  if (!button || button.disabled) throw new Error('FFT button must be enabled.');
  button.click();
}
function resultField(label: string): string | null {
  const term = [...host.querySelectorAll('dt')].find(item => item.textContent === label);
  return term?.parentElement?.querySelector('dd')?.textContent?.trim() ?? null;
}
function snapshot() {
  return { selected: host.querySelector<HTMLSelectElement>('select')?.value, frequency: resultField('主频'), channel: resultField('通道'),
    timeSource: resultField('时间来源'), interval: resultField('区间'), session: resultField('会话'), epoch: resultField('会话轮次'), message: host.querySelector('[role="status"]')?.textContent?.trim(),
    hasResult: Boolean(host.querySelector('.recording-replay-analysis-result')) };
}
async function compute(expectedHz: number) {
  const start = events.length; clickFft();
  await until(() => resultField('主频') !== null);
  const frequency = Number.parseFloat(resultField('主频')!);
  if (Math.abs(frequency - expectedHz) > .13) throw new Error(`Expected ${expectedHz} Hz, observed ${frequency}.`);
  if (!events.slice(start).some(item => item.event === 'native-module-worker-created')) throw new Error('No real module Worker was constructed for FFT.');
}
async function reproduce() {
  await mount(); await compute(5);
  const before = snapshot(); select('B'); await nextTick(); const after = snapshot();
  output.textContent = JSON.stringify({ status: after.hasResult ? 'defect-reproduced' : 'fixed', evidence: 'real-vue/real-module-worker/synthetic-samples',
    scenario: 'A=5Hz FFT completed, then selector changed to B=11Hz without recomputation', before, after,
    nativeAcceptance: 'not-run', hardwareAcceptance: 'not-run', externalAiRequests: 0 }, null, 2);
  status.textContent = after.hasResult ? '复现：选择 B 后仍显示 A 的 5 Hz 结果。' : '选择变化已撤销旧结果。';
}
async function runAll() {
  const results: CaseResult[] = [];
  const test = async (id: string, action: () => Promise<void>, delayed = false) => {
    let passed = true; let reason = '';
    try { await mount(); delayDelivery = delayed; await action(); }
    catch (error) { passed = false; reason = error instanceof Error ? error.message : String(error); }
    results.push({ id, passed, reason: reason || '真实组件结果与冻结输入归属一致，旧结果未跨上下文提交。', delivery: delayed ? 'real-worker-delayed-delivery' : 'real-worker', snapshot: snapshot() });
    output.textContent = JSON.stringify({ status: 'running', results }, null, 2);
  };
  const assertCleared = () => { if (snapshot().hasResult) throw new Error('A previous context still owns a visible FFT result.'); };
  await test('channel-result-invalidation-and-real-B', async () => {
    await compute(5); select('B'); await nextTick(); assertCleared(); await compute(11);
    if (resultField('通道') !== 'B' || resultField('时间来源') !== 'synthetic-device-clock'
      || resultField('会话') !== props.sessionId || resultField('会话轮次') !== String(props.epoch)) throw new Error('Result lacks frozen channel/session/epoch/time-source provenance.');
  });
  const changes: Array<[string, () => void]> = [
    ['session', () => { props.sessionId += '-next'; }], ['epoch', () => { props.epoch += 1; }],
    ['time-source', () => { props.timeSource = 'synthetic-host-clock'; }],
    ['read-interval', () => { props.samples = samples(8); }],
    ['read-count', () => { props.samples = samples(0, 512); }],
    ['in-place-sample', () => { props.samples[0].value += .2; }],
    ['in-place-time', () => { props.samples[0].timeSeconds += .001; }],
    ['channel-removed', () => { props.samples = props.samples.filter(sample => sample.channel !== 'A'); }],
  ];
  for (const [label, change] of changes) await test(`completed-${label}-invalidation`, async () => {
    await compute(5); change(); await nextTick(); assertCleared();
  });
  for (const [label, change] of [['channel', () => { select('B'); }], ...changes] as Array<[string, () => void]>) await test(`late-${label}-rejection`, async () => {
    const start = events.length; clickFft();
    await until(() => events.slice(start).some(item => item.event === 'real-fft-completed'));
    change(); await nextTick();
    if (!events.slice(start).some(item => item.event === 'component-cancel')) throw new Error('Changed context did not cancel its analysis job.');
    await until(() => events.slice(start).some(item => item.event === 'delayed-result-delivered'));
    await nextTick(); assertCleared();
  }, true);
  await test('older-delivery-cannot-replace-new-B-result', async () => {
    const start = events.length; clickFft();
    await until(() => events.slice(start).some(item => item.event === 'real-fft-completed'));
    select('B'); await nextTick(); delayDelivery = false; await compute(11);
    await until(() => events.slice(start).some(item => item.event === 'delayed-result-delivered'));
    await nextTick();
    if (resultField('通道') !== 'B' || Math.abs(Number.parseFloat(resultField('主频')!) - 11) > .13) throw new Error('Late A result replaced the new B result.');
  }, true);
  await test('clear-completed-result', async () => {
    await compute(5);
    const clear = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '清除');
    if (!clear || clear.disabled) throw new Error('Completed result cannot be cleared.');
    clear.click(); await nextTick(); assertCleared();
  });
  await test('cancel-prevents-late-delivery', async () => {
    const start = events.length; clickFft();
    await until(() => events.slice(start).some(item => item.event === 'real-fft-completed'));
    const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '取消计算');
    if (!cancel || cancel.disabled) throw new Error('Pending FFT has no usable cancel control.');
    cancel.click(); await nextTick();
    if (!events.slice(start).some(item => item.event === 'component-cancel')) throw new Error('Cancel control did not revoke the job.');
    await until(() => events.slice(start).some(item => item.event === 'delayed-result-delivered'));
    await nextTick(); assertCleared();
  }, true);
  await test('unmount-prevents-late-delivery-into-next-view', async () => {
    const start = events.length; clickFft();
    await until(() => events.slice(start).some(item => item.event === 'real-fft-completed'));
    await mount();
    if (!events.slice(start).some(item => item.event === 'component-cancel')) throw new Error('Unmount did not revoke the old job.');
    await until(() => events.slice(start).some(item => item.event === 'delayed-result-delivered'));
    await nextTick(); assertCleared();
  }, true);
  const failed = results.filter(item => !item.passed).length;
  output.textContent = JSON.stringify({ status: failed ? 'failed' : 'passed', evidence: 'real-vue/real-module-worker/synthetic-samples', origin: location.origin,
    results, workerCount: events.filter(item => item.event === 'native-module-worker-created').length,
    delayedDeliverySubstitute: 'only promise delivery is delayed; actual FFT and provenance use the real worker/client',
    nativeAcceptance: 'not-run', hardwareAcceptance: 'not-run', externalAiRequests: 0 }, null, 2);
  status.textContent = `${results.length - failed}/${results.length} 项通过；原生 / 硬件未验收。`;
  status.className = failed ? 'failed' : 'passed';
}
async function action(callback: () => Promise<void>) {
  if (busy) return; busy = true;
  document.querySelectorAll<HTMLButtonElement>('body > button').forEach(button => { button.disabled = true; });
  try { await callback(); } catch (error) { status.textContent = String(error); status.className = 'failed'; }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('body > button').forEach(button => { button.disabled = false; }); }
}
document.querySelector<HTMLButtonElement>('#reproduce')!.onclick = () => { void action(reproduce); };
document.querySelector<HTMLButtonElement>('#run-all')!.onclick = () => { void action(runAll); };
void mount().then(() => { status.textContent = '已挂载真实回放分析组件；只使用合成输入。'; });
