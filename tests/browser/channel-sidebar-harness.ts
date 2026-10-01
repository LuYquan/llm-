import { createApp, nextTick } from 'vue';
import App from '../../src/App.vue';
import '../../src/style.css';
import { TransportFactory } from '../../src/services/transport/factory';
import type { ISerialTransport, ParsedBatch, TransportStatus, Unsubscribe } from '../../src/services/transport/types';
import type { WaveformBatch } from '../../src/types/ipc';
import { saveBrowserWorkspace } from '../../src/services/workspace/browser-storage';
import { createDefaultVofaPreset } from '../../src/core/widget/schema';
import { globalChannelStore } from '../../src/core/channel/ChannelStore';
import { useWidgetStore } from '../../src/stores/widgetStore';

if (location.origin !== 'http://127.0.0.1:5194') throw new Error('Sidebar fixture requires isolated localhost:5194');
const DASHBOARD_KEY = 'llm-serial.vofa-dashboard.v2';
const SEED_KEY = 'fixture.channel-sidebar.seed.v1';
const statusListeners = new Set<(status: TransportStatus) => void>();
const waveListeners = new Set<(batch: WaveformBatch) => void>();
const batchListeners = new Set<(batch: ParsedBatch) => void>();
const subscribe = <T>(listeners: Set<(event: T) => void>, callback: (event: T) => void): Unsubscribe => {
  listeners.add(callback); return () => listeners.delete(callback);
};
let connected = false;
let acquiring = false;
let epoch = 1;
let sessionId = 'synthetic-sidebar-1';
let writeAttempts = 0;
let nextTime = 1;
const events: { event: string; at: string; detail?: unknown }[] = [];
const record = (event: string, detail?: unknown) => events.push({ event, at: new Date().toISOString(), detail });
const driver: ISerialTransport = {
  kind: 'webserial', supportsSignals: false,
  capabilities: { canEnumerateAllPorts: true, requiresUserGestureToAddPort: false, globalEmergencyStop: false, fileSystemLogging: false },
  listPorts: async () => [{ id: 'fixture-sidebar', port_name: 'fixture-sidebar', label: '侧栏合成传输夹具' }],
  connect: async () => { connected = true; acquiring = true; record('driver-connected'); statusListeners.forEach(callback => callback('connected')); },
  disconnect: async () => { connected = false; acquiring = false; record('driver-disconnected'); statusListeners.forEach(callback => callback('idle')); },
  configureProtocol: async config => { record('driver-protocol', config); },
  setAcquisitionEnabled: async enabled => { acquiring = enabled; record('driver-acquisition', enabled); },
  write: async () => { writeAttempts++; throw new Error('Synthetic sidebar fixture forbids device writes'); },
  emergencyStop: async () => { writeAttempts++; throw new Error('Synthetic fixture has no hardware stop'); },
  resumeWrites: async () => {}, dispose: async () => {},
  onBatch: callback => subscribe(batchListeners, callback), onError: () => () => {}, onWriteResult: () => () => {},
  onStatusChange: callback => subscribe(statusListeners, callback), onWaveformBatch: callback => subscribe(waveListeners, callback),
};
TransportFactory.create = async () => driver;

// Seed only this isolated origin, once. Reload then exercises actual dashboard
// persistence/alias restoration instead of manually rebuilding aliases here.
if (localStorage.getItem(SEED_KEY) !== 'seeded') {
  const dashboard = createDefaultVofaPreset();
  const chart = dashboard.tabs[0].widgets[0];
  chart.w = 740; chart.h = 420;
  chart.title = '别名与真实通道 · 等待合成样本';
  chart.config = { series: [
    { channel: '姿态角', color: '#7AA89B', visible: true },
    { channel: 'speed', color: '#759CB5', visible: true },
    { channel: 'pending', color: '#E59E38', visible: true },
  ], auto_bind: false, time_window: 10, y_mode: 'auto', y_min: -10, y_max: 10, show_cursor: true, show_stats: true };
  dashboard.channels = {
    actual: { id: 'actual', name: '姿态角', color: '#7AA89B', visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 3, unit: 'rad', unitSource: 'user' },
    speed: { id: 'speed', name: '轮速', color: '#759CB5', visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 3 },
    pending: { id: 'pending', name: '待接收通道', color: '#E59E38', visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 3 },
  };
  localStorage.setItem(DASHBOARD_KEY, JSON.stringify(dashboard));
  await saveBrowserWorkspace(JSON.stringify({
    port_name: 'fixture-sidebar', mode: 'serial', baud_rate: 115200,
    protocol_config: { type: 'firewater' }, quick_commands: [], emergency_command: null,
    ai_config: { provider: 'ollama', api_url: 'http://127.0.0.1:5194/no-ai/v1', model: 'fixture-no-ai', api_key: '', api_key_configured: false },
  }));
  localStorage.setItem(SEED_KEY, 'seeded');
}
document.documentElement.dataset.theme = 'dark';
document.documentElement.classList.add('dark');
const style = document.createElement('style');
style.textContent = '#fixture-bar{position:fixed;bottom:0;left:0;right:0;z-index:200;background:var(--bg-base);color:var(--text-main);padding:6px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;border-top:1px solid var(--border-strong)}#fixture-bar button{font:inherit;min-height:32px;padding:3px 7px;color:var(--text-main);background:var(--bg-surface);border:1px solid var(--border-strong);border-radius:4px}#fixture-bar details{max-width:100%}#fixture-proof{display:block;max-height:280px;max-width:94vw;overflow:auto;white-space:pre-wrap;font:11px/1.6 Consolas,monospace}#fixture-status{font-size:12px}';
document.head.append(style);
createApp(App).mount('#app');
record('real-App-mounted', { aliasSeed: 'dashboard.channels.actual.name=姿态角', manualSetAlias: false });

