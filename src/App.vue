<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import TopBar, { SerialPortInfo } from './components/TopBar.vue';
import WaveformViewer from './components/WaveformViewer.vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface PipelineStatus {
  is_running: boolean;
  mode: string;
  sample_rate: number;
  total_samples: number;
  error_count?: number;
}

interface AppConfig {
  port_name: string | null;
  baud_rate: number;
  mode: string;
  active_tab: string;
  ai_config: {
    provider: string;
    api_key: string;
    api_url: string;
    model: string;
  };
  channel_mapping: {
    target: string;
    actual: string;
    output: string;
  };
  quick_commands: Array<{
    id: string;
    name: string;
    command: string;
    is_hex: boolean;
  }>;
}

interface LogEntry {
  id: number;
  time: string;
  tag: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

// 核心工作区状态
const isRunning = ref(false);
const connectionState = ref<'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error'>('disconnected');
const mode = ref('mock');
const activeTab = ref('waveform'); // 'debug' | 'waveform' (Step 2.5 核心双模)
const selectedPort = ref('');
const selectedBaud = ref('115200');
const ports = ref<SerialPortInfo[]>([]);
const isRefreshingPorts = ref(false);
const totalSamples = ref(0);
const sampleRate = ref(100);

// 底栏抽屉与日志
const isLogDrawerOpen = ref(false);
let logIdCounter = 0;
const logs = ref<LogEntry[]>([
  {
    id: ++logIdCounter,
    time: formatTime(new Date()),
    tag: '[INFO]',
    level: 'info',
    text: '系统初始化就绪，日志服务与状态机已启动。',
  },
  {
    id: ++logIdCounter,
    time: formatTime(new Date()),
    tag: '[INFO]',
    level: 'info',
    text: '双模引擎已挂载：【常规调试模式】与【AI波形调参模式】已连接。',
  },
]);

// 串口断开提示 Toast / Banner
const showDisconnectAlert = ref(false);
const disconnectAlertMsg = ref('');
let disconnectTimer: number | null = null;

// 急停提示 Toast (ADR 0004)
const showEmergencyToast = ref(false);
let emergencyTimer: number | null = null;

// 常规调试模式发送区临时状态
const sendText = ref('');
const sendAsHex = ref(false);
const appendNewline = ref(true);

// 快捷指令列表
const quickCommands = ref([
  { id: 'rst', name: '复位', cmd: 'RST\\n' },
  { id: 'calib', name: '校准', cmd: 'CALIB\\n' },
  { id: 'stop', name: '急停', cmd: 'CMD:STOP\\n', danger: true },
]);

let statusInterval: number | null = null;
let unlistenSerialDisconnect: UnlistenFn | null = null;
let unlistenLogsBatch: UnlistenFn | null = null;
let saveConfigTimer: number | null = null;

function formatTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

function appendLog(level: 'info' | 'warn' | 'error', tag: string, text: string) {
  logs.value.push({
    id: ++logIdCounter,
    time: formatTime(new Date()),
    tag,
    level,
    text,
  });
  if (logs.value.length > 500) {
    logs.value.shift();
  }
}

const appConfig = ref<AppConfig>({
  port_name: null,
  baud_rate: 115200,
  mode: 'mock',
  active_tab: 'waveform',
  ai_config: {
    provider: 'deepseek',
    api_key: '',
    api_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  channel_mapping: {
    target: 'setpoint',
    actual: 'actual',
    output: 'output',
  },
  quick_commands: [
    { id: 'cmd_rst', name: '复位', command: 'RST\\n', is_hex: false },
    { id: 'cmd_calib', name: '校准', command: 'CALIB\\n', is_hex: false },
    { id: 'cmd_stop', name: '急停', command: 'CMD:STOP\\n', is_hex: false },
  ],
});

// 刷新串口列表 (Step 2.3)
async function refreshPorts() {
  isRefreshingPorts.value = true;
  try {
    const list = await invoke<SerialPortInfo[]>('list_serial_ports');
    ports.value = list;
    if (list.length > 0 && !selectedPort.value) {
      selectedPort.value = list[0].port_name;
    }
  } catch (err) {
    console.error('Failed to list serial ports:', err);
    appendLog('warn', '[SERIAL]', `扫描串口列表失败: ${err}`);
  } finally {
    isRefreshingPorts.value = false;
  }
}

// 加载工作区持久化配置 (Step 2.2)
async function loadConfig() {
  try {
    const cfg = await invoke<AppConfig>('load_app_config');
    appConfig.value = cfg;
    if (cfg.port_name) selectedPort.value = cfg.port_name;
    if (cfg.baud_rate) selectedBaud.value = cfg.baud_rate.toString();
    if (cfg.mode) mode.value = cfg.mode;
    if (cfg.active_tab) activeTab.value = cfg.active_tab;
  } catch (err) {
    console.warn('Could not load config:', err);
  }
}

// 防抖静默保存工作区配置 (Step 2.2)
function debouncedSaveConfig() {
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  saveConfigTimer = window.setTimeout(async () => {
    try {
      appConfig.value.port_name = selectedPort.value || null;
      appConfig.value.baud_rate = parseInt(selectedBaud.value, 10) || 115200;
      appConfig.value.mode = mode.value;
      appConfig.value.active_tab = activeTab.value;
      await invoke('save_app_config', { config: appConfig.value });
    } catch (err) {
      console.warn('Failed to save config:', err);
    }
  }, 500);
}

// 监听状态变动自动静默落盘
watch([selectedPort, selectedBaud, mode, activeTab], () => {
  debouncedSaveConfig();
});

// 定时拉取后端状态
async function checkStatus() {
  try {
    const status = await invoke<PipelineStatus>('get_pipeline_status');
    isRunning.value = status.is_running;
    mode.value = status.mode;
    sampleRate.value = status.sample_rate;
    totalSamples.value = status.total_samples;

    if (status.is_running) {
      connectionState.value = 'connected';
    } else if (connectionState.value === 'connected') {
      connectionState.value = 'disconnected';
    }
  } catch (e) {
    // 降级处理
  }
}

// 连接与断开控制
async function handleToggleConnect() {
  if (isRunning.value) {
    try {
      const status = await invoke<PipelineStatus>('stop_pipeline');
      isRunning.value = status.is_running;
      connectionState.value = 'disconnected';
      appendLog('info', '[DISCONNECT]', '数据管线已停止。');
    } catch (err) {
      console.error('Failed to stop pipeline:', err);
      appendLog('error', '[ERROR]', `停止管线失败: ${err}`);
    }
  } else {
    connectionState.value = 'connecting';
    try {
      const status = await invoke<PipelineStatus>('start_pipeline', {
        mode: mode.value,
        port: mode.value === 'serial' ? selectedPort.value : null,
        baudRate: parseInt(selectedBaud.value, 10) || 115200,
      });
      isRunning.value = status.is_running;
      connectionState.value = 'connected';
      appendLog(
        'info',
        '[CONNECT]',
        mode.value === 'serial'
          ? `物理串口 [${selectedPort.value}] 成功打开 (波特率: ${selectedBaud.value})`
          : 'Mock 虚拟仿真数据源已启动 (100Hz)'
      );
    } catch (err: any) {
      console.error('Failed to start pipeline:', err);
      connectionState.value = 'error';
      isRunning.value = false;
      const errorMsg = typeof err === 'string' ? err : err?.message || '连接失败';
      appendLog('error', '[ERROR]', `启动失败: ${errorMsg}`);
      triggerDisconnectAlert(`连接失败: ${errorMsg}`);
    }
  }
}

async function handleReset() {
  try {
    await invoke('reset_pipeline');
    totalSamples.value = 0;
    appendLog('info', '[RESET]', '数据缓冲与波形已清空重置。');
  } catch (err) {
    console.error('Failed to reset pipeline:', err);
    appendLog('error', '[ERROR]', `重置失败: ${err}`);
  }
}

function handleModeChange(newMode: string) {
  mode.value = newMode;
  if (newMode === 'serial' && ports.value.length === 0) {
    refreshPorts();
  }
}

function handleActiveTabChange(newTab: string) {
  activeTab.value = newTab;
}

function handlePortChange(newPort: string) {
  selectedPort.value = newPort;
}

function handleBaudChange(newBaud: string) {
  selectedBaud.value = newBaud;
}

async function handleOpenLogDir() {
  try {
    const dir = await invoke<string>('open_log_dir');
    appendLog('info', '[SYSTEM]', `已在资源管理器中打开日志目录: ${dir}`);
  } catch (err) {
    appendLog('error', '[ERROR]', `打开日志目录失败: ${err}`);
  }
}

function toggleLogDrawer() {
  isLogDrawerOpen.value = !isLogDrawerOpen.value;
}

function handleKeyDown(event: KeyboardEvent) {
  // 空格键全局急停槽位响应 (ADR 0004)
  if (
    event.code === 'Space' &&
    (event.target as HTMLElement)?.tagName !== 'INPUT' &&
    (event.target as HTMLElement)?.tagName !== 'TEXTAREA'
  ) {
    event.preventDefault();
    triggerEmergencyStop();
  }
}

function triggerEmergencyStop() {
  showEmergencyToast.value = true;
  appendLog('warn', '[EMERGENCY]', '全局空格键触发急停槽位：未绑定设备停机指令，未发出任何字节 (ADR 0004)。');
  if (emergencyTimer) clearTimeout(emergencyTimer);
  emergencyTimer = window.setTimeout(() => {
    showEmergencyToast.value = false;
  }, 3000);
}

function triggerDisconnectAlert(msg: string) {
  disconnectAlertMsg.value = msg;
  showDisconnectAlert.value = true;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = window.setTimeout(() => {
    showDisconnectAlert.value = false;
  }, 5000);
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeyDown);

  // 1. 加载持久化配置
  await loadConfig();

  // 2. 枚举串口列表
  await refreshPorts();

  // 3. 监听串口热插拔断开事件 (Step 2.4 热插拔容错)
  try {
    unlistenSerialDisconnect = await listen('serial-disconnected', (event: any) => {
      const p = event.payload?.port || selectedPort.value;
      const reason = event.payload?.reason || '设备可能已被拔出';
      connectionState.value = 'error';
      isRunning.value = false;
      appendLog('warn', '[SERIAL]', `串口 [${p}] 已断开: ${reason}`);
      triggerDisconnectAlert(`串口 [${p}] 异常断开 (${reason})`);
    });
  } catch (e) {
    console.warn('Failed to register serial-disconnected listener:', e);
  }

  // 4. 监听 10Hz 日志批次派发 (M1 Step 1.4: logs://batch)
  try {
    unlistenLogsBatch = await listen<any[]>('logs://batch', (event) => {
      const lines = Array.isArray(event.payload) ? event.payload : (event.payload as any)?.lines;
      if (!lines || !Array.isArray(lines)) return;
      for (const line of lines) {
        const level = (line.level?.toLowerCase() || 'info') as 'info' | 'warn' | 'error';
        const tag = `[${line.direction || 'RX'}]`;
        appendLog(level, tag, line.text);
      }
    });
  } catch (e) {
    console.warn('Failed to register logs://batch listener:', e);
  }

  // 5. 定时拉取后端状态
  checkStatus();
  statusInterval = window.setInterval(checkStatus, 500);

  // 默认启动 Mock 模式
  if (mode.value === 'mock') {
    setTimeout(() => {
      if (!isRunning.value) {
        handleToggleConnect();
      }
    }, 300);
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
  if (statusInterval) clearInterval(statusInterval);
  if (emergencyTimer) clearTimeout(emergencyTimer);
  if (disconnectTimer) clearTimeout(disconnectTimer);
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  if (unlistenSerialDisconnect) unlistenSerialDisconnect();
  if (unlistenLogsBatch) unlistenLogsBatch();
});
</script>

<template>
  <div class="workbench">
    <!-- 顶栏 TopBar (Step 2.5) -->
    <TopBar
      :is-running="isRunning"
      :connection-state="connectionState"
      :mode="mode"
      :active-tab="activeTab"
      :selected-port="selectedPort"
      :selected-baud="selectedBaud"
      :ports="ports"
      :is-refreshing-ports="isRefreshingPorts"
      :total-samples="totalSamples"
      :sample-rate="sampleRate"
      @toggle-connect="handleToggleConnect"
      @reset="handleReset"
      @change-mode="handleModeChange"
      @change-active-tab="handleActiveTabChange"
      @change-port="handlePortChange"
      @change-baud="handleBaudChange"
      @refresh-ports="refreshPorts"
    />

