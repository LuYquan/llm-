import { createApp } from 'vue';
import App from '../../src/App.vue';
import '../../src/style.css';
import { TransportFactory } from '../../src/services/transport/factory';
import type { ISerialTransport, ParsedBatch, TransportStatus, Unsubscribe } from '../../src/services/transport/types';
import type { WaveformBatch } from '../../src/types/ipc';
import { saveBrowserWorkspace } from '../../src/services/workspace/browser-storage';
import { createDefaultVofaPreset } from '../../src/core/widget/schema';
import { globalChannelStore } from '../../src/core/channel/ChannelStore';
import { assistantEvidenceSelection } from '../../src/core/assistant/evidenceSelectionStore';
import { useWidgetStore } from '../../src/stores/widgetStore';

if (location.origin !== 'http://127.0.0.1:5193') throw new Error('Fixture requires its isolated localhost origin');
const statusListeners = new Set<(status: TransportStatus) => void>();
const waveListeners = new Set<(batch: WaveformBatch) => void>();
const batchListeners = new Set<(batch: ParsedBatch) => void>();
const subscribe = <T>(listeners: Set<(event: T) => void>, cb: (event: T) => void): Unsubscribe => { listeners.add(cb); return () => listeners.delete(cb); };
let connected = false;
let epoch = 1;
let sessionId = 'fixture-evidence-1';
let writeAttempts = 0;
const driver: ISerialTransport = {
  kind: 'webserial', supportsSignals: false,
  capabilities: { canEnumerateAllPorts: true, requiresUserGestureToAddPort: false, globalEmergencyStop: false, fileSystemLogging: false },
  listPorts: async () => [{ id: 'fixture', port_name: 'fixture', label: '合成传输夹具' }],
  connect: async () => { connected = true; statusListeners.forEach(cb => cb('connected')); },
  disconnect: async () => { connected = false; statusListeners.forEach(cb => cb('idle')); },
  configureProtocol: async () => {}, setAcquisitionEnabled: async () => {},
  write: async () => { writeAttempts++; throw new Error('Fixture forbids all device writes'); },
  emergencyStop: async () => { writeAttempts++; throw new Error('Fixture has no device stop'); },
  resumeWrites: async () => {}, dispose: async () => {},
  onBatch: cb => subscribe(batchListeners, cb), onError: () => () => {}, onWriteResult: () => () => {},
  onStatusChange: cb => subscribe(statusListeners, cb), onWaveformBatch: cb => subscribe(waveListeners, cb),
};
TransportFactory.create = async () => driver;
const dashboard = createDefaultVofaPreset();
const chart = dashboard.tabs[0].widgets[0];
chart.w = 800; chart.h = 470;
chart.config = { series: [{ channel: 'fixture-alias', color: '#7AA89B', visible: true }], auto_bind: false, time_window: 10, y_mode: 'auto', y_min: -10, y_max: 10, show_cursor: true, show_stats: true };
dashboard.channels = {
  actual: { id: 'actual', name: '姿态角', color: '#7AA89B', visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 3, unit: 'rad', unitSource: 'user' },
  'fixture-alias': { id: 'fixture-alias', name: '显示变换', color: '#7AA89B', visible: true, scale: 10, yOffset: 100, xOffset: 0, decimal: 3 },
};
localStorage.setItem('llm-serial.vofa-dashboard.v2', JSON.stringify(dashboard));
await saveBrowserWorkspace(JSON.stringify({
  port_name: 'fixture', mode: 'serial', baud_rate: 115200,
  protocol_config: { type: 'firewater' }, quick_commands: [], emergency_command: null,
  ai_config: { provider: 'ollama', api_url: 'http://127.0.0.1:5193/fixture-ai/v1', model: 'fixture-evidence-local', api_key: '', api_key_configured: false },
}));
document.documentElement.dataset.theme = 'dark';
document.documentElement.classList.add('dark');
const style = document.createElement('style');
style.textContent = '#fixture-bar{position:fixed;bottom:0;left:0;right:0;z-index:200;background:var(--bg-base);color:var(--text-main);padding:6px;display:flex;flex-wrap:wrap;gap:6px;font-size:12px;border-top:1px solid var(--border-strong)}#fixture-bar button{font:inherit;min-height:32px}#fixture-bar details{max-width:100%}#fixture-proof{max-height:250px;max-width:90vw;overflow:auto;white-space:pre-wrap}';
document.head.append(style);
createApp(App).mount('#app');
globalChannelStore.setAlias('fixture-alias', 'actual');
function emitBatch() {
  if (!connected) throw new Error('Start the real App demo first');
  const timestamps = Array.from({ length: 1001 }, (_, index) => index / 100);
  const values = timestamps.map(time => Math.sin(time * 2 * Math.PI) * 0.5);
  batchListeners.forEach(cb => cb({ samples: timestamps.map((t, index) => ({ channel: 'actual', t, v: values[index] })), logLines: [] }));
  const batch: WaveformBatch = { session_id: sessionId, channel_epoch: epoch, channel_names: ['actual'], points: [], timestamps, series: [values] };
  waveListeners.forEach(cb => cb(batch));
  globalChannelStore.setAlias('fixture-alias', 'actual');
}
const bind = (id: string, callback: () => void | Promise<void>) => document.getElementById(id)!.addEventListener('click', () => { void callback(); });
bind('emit-data', emitBatch);
bind('new-session', () => { epoch++; sessionId = `fixture-evidence-${epoch}`; emitBatch(); });
bind('delay-next', async () => { await fetch('/fixture-ai/delay', { method: 'POST' }); });
bind('release-reply', async () => { await fetch('/fixture-ai/release', { method: 'POST' }); });
bind('capture-proof', async () => {
  const history = await (await fetch('/fixture-ai/history')).json();
  document.getElementById('fixture-proof')!.textContent = JSON.stringify({
    testType: 'real-App-Vue-with-synthetic-transport-and-local-HTTP', externalAiRequests: 0,
    nativeInteractive: 'not-run', hardware: 'not-run', writeAttempts, session: globalChannelStore.getSessionContext(),
    cache: globalChannelStore.getBufferSummary(),
    frozenSelection: assistantEvidenceSelection.value, history,
    metadata: useWidgetStore().dashboardState.value.channels,
    status: Array.from(document.querySelectorAll('[role=status]')).map(node => node.textContent),
  }, null, 2);
});