function finiteJSON(value: number | undefined) {
  return value === undefined ? { kind: 'missing' } : Number.isFinite(value) ? { kind: 'finite', value }
    : { kind: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
}
const bufferIds = new WeakMap<object, number>();
let nextBufferId = 1;
function inspectChannel(requestedId: string) {
  const buffer = globalChannelStore.getBuffer(requestedId, false);
  if (buffer && !bufferIds.has(buffer)) bufferIds.set(buffer, nextBufferId++);
  const latest = buffer?.latest();
  return { requestedId, resolvedId: globalChannelStore.resolveChannelKey(requestedId),
    bufferId: buffer ? bufferIds.get(buffer) : null, count: buffer?.getSize() ?? 0,
    latest: { time: finiteJSON(latest?.t), value: finiteJSON(latest?.v) } };
}
async function captureProof() {
  await nextTick();
  const sidebar = document.querySelector('.right-data-sidebar');
  const proof = {
    testType: 'real-App-Vue-with-synthetic-transport', origin: location.origin,
    nativeInteractive: 'not-run', hardware: 'not-run', externalAiRequests: 0, writeAttempts,
    driver: { connected, acquiring, sessionId, epoch }, session: globalChannelStore.getSessionContext(),
    generation: globalChannelStore.getGeneration(), cache: globalChannelStore.getBufferSummary(),
    canonicalBuffers: globalChannelStore.listChannels().map(inspectChannel),
    bindings: ['actual', '姿态角', '!姿态角', 'speed', 'pending'].map(inspectChannel),
    metadata: useWidgetStore().dashboardState.value.channels,
    declaredAliases: Object.entries(useWidgetStore().dashboardState.value.channels ?? {}).map(([key, meta]) => ({ ...inspectChannel(meta.name), targetId: key })),
    aliasConflicts: useWidgetStore().channelAliasConflicts.value,
    chartSeries: useWidgetStore().dashboardState.value.tabs.flatMap(tab => tab.widgets.filter(widget => widget.type === 'chart').map(widget => widget.config.series)),
    sidebarText: sidebar?.textContent,
    sidebarRows: Array.from(sidebar?.querySelectorAll('.channel-item') ?? []).map(node => ({ text: node.textContent, title: node.getAttribute('title') })),
    status: Array.from(document.querySelectorAll('#app [role=status]')).map(node => node.textContent), events,
  };
  document.getElementById('fixture-proof')!.textContent = JSON.stringify(proof, null, 2);
}
function emitBatch(kind: 'finite' | 'zero' | 'nonfinite') {
  if (!connected || !acquiring) throw new Error('先点击实际 App 顶部“演示”，并保持采集开启。');
  const timestamps = [nextTime, nextTime + 0.01]; nextTime += 0.02;
  const values = kind === 'zero' ? [[0, 0], [0, 0]] : kind === 'nonfinite' ? [[NaN, NaN], [Infinity, Infinity]] : [[1, 2], [3, 4]];
  record('synthetic-batch', { kind, sessionId, epoch, timestamps, latest: values.map(series => finiteJSON(series[1])) });
  batchListeners.forEach(callback => callback({ samples: timestamps.flatMap((t, index) => ['actual', 'speed'].map((channel, ch) => ({ channel, t, v: values[ch][index] }))), logLines: [] }));
  const batch: WaveformBatch = { session_id: sessionId, channel_epoch: epoch, channel_names: ['actual', 'speed'], points: [], timestamps, series: values };
  waveListeners.forEach(callback => callback(batch));
}
function emitUnconfiguredBatch() {
  if (!connected || !acquiring) throw new Error('先点击实际 App 顶部“演示”，并保持采集开启。');
  const channel = 'raw-unconfigured';
  const timestamps = [nextTime, nextTime + 0.01]; nextTime += 0.02;
  const values = [8, 9];
  record('synthetic-unconfigured-batch', { channel, sessionId, epoch, timestamps, values });
  batchListeners.forEach(callback => callback({ samples: timestamps.map((t, index) => ({ channel, t, v: values[index] })), logLines: [] }));
  const batch: WaveformBatch = { session_id: sessionId, channel_epoch: epoch, channel_names: [channel], points: [], timestamps, series: [values] };
  waveListeners.forEach(callback => callback(batch));
}
const bind = (id: string, callback: () => void | Promise<void>) => document.getElementById(id)!.addEventListener('click', async () => {
  try { await callback(); document.getElementById('fixture-status')!.textContent = `夹具操作完成：${document.getElementById(id)!.textContent}`; }
  catch (error) { document.getElementById('fixture-status')!.textContent = error instanceof Error ? error.message : String(error); }
});
bind('first-batch', () => emitBatch('finite'));
bind('zero-batch', () => emitBatch('zero'));
bind('nonfinite-batch', () => emitBatch('nonfinite'));
bind('unconfigured-batch', emitUnconfiguredBatch);
bind('clear-one', () => { record('fixture-clear-one', 'actual'); globalChannelStore.clear('actual'); });
bind('clear-all', () => { record('fixture-clear-all'); globalChannelStore.clear(); });
bind('new-session', () => { epoch++; sessionId = `synthetic-sidebar-${epoch}`; nextTime = 1; emitBatch('finite'); });
bind('driver-disconnect', async () => { await driver.disconnect(); });
bind('capture-proof', captureProof);
bind('reset-fixture', () => { localStorage.removeItem(SEED_KEY); localStorage.removeItem(DASHBOARD_KEY); location.reload(); });
void captureProof();