    <!-- 主工作区：根据 activeTab 双模平滑切换 -->
    <div class="main-body">
      <!-- 视图 A：【AI波形调参模式】 (VOFA+ 超集) -->
      <div class="mode-view-wrapper" v-show="activeTab === 'waveform'">
        <!-- 左区：uPlot 实时波形视窗 -->
        <section class="waveform-panel">
          <WaveformViewer />
        </section>

        <!-- 右区：AI 调参卡片与辅助信息 -->
        <aside class="sidebar-panel">
          <!-- AI 调参卡片 -->
          <div class="card ai-card">
            <div class="card-header">
              <div class="card-title-group">
                <span class="ai-sparkle">✨</span>
                <span class="card-title">AI 调参专家</span>
              </div>
              <span class="badge badge-amber">阶段四接入</span>
            </div>
            <div class="card-body">
              <div class="ai-status-box">
                <span class="ai-hint-title">阶跃指标自动提取</span>
                <p class="ai-hint-desc">
                  当检测到目标值阶跃时，系统将在此自动呈现超调量 Mp、调节时间 ts、稳态误差 ess，并由大模型提供 Kp/Ki/Kd 结构化优化建议。
                </p>
              </div>
              <div class="param-preview-group">
                <div class="param-row">
                  <span class="param-name">Kp (比例增益)</span>
                  <span class="param-val font-mono">1.80</span>
                </div>
                <div class="param-row">
                  <span class="param-name">Ki (积分增益)</span>
                  <span class="param-val font-mono">0.60</span>
                </div>
                <div class="param-row">
                  <span class="param-name">Kd (微分增益)</span>
                  <span class="param-val font-mono">0.25</span>
                </div>
              </div>
              <button class="btn-ai-action" disabled>
                <span>请求 AI 诊断 (待接入)</span>
              </button>
            </div>
          </div>

