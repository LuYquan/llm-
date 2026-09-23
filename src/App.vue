<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import TopBar, { SerialPortInfo } from './components/TopBar.vue';
import WaveformViewer from './components/WaveformViewer.vue';
import GeneralTerminal, { type LogLine } from './components/GeneralTerminal.vue';
import QuickCommandPanel, { type QuickCmd } from './components/QuickCommandPanel.vue';
import CrcTools from './components/CrcTools.vue';
import SnapshotStream from './components/SnapshotStream.vue';
import MetricRadar, { type RadarScores } from './components/MetricRadar.vue';
import AiTunerPanel from './components/AiTunerPanel.vue';
import { explainLog, type AiConfig, type PidParams } from './services/ai';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SerialStatusEvent, StepSnapshot } from './types/ipc';

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
  ai_config: AiConfig;
  channel_mapping: {
    target: string;
    actual: string;
    output: string;
  };
  quick_commands: QuickCmd[];
  emergency_command?: string | null;
}

// 核心工作区状态
const isRunning = ref(false);
const connectionState = ref<'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error'>('disconnected');
const mode = ref('mock');
const activeTab = ref('waveform'); // 'waveform' | 'debug' (核心双模)
const selectedPort = ref('');
const selectedBaud = ref('115200');
const ports = ref<SerialPortInfo[]>([]);
const isRefreshingPorts = ref(false);
const totalSamples = ref(0);
const sampleRate = ref(100);

// 组件引用
const terminalRef = ref<InstanceType<typeof GeneralTerminal> | null>(null);
const snapshotStreamRef = ref<InstanceType<typeof SnapshotStream> | null>(null);

// 快照与雷达状态
const activeSnapshot = ref<StepSnapshot | null>(null);
const radarScores = ref<RadarScores>({
  overshoot_score: 85,
  speed_score: 75,
  steady_score: 90,
  damping_score: 80,
  robust_score: 88,
});

