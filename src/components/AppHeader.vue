<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { SerialPortInfo } from './TopBar.vue';

const props = defineProps<{
  isRunning: boolean;
  connectionState: 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';
  selectedPort: string;
  selectedBaud: string;
  ports: SerialPortInfo[];
  isRefreshingPorts: boolean;
  totalSamples: number;
  sampleRate: number;
  dataStateLabel?: string;
  droppedBytes?: number;
  protocolErrors?: number;
  emergencyCommand?: string | null;
  canRequestPort?: boolean;
  assistantOpen?: boolean;
  workspaceBusy?: boolean;
  supportsRecording?: boolean;
  recordingStatus?: { isRecording: boolean; rxBytes: number; error: string | null };
  recordingBusy?: boolean;
  isAcquiring?: boolean;
  isDisplayPaused?: boolean;
  writesLocked?: boolean;
  demoBusy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggleConnect'): void;
  (e: 'reset'): void;
  (e: 'changePort', port: string): void;
  (e: 'changeBaud', baud: string): void;
  (e: 'refreshPorts'): void;
  (e: 'requestPort'): void;
  (e: 'triggerEmergencyStop'): void;
  (e: 'openHelp'): void;
  (e: 'toggleRecording'): void;
  (e: 'toggleAcquisition'): void;
  (e: 'openRecordings'): void;
  (e: 'resumeWrites'): void;
  (e: 'startDemo'): void;
  (e: 'openAssistant'): void;
  (e: 'openAnalysis'): void;
}>();

const baudRates = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'];
const connecting = computed(() => ['connecting', 'reconnecting'].includes(props.connectionState));
const acquisitionActive = computed(() => props.isAcquiring ?? props.isRunning);
const isFullscreen = ref(false);
const isDarkTheme = ref(document.documentElement.dataset.theme !== 'light');

function toggleTheme() {
  isDarkTheme.value = !isDarkTheme.value;
  const theme = isDarkTheme.value ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', isDarkTheme.value);
  document.documentElement.classList.toggle('light', !isDarkTheme.value);
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('llm-serial.theme-mode', theme); } catch { /* Session theme still works. */ }
}

function syncFullscreen() { isFullscreen.value = Boolean(document.fullscreenElement); }
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* Some desktop hosts do not expose the fullscreen API. */ }
  syncFullscreen();
}
onMounted(() => document.addEventListener('fullscreenchange', syncFullscreen));
onUnmounted(() => document.removeEventListener('fullscreenchange', syncFullscreen));
</script>