          <!-- 控制品质雷达图占位 -->
          <div class="card radar-card">
            <div class="card-header">
              <span class="card-title">PID 品质五维雷达</span>
              <span class="badge badge-muted">ECharts 占位</span>
            </div>
            <div class="card-body radar-placeholder">
              <div class="radar-circle">
                <span class="radar-label top">超调 Mp</span>
                <span class="radar-label right">速度 ts</span>
                <span class="radar-label bottom-right">阻尼比 ζ</span>
                <span class="radar-label bottom-left">鲁棒性</span>
                <span class="radar-label left">稳态 ess</span>
                <div class="radar-inner-shape"></div>
              </div>
            </div>
          </div>

          <!-- 会话与硬件信息 -->
          <div class="card session-card">
            <div class="card-header">
              <span class="card-title">当前通信状态</span>
            </div>
            <div class="card-body session-info">
              <div class="info-item">
                <span class="info-k">数据源模式:</span>
                <span class="info-v">{{ mode === 'serial' ? '物理串口驱动' : 'Mock 仿真源 (100Hz)' }}</span>
              </div>
              <div class="info-item" v-if="mode === 'serial'">
                <span class="info-k">当前端口:</span>
                <span class="info-v font-mono">{{ selectedPort || '未选择' }}</span>
              </div>
              <div class="info-item" v-if="mode === 'serial'">
                <span class="info-k">波特率:</span>
                <span class="info-v font-mono">{{ selectedBaud }}</span>
              </div>
              <div class="info-item">
                <span class="info-k">刷新频率:</span>
                <span class="info-v font-mono">60 FPS IPC 批次</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <!-- 视图 B：【常规调试模式】 (XCOM 超集骨架，Step 3 核心) -->
      <div class="mode-view-wrapper" v-show="activeTab === 'debug'">
        <section class="debug-terminal-panel">
          <!-- 终端标题工具栏 -->
          <div class="terminal-toolbar">
            <div class="toolbar-left">
              <span class="terminal-title">终端交互监视器</span>
              <span class="badge badge-cyan">阶段三即将完整上线</span>
            </div>
            <div class="toolbar-right">
              <button class="tool-btn" @click="handleOpenLogDir" title="在系统资源管理器中打开日志目录">
                <span>📂 打开日志目录</span>
              </button>
            </div>
          </div>