// 底栏抽屉与日志
const isLogDrawerOpen = ref(false);
let logIdCounter = 0;
const logs = ref<LogLine[]>([
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
const emergencyToastTitle = ref('');
const emergencyToastDesc = ref('');
const emergencyToastLevel = ref<'warn' | 'error' | 'success'>('warn');
let emergencyTimer: number | null = null;

// 单行日志 AI 诊断弹窗
const showLogDiagnoseModal = ref(false);
const diagnosingLog = ref<LogLine | null>(null);
const isExplainingLog = ref(false);
const logDiagnosisText = ref('');

let statusInterval: number | null = null;
let unlistenSerialDisconnect: UnlistenFn | null = null;
let unlistenLogsBatch: UnlistenFn | null = null;
let unlistenStepSnapshot: UnlistenFn | null = null;
let unlistenSerialStatus: UnlistenFn | null = null;
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
  if (logs.value.length > 1000) {
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
    { id: 'cmd_rst', name: '复位', command: 'RST\n', is_hex: false },
    { id: 'cmd_calib', name: '校准', command: 'CALIB\n', is_hex: false },
    { id: 'cmd_stop', name: '急停', command: 'CMD:STOP\n', is_hex: false, danger: true },
  ],
  emergency_command: null,
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

// 加载工作区持久化配置 (Step 2.2 & M8)
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

// 防抖静默保存工作区配置 (Step 2.2 & M8)
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

// 全局键盘事件处理 (ADR 0004 空格键急停)
function handleKeyDown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (
    event.code === 'Space' &&
    target?.tagName !== 'INPUT' &&
    target?.tagName !== 'TEXTAREA' &&
    target?.tagName !== 'SELECT' &&
    !target?.isContentEditable
  ) {
    event.preventDefault();
    triggerEmergencyStop();
  }
}

// ADR 0004 急停发送状态机
async function triggerEmergencyStop() {
  const cmd = appConfig.value.emergency_command?.trim();

  // 1. 未绑定命令：不得发出任何字节，弹出明确提示引导配置
  if (!cmd) {
    emergencyToastTitle.value = '急停槽位未绑定命令 (ADR 0004)';
    emergencyToastDesc.value = '根据安全决策，系统未内置设备特定停机指令，未发出任何字节。请在快捷指令或设置中配置硬件停机命令。';
    emergencyToastLevel.value = 'warn';
    showEmergencyToast.value = true;
    appendLog('warn', '[EMERGENCY]', '全局空格键触发：急停槽位未绑定命令，未发出任何字节 (ADR 0004)。');
    resetEmergencyTimer();
    return;
  }

  // 2. 串口未连接：上报未送达
  if (!isRunning.value) {
    emergencyToastTitle.value = '急停未送达：串口未连接 (ADR 0004)';
    emergencyToastDesc.value = `端口未打开，急停指令 [${cmd}] 无法送达设备。`;
    emergencyToastLevel.value = 'error';
    showEmergencyToast.value = true;
    appendLog('error', '[EMERGENCY]', `全局空格键触发：串口未打开，急停指令未送达: ${cmd} (ADR 0004)。`);
    resetEmergencyTimer();
    return;
  }

  // 3. 已连接且已绑定：走独立的最高优先级发送路径，瞬间下发 (自动判断 HEX / ASCII)
  try {
    const isHexCmd = /^[0-9A-Fa-f]{2}(\s+[0-9A-Fa-f]{2})*$/.test(cmd);
    await invoke('send_emergency_stop', {
      data: cmd,
    });
    emergencyToastTitle.value = '已发出急停指令（未确认回执） (ADR 0004)';
    emergencyToastDesc.value = `最高优先级急停指令 [${cmd}] 已发出${isHexCmd ? ' (HEX)' : ''}。物理链路无回执，请核查硬件状态。`;
    emergencyToastLevel.value = 'warn';
    showEmergencyToast.value = true;
    appendLog('warn', '[EMERGENCY]', `全局空格键触发：最高优先级急停指令已发出 (未确认回执): ${cmd} (ADR 0004)。`);
    resetEmergencyTimer();
  } catch (err: any) {
    emergencyToastTitle.value = '急停发送失败 (ADR 0004)';
    emergencyToastDesc.value = `下发急停指令失败: ${err}`;
    emergencyToastLevel.value = 'error';
    showEmergencyToast.value = true;
    appendLog('error', '[EMERGENCY]', `下发急停指令失败: ${err}`);
    resetEmergencyTimer();
  }
}

function resetEmergencyTimer() {
  if (emergencyTimer) clearTimeout(emergencyTimer);
  emergencyTimer = window.setTimeout(() => {
    showEmergencyToast.value = false;
  }, 4000);
}

// 一键绑定急停指令快捷入口
function bindEmergencyCommand(cmd: string) {
  appConfig.value.emergency_command = cmd;
  debouncedSaveConfig();
  showEmergencyToast.value = false;
  appendLog('info', '[CONFIG]', `急停槽位已成功绑定指令: ${cmd}`);
}

function triggerDisconnectAlert(msg: string) {
  disconnectAlertMsg.value = msg;
  showDisconnectAlert.value = true;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = window.setTimeout(() => {
    showDisconnectAlert.value = false;
  }, 5000);
}

// 终端数据发送 (M4 Step 4.1)
async function handleSendSerialData(data: string, isHex: boolean, appendNewline: boolean) {
  try {
    await invoke('send_serial_data', { data, isHex, appendNewline });
  } catch (err: any) {
    appendLog('error', '[TX_ERR]', `发送失败: ${err?.message || err}`);
  }
}

function handleClearLogs() {
  logs.value = [];
}

function handleAppendToSend(text: string) {
  terminalRef.value?.appendPreset(text);
}

// 快捷指令发送 (M4 Step 4.2)
async function handleSendQuickCommand(cmd: QuickCmd) {
  if (cmd.danger) {
    triggerEmergencyStop();
    return;
  }
  try {
    await invoke('send_serial_data', {
      data: cmd.command,
      isHex: cmd.is_hex,
      appendNewline: true,
    });
    appendLog('info', '[TX:CMD]', `${cmd.name}: ${cmd.command}`);
  } catch (err: any) {
    appendLog('error', '[TX:CMD_ERR]', `${cmd.name} 发送失败: ${err}`);
  }
}

function handleUpdateQuickCommands(list: QuickCmd[]) {
  appConfig.value.quick_commands = list;
  debouncedSaveConfig();
}

function handleChannelMappingUpdate(mapping: { target: string; actual: string; output: string }) {
  appConfig.value.channel_mapping = mapping;
  debouncedSaveConfig();
}

// 快照流选中与五维雷达评分计算 (M3 & M6)
async function handleSelectSnapshot(snapshot: StepSnapshot) {
  activeSnapshot.value = snapshot;
  try {
    const scores = await invoke<RadarScores>('score_step_metrics', {
      metrics: snapshot.metrics,
    });
    radarScores.value = scores;
  } catch (err) {
    console.warn('Failed to score step metrics:', err);
  }
}

function handleUpdateAiConfig(cfg: AiConfig) {
  appConfig.value.ai_config = cfg;
  debouncedSaveConfig();
}

function handlePidApplied(newPid: PidParams) {
  appendLog('info', '[PID:APPLY]', `已向设备核准下发新 PID: Kp=${newPid.kp}, Ki=${newPid.ki}, Kd=${newPid.kd}`);
}

// 单行报错 AI 诊断 (M5 Step 5.4)
async function handleDiagnoseLog(log: LogLine) {
  diagnosingLog.value = log;
  showLogDiagnoseModal.value = true;
  isExplainingLog.value = true;
  logDiagnosisText.value = '';

  try {
    const contextTexts = logs.value.slice(-10).map((l) => `[${l.time}] ${l.tag} ${l.text}`);
    const explanation = await explainLog(log.text, contextTexts, appConfig.value.ai_config);
    logDiagnosisText.value = explanation;
  } catch (err: any) {
    logDiagnosisText.value = `诊断失败: ${err?.message || err}`;
  } finally {
    isExplainingLog.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeyDown);

  // 1. 加载持久化配置
  await loadConfig();

  // 2. 枚举串口列表
  await refreshPorts();

  // 3. 监听串口热插拔断开事件 (Step 2.4 & M7)
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

  // 3.1 监听统一串口状态与重插检测事件 (PR-001 / W2 serial://status)
  try {
    unlistenSerialStatus = await listen<SerialStatusEvent>('serial://status', (event) => {
      const payload = event.payload;
      if (payload.reappeared) {
        appendLog('info', '[SERIAL]', `检测到原串口 [${payload.port || ''}] 已重新插入，可点击重新连接。`);
        triggerDisconnectAlert(`串口 [${payload.port || ''}] 已重新插入，可点击重新连接`);
        connectionState.value = 'reconnecting';
        return;
      }
      if (payload.is_connected) {
        connectionState.value = 'connected';
        isRunning.value = true;
      } else {
        connectionState.value = payload.error ? 'error' : 'disconnected';
        isRunning.value = false;
        if (payload.error) {
          appendLog('warn', '[SERIAL]', `串口连接中断: ${payload.error}`);
          triggerDisconnectAlert(`串口中断: ${payload.error}`);
        }
      }
    });
  } catch (e) {
    console.warn('Failed to register serial://status listener:', e);
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

  // 5. 监听阶跃快照事件 (M3 Step 3.3: step://snapshot)
  try {
    unlistenStepSnapshot = await listen<StepSnapshot>('step://snapshot', (event) => {
      if (!activeSnapshot.value) {
        handleSelectSnapshot(event.payload);
      }
    });
  } catch (e) {
    console.warn('Failed to register step://snapshot listener:', e);
  }

  // 6. 定时拉取后端状态
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
  if (unlistenSerialStatus) unlistenSerialStatus();
  if (unlistenLogsBatch) unlistenLogsBatch();
  if (unlistenStepSnapshot) unlistenStepSnapshot();
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

    <!-- 主工作区：根据 activeTab 双模平滑切换 (PRD 核心双模) -->
    <div class="main-body">
      <!-- 视图 A：【AI波形调参模式】 (VOFA+ 超集，M2, M3, M5, M6) -->
      <div class="mode-view-wrapper" v-show="activeTab === 'waveform'">
        <!-- 左区：uPlot 实时波形视窗 (M2) -->
        <section class="waveform-panel">
          <WaveformViewer @update-mapping="handleChannelMappingUpdate" />
        </section>

        <!-- 右区：阶跃快照流、五维品质雷达、AI 调参卡片 (M3, M5, M6) -->
        <aside class="sidebar-panel">
          <!-- 阶跃快照流历史 (M3) -->
          <SnapshotStream
            ref="snapshotStreamRef"
            @select-snapshot="handleSelectSnapshot"
          />

          <!-- PID 控制品质五维雷达图 (M6) -->
          <MetricRadar :scores="radarScores" />

          <!-- AI 调参专家与 SafetyGuard 核准闭环 (M5 & M6) -->
          <AiTunerPanel
            :active-snapshot="activeSnapshot"
            :ai-config="appConfig.ai_config"
            :is-running="isRunning"
            @update-config="handleUpdateAiConfig"
            @pid-applied="handlePidApplied"
          />
        </aside>
      </div>

      <!-- 视图 B：【常规调试模式】 (XCOM 超集，M4) -->
      <div class="mode-view-wrapper" v-show="activeTab === 'debug'">
        <!-- 左区：现代终端交互监视器 (HEX/ASCII、双向色彩、历史记录) -->
        <section class="debug-terminal-panel">
          <GeneralTerminal
            ref="terminalRef"
            :logs="logs"
            :is-running="isRunning"
            @send-data="handleSendSerialData"
            @clear-logs="handleClearLogs"
            @diagnose-log="handleDiagnoseLog"
          />
        </section>

        <!-- 右区：快捷指令面板与硬件校验工具箱 (M4) -->
        <aside class="debug-sidebar">
          <!-- 快捷指令管理与循环发送 (M4 Step 4.2) -->
          <QuickCommandPanel
            :commands="appConfig.quick_commands"
            :is-running="isRunning"
            @send-command="handleSendQuickCommand"
            @update-commands="handleUpdateQuickCommands"
            @emergency-stop="triggerEmergencyStop"
          />

          <!-- 硬件校验计算器 (M4 Step 4.3: Modbus CRC16 / CRC32 / Sum8 / Xor8) -->
          <CrcTools @append-to-send="handleAppendToSend" />
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
          <span class="emergency-tip" :class="{ 'bound': appConfig.emergency_command }">
            <kbd class="kbd-key">Space</kbd>
            <span>急停: {{ appConfig.emergency_command ? `[${appConfig.emergency_command.trim()}]` : '未绑定 (ADR 0004)' }}</span>
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
          <button
            v-for="cmd in appConfig.quick_commands"
            :key="cmd.id"
            class="cmd-btn"
            :class="{ 'btn-danger': cmd.danger }"
            :disabled="!isRunning"
            @click="handleSendQuickCommand(cmd)"
          >
            {{ cmd.name }}
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
      <div v-if="showEmergencyToast" class="emergency-toast" :class="emergencyToastLevel">
        <div class="toast-icon">⚠️</div>
        <div class="toast-content">
          <div class="toast-title">{{ emergencyToastTitle }}</div>
          <div class="toast-desc">{{ emergencyToastDesc }}</div>
          <div v-if="!appConfig.emergency_command" class="bind-quick-action">
            <button class="btn-bind-quick" @click="bindEmergencyCommand('CMD:STOP\n')">
              ⚡ 一键绑定为 CMD:STOP\n
            </button>
          </div>
        </div>
        <button class="toast-close" @click="showEmergencyToast = false">✕</button>
      </div>
    </transition>

    <!-- 单行日志 AI 智能诊断弹窗 (M5 Step 5.4) -->
    <div v-if="showLogDiagnoseModal" class="modal-backdrop" @click="showLogDiagnoseModal = false">
      <div class="modal-card" @click.stop>
        <div class="modal-header">
          <div class="modal-title-group">
            <span class="modal-sparkle">💡</span>
            <span class="modal-title">AI 单行日志诊断 (Log Explainer)</span>
          </div>
          <button class="modal-close" @click="showLogDiagnoseModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="diagnose-target font-mono">
            <span class="target-tag">{{ diagnosingLog?.tag }}</span>
            <span class="target-text">{{ diagnosingLog?.text }}</span>
          </div>
          <div v-if="isExplainingLog" class="loading-state">
            <span class="spinner">⏳</span>
            <span>大模型控制与固件专家正在诊断中...</span>
          </div>
          <div v-else class="diagnose-content">
            <div class="diagnosis-text">{{ logDiagnosisText }}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-modal-close" @click="showLogDiagnoseModal = false">关闭</button>
        </div>
      </div>
    </div>
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

/* 右区 ~30% 侧边栏 (波形调参模式) */
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

/* 常规调试模式左区终端 */
.debug-terminal-panel {
  flex: 7;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background-color: #080c14;
  border-right: 1px solid var(--border-color);
}

/* 常规调试模式右区侧边栏 */
.debug-sidebar {
  flex: 3;
  min-width: 300px;
  max-width: 420px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background-color: var(--bg-panel);
  overflow-y: auto;
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

.emergency-tip.bound {
  color: var(--accent-amber);
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
  overflow-x: auto;
}

.cmd-label {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
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
  flex-shrink: 0;
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

/* 急停 Toast 提示 (ADR 0004) */
.emergency-toast {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  background-color: #1e1b2e;
  border: 1px solid var(--accent-rose);
  border-radius: 6px;
  padding: 12px 18px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 12px rgba(244, 63, 94, 0.25);
  z-index: 1000;
  max-width: 520px;
}

.emergency-toast.warn {
  border-color: var(--accent-amber);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 12px rgba(245, 158, 11, 0.25);
}

.toast-icon {
  font-size: 20px;
}

.toast-content {
  flex: 1;
}

.toast-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent-rose);
}

.emergency-toast.warn .toast-title {
  color: var(--accent-amber);
}

.toast-desc {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: 4px;
}

.bind-quick-action {
  margin-top: 8px;
}

.btn-bind-quick {
  padding: 4px 10px;
  font-size: 11px;
  background-color: rgba(244, 63, 94, 0.15);
  border: 1px solid var(--accent-rose);
  border-radius: 4px;
  color: #fda4af;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.2s;
}

.btn-bind-quick:hover {
  background-color: var(--accent-rose);
  color: #fff;
}

.toast-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
}

.toast-close:hover {
  color: var(--text-primary);
}

/* AI Log Explainer 弹窗 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-card {
  width: 520px;
  max-width: 90vw;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: rgba(19, 27, 38, 0.8);
}

.modal-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-sparkle {
  font-size: 16px;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 14px;
  cursor: pointer;
}

.modal-close:hover {
  color: var(--text-primary);
}

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}

.diagnose-target {
  padding: 8px 10px;
  background-color: rgba(11, 15, 23, 0.6);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  font-size: 12px;
  display: flex;
  gap: 8px;
}

.target-tag {
  color: var(--accent-rose);
  font-weight: 600;
}

.target-text {
  color: var(--text-primary);
  word-break: break-all;
}

.loading-state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--accent-cyan);
  padding: 20px 0;
  justify-content: center;
}

.spinner {
  font-size: 18px;
  animation: spin 1.5s infinite linear;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.diagnose-content {
  background-color: rgba(11, 15, 23, 0.4);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 12px;
}

.diagnosis-text {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.modal-footer {
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
  background-color: rgba(19, 27, 38, 0.8);
}

.btn-modal-close {
  padding: 6px 14px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.btn-modal-close:hover {
  background-color: var(--bg-card-hover);
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