<template>
  <header class="app-header">
    <div class="primary-bar">
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="30" height="30" rx="8" fill="currentColor" fill-opacity=".12" />
          <path d="M5 17h5l3-8 5 15 3-8h6" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        </svg>
        <span class="brand-title">LLM 串口</span>
        <span class="release-label">测试版</span>
      </div>
      <nav class="workspace-switch" aria-label="工作区">
        <span class="workspace-name">串口与波形</span>
        <details class="advanced-menu"><summary>工具</summary><div class="advanced-items"><button type="button" :disabled="props.workspaceBusy" @click="emit('openAnalysis'); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">模型与仿真</button></div></details>
      </nav>
      <div class="primary-actions">
        <button type="button" class="quiet-control assistant-control" :aria-pressed="Boolean(props.assistantOpen)" @click="emit('openAssistant')">{{ props.workspaceBusy ? 'AI 实验运行中' : 'AI 辅助' }}</button>
        <button v-if="props.writesLocked" class="resume-control" type="button"
          @click="emit('resumeWrites')" title="确认设备状态后，显式恢复普通命令发送">恢复发送</button>
        <button type="button" class="stop-control" :class="{ locked: props.writesLocked }"
          @click="emit('triggerEmergencyStop')"
          :title="props.emergencyCommand ? `锁定普通发送，并发送配置的停止字节：${props.emergencyCommand}` : '锁定普通发送并清空待发命令；尚未配置设备停止字节'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M9 9h6v6H9z"/></svg>
          <span>{{ props.writesLocked ? '发送已锁定' : '软件停止' }}</span><kbd>Space</kbd>
        </button>
        <span class="action-divider" aria-hidden="true"></span>
        <button type="button" class="icon-button" @click="toggleTheme"
          :aria-label="isDarkTheme ? '切换浅色主题' : '切换深色主题'" :title="isDarkTheme ? '切换浅色主题' : '切换深色主题'">
          <svg v-if="isDarkTheme" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11z"/></svg>
        </button>
        <button type="button" class="icon-button fullscreen-control" @click="toggleFullscreen"
          :aria-label="isFullscreen ? '退出全屏' : '进入全屏'" :title="isFullscreen ? '退出全屏' : '进入全屏'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/></svg>
        </button>
        <button type="button" class="icon-button" @click="emit('openHelp')" aria-label="帮助与关于" title="帮助与关于">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/></svg>
        </button>
      </div>
    </div>

    <div class="connection-bar" role="group" aria-label="连接与数据采集">
      <div class="serial-controls">
        <label class="visually-hidden" for="header-port">串口端口</label>
        <select id="header-port" class="port-select" :value="props.selectedPort" :disabled="props.isRunning || connecting"
          @change="emit('changePort', ($event.target as HTMLSelectElement).value)">
          <option v-if="!props.selectedPort" value="" disabled>{{ props.ports.length ? '选择串口' : '未检测到串口' }}</option>
          <option v-if="props.selectedPort && !props.ports.some(p => p.port_name === props.selectedPort)" :value="props.selectedPort" disabled>{{ props.selectedPort }} · 未检测到</option>
          <option v-for="p in props.ports" :key="p.port_name" :value="p.port_name">{{ p.port_name === 'mock' ? '演示数据源' : p.port_name }}</option>
        </select>
        <button type="button" class="icon-button refresh-control" :disabled="props.isRunning || connecting || props.isRefreshingPorts"
          @click="emit('refreshPorts')" aria-label="刷新串口列表" title="刷新串口列表">
          <svg :class="{ spinning: props.isRefreshingPorts }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></svg>
        </button>
        <label class="visually-hidden" for="header-baud">波特率</label>
        <select id="header-baud" class="baud-select" :value="props.selectedBaud" :disabled="props.isRunning || connecting"
          @change="emit('changeBaud', ($event.target as HTMLSelectElement).value)">
          <option v-for="rate in baudRates" :key="rate" :value="rate">{{ rate }}</option>
        </select>
        <button type="button" class="connect-control" :class="{ connected: props.isRunning }"
          :disabled="connecting || (!props.isRunning && !props.selectedPort)" @click="emit('toggleConnect')">
          <span class="status-dot" aria-hidden="true"></span>
          {{ props.isRunning ? '断开' : connecting ? '连接中…' : props.connectionState === 'error' ? '重试连接' : '连接' }}
        </button>
        <button v-if="props.canRequestPort && !props.isRunning" type="button" class="quiet-control" @click="emit('requestPort')">授权串口</button>
      </div>
      <button v-if="!props.isRunning" type="button" class="quiet-control demo-control"
        :disabled="props.demoBusy || connecting" @click="emit('startDemo')" title="演示使用模拟数据；不会打开物理串口">{{ props.demoBusy ? '启动演示…' : '体验演示' }}</button>
      <span class="action-divider" aria-hidden="true"></span>
      <button type="button" class="quiet-control" :disabled="!props.isRunning"
        :aria-pressed="acquisitionActive" @click="emit('toggleAcquisition')"
        :title="acquisitionActive ? '暂停字节采集，保留连接' : '恢复字节采集'">{{ acquisitionActive ? '暂停采集' : '开始采集' }}</button>
      <template v-if="props.supportsRecording">
        <button type="button" class="quiet-control recording-control" :class="{ active: props.recordingStatus?.isRecording }"
          :disabled="props.recordingBusy || (!props.isRunning && !props.recordingStatus?.isRecording)"
          :aria-pressed="props.recordingStatus?.isRecording ?? false"
          :title="props.recordingStatus?.error || '原始接收字节写入独立会话记录'" @click="emit('toggleRecording')">
          <span class="status-dot" aria-hidden="true"></span>{{ props.recordingBusy ? '处理中…' : props.recordingStatus?.isRecording ? '停止记录' : '记录' }}
        </button>
        <button type="button" class="quiet-control" @click="emit('openRecordings')" aria-label="打开记录会话列表">记录库</button>
      </template>
      <div class="data-status" role="status" aria-live="polite" :title="props.dataStateLabel">
        <span class="status-dot" :class="{ live: props.isRunning && props.sampleRate > 0 }" aria-hidden="true"></span>
        <span>{{ props.dataStateLabel || '等待连接' }}</span>
      </div>
      <div class="data-metrics" aria-label="数据质量">
        <span v-if="props.sampleRate > 0" class="rate">{{ props.sampleRate.toFixed(0) }} <small>Hz</small></span>
        <span v-if="props.isRunning" class="display-state">{{ props.isDisplayPaused ? '显示已暂停' : '实时显示' }}</span>
        <span v-if="props.droppedBytes" class="warning">丢弃 {{ props.droppedBytes.toLocaleString() }} B</span>
        <span v-if="props.protocolErrors" class="warning">错误 {{ props.protocolErrors.toLocaleString() }}</span>
        <span v-if="props.recordingStatus?.error" class="warning" :title="props.recordingStatus.error">记录异常</span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.app-header { flex:none; background:var(--bg-surface); border-bottom:1px solid var(--border-strong); z-index:50; }