          <!-- 终端日志区域 -->
          <div class="terminal-body font-mono">
            <div v-for="log in logs" :key="log.id" class="terminal-line" :class="log.level">
              <span class="line-time">[{{ log.time }}]</span>
              <span class="line-tag">{{ log.tag }}</span>
              <span class="line-content">{{ log.text }}</span>
            </div>
          </div>

          <!-- 发送控制面板 -->
          <div class="terminal-send-bar">
            <div class="send-options">
              <label class="opt-label">
                <input type="checkbox" v-model="sendAsHex" />
                <span>HEX 发送</span>
              </label>
              <label class="opt-label">
                <input type="checkbox" v-model="appendNewline" />
                <span>发送新行 (\r\n)</span>
              </label>
            </div>
            <div class="send-input-group">
              <input
                type="text"
                class="send-input font-mono"
                v-model="sendText"
                :placeholder="sendAsHex ? '输入 HEX 字节 (如 01 03 00 00 00 02 C4 0B)' : '输入要发送的命令文本...'"
                :disabled="!isRunning"
              />
              <button class="send-btn" :disabled="!isRunning || !sendText.trim()">
                <span>发送</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 常规调试模式侧边栏：快捷指令列表 -->
        <aside class="debug-sidebar">
          <div class="card">
            <div class="card-header">
              <span class="card-title">快捷指令列表</span>
              <span class="badge badge-cyan">阶段三接入</span>
            </div>
            <div class="card-body">
              <div class="quick-cmd-list">
                <div v-for="cmd in quickCommands" :key="cmd.id" class="cmd-row">
                  <div class="cmd-info">
                    <span class="cmd-name">{{ cmd.name }}</span>
                    <code class="cmd-code font-mono">{{ cmd.cmd }}</code>
                  </div>
                  <button
                    class="cmd-send-btn"
                    :class="{ 'btn-danger': cmd.danger }"
                    :disabled="!isRunning"
                    @click="cmd.danger ? triggerEmergencyStop() : null"
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <span class="card-title">校验与工具</span>
            </div>
            <div class="card-body">
              <p class="tool-desc">
                阶段三将在此集成 Modbus CRC16、CRC32、Checksum8 等校验码即时生成器，以及单行报错一键【💡AI 智能诊断】。
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>

    <!-- 底栏可折叠抽屉：系统日志与快捷指令 -->
    <footer class="log-drawer" :class="{ 'drawer-expanded': isLogDrawerOpen }">
      <div class="drawer-bar" @click="toggleLogDrawer">
        <div class="drawer-title">
          <span class="drawer-arrow">{{ isLogDrawerOpen ? '▼' : '▲' }}</span>
          <span class="drawer-label">系统运行日志 & 快捷指令</span>
          <span class="drawer-badge">{{ logs.length }} 条记录</span>
        </div>
        <div class="drawer-actions" @click.stop>
          <button class="drawer-btn" @click="handleOpenLogDir" title="打开系统日志文件夹 (%APPDATA%/LLM-Serial/logs)">
            <span>📂 日志目录</span>
          </button>
          <span class="emergency-tip">
            <kbd class="kbd-key">Space</kbd> 急停槽位 (ADR 0004)
          </span>
        </div>
      </div>

      <!-- 展开内容区 -->
      <div class="drawer-content" v-if="isLogDrawerOpen">
        <div class="log-terminal font-mono">
          <div v-for="log in logs" :key="log.id" class="log-line" :class="log.level">
            <span class="log-time">[{{ log.time }}]</span>
            <span class="log-tag">{{ log.tag }}</span>
            <span class="log-text">{{ log.text }}</span>
          </div>
        </div>

        <div class="quick-commands-bar">
          <span class="cmd-label">快捷指令:</span>
          <button class="cmd-btn" disabled>RST\n</button>
          <button class="cmd-btn" disabled>CALIB\n</button>
          <button class="cmd-btn btn-danger" @click="triggerEmergencyStop">
            CMD:STOP\n (急停)
          </button>
        </div>
      </div>
    </footer>

    <!-- 串口断开 / 异常提示 Banner -->
    <transition name="fade">
      <div v-if="showDisconnectAlert" class="disconnect-alert">
        <div class="alert-icon">⚠️</div>
        <div class="alert-content">
          <div class="alert-title">串口连接异常</div>
          <div class="alert-desc">{{ disconnectAlertMsg }}</div>
        </div>
        <button class="alert-close" @click="showDisconnectAlert = false">✕</button>
      </div>
    </transition>