.primary-bar,.connection-bar { display:flex; align-items:center; gap:12px; padding:0 16px; min-width:0; }
.primary-bar { height:52px; }
.connection-bar { min-height:44px; gap:8px; padding-top:5px; padding-bottom:5px; background:var(--bg-base); border-top:1px solid var(--border-subtle); }
.brand { display:flex; align-items:center; gap:9px; flex:none; }
.brand-mark { width:30px; height:30px; color:var(--accent-terracotta); }
.brand-title { font-size:15px; font-weight:650; letter-spacing:.01em; white-space:nowrap; }
.release-label { color:var(--text-muted); font-size:11px; margin-right:14px; }
.workspace-switch { display:flex; align-self:stretch; gap:6px; }
.workspace-name { display:flex; align-items:center; padding:0 12px; font-size:13px; color:var(--text-muted); white-space:nowrap; }
.workspace-switch button { border:0; border-bottom:2px solid transparent; padding:0 14px; color:var(--text-muted); background:transparent; font-size:13px; font-weight:550; white-space:nowrap; }
.workspace-switch button[aria-pressed='true'] { color:var(--accent-terracotta); border-bottom-color:var(--accent-terracotta); }
.workspace-switch button:hover:not(:disabled) { color:var(--text-main); background:var(--bg-elevated); }
.advanced-menu { position:relative; align-self:center; font-size:13px; color:var(--text-muted); }
.advanced-menu summary { cursor:pointer; padding:10px; white-space:nowrap; }
.advanced-items { position:absolute; top:100%; left:0; min-width:180px; padding:6px; display:flex; flex-direction:column; background:var(--bg-surface); border:1px solid var(--border-strong); border-radius:6px; box-shadow:var(--card-shadow); z-index:80; }
.workspace-switch .advanced-items button { padding:10px; text-align:left; justify-content:flex-start; border:0; }
.assistant-control { color:var(--accent-terracotta); }
.assistant-control[aria-pressed='true'] { background:var(--accent-terracotta-soft); border-color:var(--accent-terracotta); }
.primary-actions { margin-left:auto; display:flex; align-items:center; gap:6px; flex:none; }
.action-divider { width:1px; height:18px; background:var(--border-strong); flex:none; margin:0 4px; }
button,select { font:inherit; font-size:12px; border-radius:5px; color:var(--text-main); cursor:pointer; }
button { display:inline-flex; align-items:center; justify-content:center; gap:6px; white-space:nowrap; }
button:disabled,select:disabled { opacity:.45; cursor:not-allowed; }
.icon-button { width:32px; height:32px; border:1px solid transparent; background:transparent; color:var(--text-muted); flex:none; }
.icon-button:hover:not(:disabled) { background:var(--bg-elevated); color:var(--text-main); }
svg { width:17px; height:17px; }
.stop-control { height:32px; padding:0 10px; border:1px solid color-mix(in srgb,var(--accent-rose) 45%,var(--border-subtle)); background:color-mix(in srgb,var(--accent-rose) 9%,var(--bg-surface)); color:var(--accent-rose); font-weight:550; }
.stop-control:hover { background:color-mix(in srgb,var(--accent-rose) 16%,var(--bg-surface)); }
.stop-control kbd { margin-left:6px; padding:2px 4px; border:1px solid var(--border-subtle); color:var(--text-muted); font-size:10px; }
.stop-control.locked { border-color:var(--accent-amber); color:var(--accent-amber); }
.resume-control { height:32px; padding:0 9px; background:var(--bg-elevated); color:var(--accent-amber); border:1px solid var(--border-strong); }
.serial-controls { display:flex; align-items:center; gap:5px; flex:none; }
select { height:30px; border:1px solid var(--border-strong); background:var(--bg-surface); padding:0 7px; }
.port-select { width:132px; }
.baud-select { width:86px; font-variant-numeric:tabular-nums; }
.refresh-control { width:28px; height:28px; }
.connect-control { height:30px; min-width:66px; padding:0 10px; border:1px solid transparent; background:var(--accent-action); color:#fff; font-weight:600; }
.connect-control:hover:not(:disabled) { filter:brightness(1.12); }
.connect-control.connected { border-color:var(--border-strong); color:var(--text-main); background:var(--bg-surface); }
.quiet-control { height:30px; padding:0 9px; background:var(--bg-surface); border:1px solid var(--border-subtle); }
.quiet-control:hover:not(:disabled) { border-color:var(--border-strong); background:var(--bg-elevated); }
.demo-control { color:var(--accent-emerald); }
.recording-control.active { color:var(--accent-rose); border-color:var(--accent-rose); }
.status-dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
.data-status { display:flex; align-items:center; gap:7px; min-width:0; margin-left:auto; color:var(--text-muted); font-size:11px; }
.data-status span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.status-dot.live { color:var(--accent-emerald); }
.data-metrics { display:flex; align-items:center; gap:10px; flex:none; font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums; }
.rate { color:var(--text-main); }.rate small { color:var(--text-muted); }.warning { color:var(--accent-amber); }
.spinning { animation:refresh .8s linear infinite; } @keyframes refresh { to { transform:rotate(360deg); } }
@media(max-width:1100px) { .release-label,.display-state { display:none; }.primary-bar,.connection-bar { padding-left:12px; padding-right:12px; }.data-status { max-width:180px; }.data-metrics { gap:6px; } }
@media(max-width:900px) { .connection-bar { flex-wrap:wrap; }.data-status { max-width:none; flex:1; }.stop-control kbd,.fullscreen-control { display:none; }.workspace-switch button { padding:0 10px; } }
@media(max-width:620px) { .primary-bar { flex-wrap:wrap; height:auto; min-height:52px; padding-top:8px; gap:8px; }.workspace-switch { order:3; width:100%; height:38px; }.brand-title { font-size:13px; }.primary-actions { gap:3px; }.primary-bar .action-divider { display:none; }.connection-bar { gap:6px; }.data-status { flex-basis:60%; }.data-metrics { margin-left:auto; }.port-select { width:118px; } }
@media(prefers-reduced-motion:reduce) { .spinning { animation:none; } }
</style>