    <!-- ADR 0004 急停提示 Toast -->
    <transition name="fade">
      <div v-if="showEmergencyToast" class="emergency-toast">
        <div class="toast-icon">⚠️</div>
        <div class="toast-content">
          <div class="toast-title">急停槽位未绑定命令 (ADR 0004)</div>
          <div class="toast-desc">
            根据安全决策，系统未内置设备特定停机指令，未发出任何字节。请在设置中配置你的硬件停机命令。
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.workbench {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-main);
  overflow: hidden;
  position: relative;
}

.main-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.mode-view-wrapper {
  flex: 1;
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 左区 ~70% 波形视窗 */
.waveform-panel {
  flex: 7;
  height: 100%;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  background-color: var(--bg-main);
}

/* 右区 ~30% 侧边栏 */
.sidebar-panel {
  flex: 3;
  min-width: 320px;
  max-width: 440px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background-color: var(--bg-panel);
  overflow-y: auto;
}

/* 常规调试模式面板 */
.debug-terminal-panel {
  flex: 7;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: #080c14;
  border-right: 1px solid var(--border-color);
}

.terminal-toolbar {
  height: 40px;
  background-color: var(--bg-panel);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.terminal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}

.tool-btn:hover {
  background-color: var(--bg-card-hover);
  color: var(--text-primary);
}

.terminal-body {
  flex: 1;
  padding: 12px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.7;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.terminal-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.line-time {
  color: var(--text-muted);
  flex-shrink: 0;
}

.line-tag {
  font-weight: 600;
  flex-shrink: 0;
}

.terminal-line.info .line-tag {
  color: var(--accent-cyan);
}

.terminal-line.warn .line-tag {
  color: var(--accent-amber);
}

.terminal-line.error .line-tag {
  color: var(--accent-rose);
}

.line-content {
  color: var(--text-primary);
  word-break: break-all;
}

.terminal-send-bar {
  background-color: var(--bg-panel);
  border-top: 1px solid var(--border-color);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.send-options {
  display: flex;
  align-items: center;
  gap: 16px;
}

.opt-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.send-input-group {
  display: flex;
  gap: 8px;
}

.send-input {
  flex: 1;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
}

.send-input:focus {
  border-color: var(--accent-cyan);
}

.send-btn {
  padding: 6px 18px;
  background-color: #0284c7;
  border: 1px solid #0ea5e9;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;
}

.send-btn:hover:not(:disabled) {
  background-color: #0369a1;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.debug-sidebar {
  flex: 3;
  min-width: 300px;
  max-width: 400px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background-color: var(--bg-panel);
  overflow-y: auto;
}

.quick-cmd-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cmd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background-color: rgba(11, 15, 23, 0.4);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
}

.cmd-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cmd-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.cmd-code {
  font-size: 11px;
  color: var(--accent-cyan);
  background-color: rgba(14, 165, 233, 0.1);
  padding: 1px 4px;
  border-radius: 3px;
}

.cmd-send-btn {
  padding: 3px 8px;
  font-size: 11px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-primary);
  cursor: pointer;
}

.cmd-send-btn:hover:not(:disabled) {
  background-color: var(--bg-card-hover);
}

.tool-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-header {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: rgba(24, 34, 50, 0.6);
}

.card-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-sparkle {
  font-size: 14px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.badge-amber {
  background-color: rgba(245, 158, 11, 0.15);
  color: var(--accent-amber);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.badge-cyan {
  background-color: rgba(14, 165, 233, 0.15);
  color: var(--accent-cyan);
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.badge-muted {
  background-color: rgba(100, 116, 139, 0.15);
  color: var(--text-muted);
  border: 1px solid rgba(100, 116, 139, 0.2);
}

.card-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-status-box {
  background-color: rgba(11, 15, 23, 0.6);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px 10px;
}

.ai-hint-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-cyan);
  display: block;
  margin-bottom: 4px;
}

.ai-hint-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.param-preview-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background-color: rgba(11, 15, 23, 0.4);
  padding: 8px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
}

.param-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}

.param-name {
  color: var(--text-secondary);
}

.param-val {
  font-weight: 600;
  color: var(--accent-emerald);
}

.btn-ai-action {
  width: 100%;
  padding: 8px;
  background: linear-gradient(135deg, #0284c7, #0369a1);
  border: 1px solid #0ea5e9;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  opacity: 0.6;
}

/* 雷达图占位 */
.radar-placeholder {
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radar-circle {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  border: 1px dashed var(--border-color);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.radar-inner-shape {
  width: 70px;
  height: 70px;
  background-color: rgba(56, 189, 248, 0.15);
  border: 1.5px solid var(--accent-cyan);
  clip-path: polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%);
}

.radar-label {
  position: absolute;
  font-size: 9px;
  color: var(--text-muted);
}

.radar-label.top { top: -14px; }
.radar-label.right { right: -36px; }
.radar-label.bottom-right { bottom: -14px; right: -10px; }
.radar-label.bottom-left { bottom: -14px; left: -10px; }
.radar-label.left { left: -36px; }

/* 会话信息 */
.session-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.info-item {
  display: flex;
  justify-content: space-between;
}

.info-k {
  color: var(--text-muted);
}

.info-v {
  color: var(--text-primary);
}

/* 底栏抽屉 */
.log-drawer {
  background-color: var(--bg-panel);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: height 0.25s ease;
  height: 32px;
}

.log-drawer.drawer-expanded {
  height: 180px;
}

.drawer-bar {
  height: 32px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  background-color: rgba(19, 27, 38, 0.9);
  flex-shrink: 0;
}

.drawer-bar:hover {
  background-color: var(--bg-card);
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.drawer-arrow {
  font-size: 10px;
  color: var(--accent-cyan);
}

.drawer-badge {
  font-size: 10px;
  padding: 1px 5px;
  background-color: #1e293b;
  color: var(--text-muted);
  border-radius: 3px;
  border: 1px solid #334155;
}

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.drawer-btn {
  padding: 2px 6px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.drawer-btn:hover {
  color: var(--text-primary);
  background-color: var(--bg-card-hover);
}

.emergency-tip {
  font-size: 11px;
  color: var(--accent-rose);
  display: flex;
  align-items: center;
  gap: 4px;
}

.kbd-key {
  padding: 1px 5px;
  background-color: #1e293b;
  border: 1px solid #475569;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: #f1f5f9;
}

.drawer-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  background-color: #080c14;
  border-top: 1px solid var(--border-subtle);
  overflow: hidden;
}

.log-terminal {
  flex: 1;
  padding: 8px 12px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.log-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-time {
  color: var(--text-muted);
}

.log-tag {
  font-weight: 600;
}

.log-line.info .log-tag {
  color: var(--accent-cyan);
}

.log-line.warn .log-tag {
  color: var(--accent-amber);
}

.log-line.error .log-tag {
  color: var(--accent-rose);
}

.log-text {
  color: var(--text-primary);
}

.quick-commands-bar {
  height: 36px;
  background-color: var(--bg-panel);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 8px;
}

.cmd-label {
  font-size: 11px;
  color: var(--text-muted);
}

.cmd-btn {
  padding: 3px 8px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
}

.cmd-btn:hover:not(:disabled) {
  background-color: var(--bg-card-hover);
}

.cmd-btn.btn-danger {
  color: var(--accent-rose);
  border-color: rgba(244, 63, 94, 0.4);
}

.cmd-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 串口异常断开 Alert */
.disconnect-alert {
  position: fixed;
  top: 60px;
  right: 20px;
  background-color: #1e1b2e;
  border: 1px solid var(--accent-rose);
  border-radius: 6px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  z-index: 1000;
  max-width: 400px;
}

.alert-icon {
  font-size: 18px;
}

.alert-content {
  flex: 1;
}

.alert-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent-rose);
}

.alert-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.alert-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
}

.alert-close:hover {
  color: var(--text-primary);
}

/* 急停 Toast 提示 */
.emergency-toast {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  background-color: #1e1b2e;
  border: 1px solid var(--accent-rose);
  border-radius: 6px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 12px rgba(244, 63, 94, 0.25);
  z-index: 1000;
  max-width: 480px;
}

.toast-icon {
  font-size: 20px;
}

.toast-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent-rose);
}

.toast-desc {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin-top: 2px;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
