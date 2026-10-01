<script setup lang="ts">
import { computed, defineAsyncComponent, provide, ref, shallowRef, onMounted, onUnmounted, watch } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import AppHeader from './components/AppHeader.vue';
import IconDock, { type DockDrawerType } from './components/IconDock.vue';
import WidgetDrawer from './components/WidgetDrawer.vue';
import ConnectionAndProtocolDrawer from './components/ConnectionAndProtocolDrawer.vue';
import CommandLibraryDrawer from './components/CommandLibraryDrawer.vue';
import ProjectDrawer from './components/ProjectDrawer.vue';
import RightDataSidebar from './components/RightDataSidebar.vue';
import UnifiedCanvasWorkbench from './components/UnifiedCanvasWorkbench.vue';
import DockedTerminalStrip from './components/DockedTerminalStrip.vue';
import TerminalLogDrawer from './components/TerminalLogDrawer.vue';
const CopilotDrawer = defineAsyncComponent(() => import('./components/CopilotDrawer.vue'));
const DebugAssistantPanel = defineAsyncComponent(() => import('./components/DebugAssistantPanel.vue'));
const TuningWorkbench = defineAsyncComponent(() => import('./components/TuningWorkbench.vue'));
const RecordingLibraryDrawer = defineAsyncComponent(() => import('./components/RecordingLibraryDrawer.vue'));
import type { LogLine } from './components/GeneralTerminal.vue';
import type { QuickCmd } from './components/QuickCommandPanel.vue';
import type { SerialPortInfo } from './components/TopBar.vue';
import { useWidgetStore, createNewWidget, DEFAULT_CHANNEL_PALETTE } from './stores/widgetStore';
import type { AssistantAction } from './core/assistant/debugAssistant';
import { CHART_EVIDENCE_CONTEXT } from './core/assistant/chartEvidenceContext';
import { assistantEvidenceSelection, clearEvidenceSelection } from './core/assistant/evidenceSelectionStore';
import { globalSendGate } from './core/widget/sendGate';
import { globalRenderScheduler } from './core/widget/renderScheduler';
import { globalChannelStore } from './core/channel/ChannelStore';
import { globalLogAnalyzer } from './core/copilot/LogAnalyzer';
import { globalProjectModel, validateProjectModel } from './core/project/ProjectModel';
import { validateAndMigrateDashboard } from './core/widget/schema';
import type { FirmwareAnomaly } from './core/copilot/types';
import type { ControlLoop } from './core/project/types';
import { aiServiceNeedsKey, type AiConfig } from './services/ai';
import { useSerialSession, type RecordedRawChunk, type RecordingPage, type RecordingStatus, type RecordingSummary } from './services/transport/session';
import {
  formatRecordingRawChunksCsv,
  formatRecordingSamplesCsv,
  RecordingReplayDecoder,
  type RecordingReplaySample,
} from './services/recording/replay-decoder';
import { RecordingReplayController } from './services/recording/replay-controller';
import type { SerialSettings, Unsubscribe, WriteReceipt, WriteResultEvent } from './services/transport/types';
import type { ProtocolConfig } from './core/protocol/types';
import type { StepSnapshot } from './types/ipc';
import {
  buildWorkspaceDocument,
  previewWorkspaceDocument,
  type WorkspaceDocument,
} from './services/workspace/document';
import { runWorkspaceTransaction } from './services/workspace/transaction';
import { tuningCommandBytes, type TuningCommandPayload } from './core/tuning/commandContract';

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
  serial_settings: SerialSettings;
  protocol_config: ProtocolConfig;
}

// 核心工作区状态 (纯正 VOFA+ 单画布架构)
const isRunning = ref(false);
const assistantTab = ref<'tuning' | 'debug'>('tuning');
// Mount each secondary workspace on first use, then keep its draft and records alive.
const tuningVisited = ref(false);
const copilotVisited = ref(false);
const recordingsVisited = ref(false);
const isTuningBusy = ref(false);
const tuningWriteAccessReady = ref(true);
const ordinaryWriteRevision = ref(0);
const pendingSignalChanges = ref(0);
const tuningStopToken = ref(0);
const tuningWriteResult = ref<{
  id: string;
  requestId?: string;
  sessionId?: string;
  epoch?: number;
  status: 'queued' | 'written' | 'failed';
  at: number;
  error?: string;
} | null>(null);
const isStreamPaused = ref(false);
const isAcquiring = ref(false);
const connectionState = ref<'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error'>('disconnected');
const mode = ref('serial');
const selectedPort = ref('');
const selectedBaud = ref('115200');
const ports = ref<SerialPortInfo[]>([]);
const isRefreshingPorts = ref(false);
const dtrState = ref<boolean | null>(null);
const rtsState = ref<boolean | null>(null);
const totalSamples = ref(0);
const sampleRate = ref(0);
const pipelineErrorCount = ref(0);
const pipelineDroppedBytes = ref(0);
const activeChannels = ref<string[]>([]);
const dataStateLabel = computed(() => {
  if (mode.value === 'mock' && isRunning.value) {
    if (!isAcquiring.value) return '演示 · 采集已暂停';
    return totalSamples.value > 0 ? '演示 · 模拟遥测运行中' : '演示 · 等待模拟样本';
  }
  if (connectionState.value === 'error') return '连接异常 · 请检查端口与参数';
  if (!isRunning.value) return mode.value === 'mock' ? '演示未启动' : '未连接 · 可连接设备或体验演示';
  if (!isAcquiring.value) return '已连接 · 采集已暂停';
  if (activeChannels.value.length === 0) return '已连接 · 等待字节或协议解析';
  if (totalSamples.value === 0) return '已连接 · 尚未收到有效样本';
  if (sampleRate.value <= 0) return '已收到样本 · 时间质量未知';
  return '数据正常 · 波形已更新';
});

// 侧边栏与悬浮抽屉状态 (阶段一)
const activeDockDrawer = ref<DockDrawerType>(null);
const isApplyingProtocol = ref(false);
const widgetStore = useWidgetStore();
const workbenchRef = ref<InstanceType<typeof UnifiedCanvasWorkbench> | null>(null);
const rightSidebarRef = ref<InstanceType<typeof RightDataSidebar> | null>(null);

function handleCanvasClick() {
  activeDockDrawer.value = null;
  rightSidebarRef.value?.collapse();
}

// 底部交互条与终端日志抽屉状态 (阶段二)
const isTerminalDrawerOpen = ref(true);
const unreadLogCount = ref(0);
const totalRxBytes = ref<number | null>(null);
const totalTxBytes = ref<number | null>(null);
const terminalStripRef = ref<InstanceType<typeof DockedTerminalStrip> | null>(null);

// Copilot 抽屉与异常状态机 (阶段四)
const copilotDrawerRef = ref<InstanceType<typeof DebugAssistantPanel> | null>(null);
const pendingCopilotPrompt = ref<{ prompt: string; log?: string } | null>(null);
const pendingAssistantSettings = ref(false);
provide(CHART_EVIDENCE_CONTEXT, computed(() => ({
  source: mode.value === 'mock' ? 'demo' as const : isRunning.value ? 'live' as const : 'unknown' as const,
  timeSource: mode.value === 'mock' ? '演示生成的时间轴（秒）' : '缓存时间轴（秒）；设备采样时钟未验证',
  canReview: !isTuningBusy.value && !isApplyingProtocol.value,
  disabledReason: isTuningBusy.value ? '先停止当前参数实验，再审阅选区。' : isApplyingProtocol.value ? '协议切换完成后重新选择区间。' : '',
})));
const clearAssistantOnChannelClear = globalChannelStore.onCleared(() => clearEvidenceSelection());
watch(assistantEvidenceSelection, (selection) => {
  if (!selection) return;
  if (isTuningBusy.value || isApplyingProtocol.value) {
    clearEvidenceSelection();
    appendLog('warn', '[AI EVIDENCE]', '当前实验或协议切换占用工作区，请结束后重新选择区间。');
    return;
  }
  analysisOpen.value = false;
  assistantTab.value = 'debug';
  copilotVisited.value = true;
  isCopilotDrawerOpen.value = true;
  const prompt = { prompt: '解释这个波形选区的变化，区分可直接观察的现象与仍需核对的原因。' };
  if (copilotDrawerRef.value) copilotDrawerRef.value.prefill(prompt.prompt);
  else pendingCopilotPrompt.value = prompt;
}, { flush: 'sync' });
watch(copilotDrawerRef, (drawer) => {
  if (drawer && pendingAssistantSettings.value) {
    pendingAssistantSettings.value = false;
    drawer.openSettings();
  }
  if (drawer && pendingCopilotPrompt.value) {
    const prompt = pendingCopilotPrompt.value;
    pendingCopilotPrompt.value = null;
    drawer.prefill(prompt.prompt, prompt.log);
  }
});
const isCopilotDrawerOpen = ref(false);
const analysisOpen = ref(false);
const analysisVisited = ref(false);
const aiConfigRevision = ref(0);
const assistantConfigurationVersion = computed(() => JSON.stringify([selectedPort.value, selectedBaud.value, appConfig.value.serial_settings, aiConfigRevision.value]));
const assistantContextLabel = computed(() => mode.value === 'mock' && isRunning.value ? '演示会话 · 模拟数据' : isRunning.value ? `${selectedPort.value} · ${selectedBaud.value} bps` : '未连接设备');
const activeAnomaly = ref<FirmwareAnomaly | null>(null);
const anomaliesList = ref<FirmwareAnomaly[]>([]);
const activeLoop = ref<ControlLoop | null>(globalProjectModel.getActiveLoop() || null);
const currentPhaseMargin = ref<number | undefined>(undefined);
const activeSnapshot = ref<StepSnapshot | null>(null);

// 帮助说明弹窗
const showHelpModal = ref(false);

// 日志计数器
let logIdCounter = 0;
const initialLogAt = Date.now();
const logs = ref<LogLine[]>([
  {
    id: ++logIdCounter,
    time: formatTime(new Date(initialLogAt)),
    at: initialLogAt,
    tag: '[INFO]',
    level: 'info',
    text: '可靠串口工作台已就绪；可以连接物理串口、启动隔离演示或打开历史记录。',
  },
  {
    id: ++logIdCounter,
    time: formatTime(new Date(initialLogAt)),
    at: initialLogAt,
    tag: '[INFO]',
    level: 'info',
    text: '选择串口和协议后查看终端与波形；AI 助手可解释选中日志，高级工具用于模型与参数实验。',
  },
]);

// 串口断开提示 Toast
const showDisconnectAlert = ref(false);
const disconnectAlertMsg = ref('');
let disconnectTimer: number | null = null;

// 急停提示 Toast (ADR 0004)
const showEmergencyToast = ref(false);
const emergencyToastTitle = ref('');
const emergencyToastDesc = ref('');
const emergencyToastLevel = ref<'warn' | 'error' | 'success'>('warn');
let emergencyTimer: number | null = null;


const session = useSerialSession();
const diagnosticErrorCount = computed(() => Math.max(pipelineErrorCount.value, session.protocolErrors.value));
const displayedDroppedBytes = computed(() => Math.max(pipelineDroppedBytes.value, session.droppedBytes.value));
const recordingStatus = ref<RecordingStatus>({ isRecording: false, sessionId: null, directory: null, rxBytes: 0, rxChunks: 0, error: null });
const recordingBusy = ref(false);
const recordingLibraryOpen = ref(false);
watch(recordingLibraryOpen, (open) => { if (open) recordingsVisited.value = true; });
watch(isCopilotDrawerOpen, (open) => { if (open) copilotVisited.value = true; });
const recordingLibraryLoading = ref(false);
const recordingLibraryError = ref<string | null>(null);
const recordingSummaries = ref<RecordingSummary[]>([]);
const recordingReplaySession = ref<RecordingSummary | null>(null);
const recordingReplayPage = ref<RecordingPage | null>(null);
const recordingReplayChunks = ref<RecordedRawChunk[]>([]);
const recordingReplayLoading = ref(false);
const recordingReplayError = ref<string | null>(null);
const recordingReplaySamples = ref<RecordingReplaySample[]>([]);
const recordingReplayLogs = ref<{ timeSeconds: number; text: string }[]>([]);
const recordingReplayDecoder = shallowRef<RecordingReplayDecoder | null>(null);
const recordingReplayDecodeNotice = ref<string | null>(null);
const recordingReplayDecodeErrorCount = ref(0);
const recordingReplayController = new RecordingReplayController({
  session: recordingReplaySession,
  page: recordingReplayPage,
  chunks: recordingReplayChunks,
  loading: recordingReplayLoading,
  error: recordingReplayError,
  samples: recordingReplaySamples,
  logs: recordingReplayLogs,
  decoder: recordingReplayDecoder,
  decodeNotice: recordingReplayDecodeNotice,
  decodeErrorCount: recordingReplayDecodeErrorCount,
}, (...args) => session.readRecordingPage(...args));
const demoBusy = ref(false);
const configPersistenceBlocked = ref(false);
const workspaceImportStatus = ref<{ type: 'success' | 'error'; text: string } | null>(null);
const canControlSerialSignals = computed(
  () => isRunning.value && session.transport.value?.supportsSignals === true
);

let statusInterval: number | null = null;
let unsubStatus: Unsubscribe | null = null;
let unsubError: Unsubscribe | null = null;
let unsubWriteResult: Unsubscribe | null = null;
let unsubLogsBatch: Unsubscribe | null = null;
let unsubRawData: Unsubscribe | null = null;
let lastRawPreviewAt = 0;
let unsubChannelCapacity: (() => void) | null = null;
let unsubStepSnapshot: Unsubscribe | null = null;
let unsubWaveformBatch: Unsubscribe | null = null;
let unsubProjectModel: (() => void) | null = null;
let saveConfigTimer: number | null = null;
const observedWriteResults = new Map<string, WriteResultEvent>();
const trackedWriteRequests = new Set<string>();
const reportedWriteResults = new Set<string>();
const writeResultWaiters = new Map<string, Set<(result: WriteResultEvent) => void>>();

function formatTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

function appendLog(level: 'info' | 'warn' | 'error', tag: string, text: string) {
  const at = Date.now();
  logs.value.push({
    id: ++logIdCounter,
    time: formatTime(new Date(at)),
    at,
    tag,
    level,
    text,
  });
  if (logs.value.length > 1500) {
    logs.value.shift();
  }

  if (!isTerminalDrawerOpen.value) {
    unreadLogCount.value++;
  }

  // 固件异常识别与事件胶囊驱动
  const anom = globalLogAnalyzer.analyzeLogLine(text);
  if (anom) {
    activeAnomaly.value = anom;
    anomaliesList.value.unshift(anom);
    if (anomaliesList.value.length > 30) {
      anomaliesList.value.pop();
    }
  }
}

function reportWriteResult(result: WriteResultEvent) {
  if (reportedWriteResults.has(result.request_id)) return;
  reportedWriteResults.add(result.request_id);
  if (totalTxBytes.value !== null) totalTxBytes.value += result.written_bytes;
  const identity = `${result.request_id} · ${result.written_bytes}/${result.requested_bytes} 字节`;
  if (result.status === 'written') {
    appendLog('info', '[TX_WRITTEN]', `${identity} 已完成本地串口驱动写入；设备执行未确认`);
  } else if (result.status === 'failed') {
    appendLog('error', '[TX_ERR]', `${identity} 写入失败${result.reason ? `：${result.reason}` : ''}`);
  } else {
    appendLog('warn', '[TX_CANCELED]', `${identity} 状态为 ${result.status}${result.reason ? `：${result.reason}` : ''}`);
  }
}

function rememberWriteResult(result: WriteResultEvent) {
  observedWriteResults.set(result.request_id, result);
  if (observedWriteResults.size > 1000) {
    const oldest = observedWriteResults.keys().next().value;
    if (oldest) observedWriteResults.delete(oldest);
  }
  const waiters = writeResultWaiters.get(result.request_id);
  if (waiters) {
    for (const resolve of waiters) resolve(result);
    writeResultWaiters.delete(result.request_id);
  }
  if (trackedWriteRequests.has(result.request_id) || result.source === 'software_stop') {
    reportWriteResult(result);
  }
  if (tuningWriteResult.value?.requestId === result.request_id) {
    tuningWriteResult.value = {
      ...tuningWriteResult.value,
      sessionId: result.session_id,
      epoch: result.epoch,
      status: result.status === 'written' ? 'written' : 'failed',
      error: result.status === 'written' ? undefined : result.reason || `写入状态：${result.status}`,
      at: Date.now(),
    };
  }
}

function reportWriteReceipt(receipt: WriteReceipt, tag: string, description: string) {
  trackedWriteRequests.add(receipt.request_id);
  if (trackedWriteRequests.size > 1000) {
    const oldest = trackedWriteRequests.values().next().value;
    if (oldest) trackedWriteRequests.delete(oldest);
  }
  const result = observedWriteResults.get(receipt.request_id);
  if (result) {
    reportWriteResult(result);
  } else if (receipt.status === 'written') {
    if (totalTxBytes.value !== null) totalTxBytes.value += receipt.byte_count;
    reportedWriteResults.add(receipt.request_id);
    appendLog('info', tag, `${description} · ${receipt.byte_count} 字节已写入本地传输；设备执行未确认`);
  } else {
    appendLog('info', tag, `${description} · ${receipt.byte_count} 字节已排队，等待驱动写入 · ${receipt.request_id}`);
  }
}

function waitForWriteResult(requestId: string, timeoutMs: number): Promise<WriteResultEvent | null> {
  const known = observedWriteResults.get(requestId);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const waiters = writeResultWaiters.get(requestId) ?? new Set<(result: WriteResultEvent) => void>();
    let settled = false;
    const finish = (result: WriteResultEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(onResult);
      if (waiters.size === 0) writeResultWaiters.delete(requestId);
      resolve(result);
    };
    const onResult = (result: WriteResultEvent) => finish(result);
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    waiters.add(onResult);
    writeResultWaiters.set(requestId, waiters);
  });
}

watch(isTerminalDrawerOpen, (open) => {
  if (open) {
    unreadLogCount.value = 0;
  }
});

const appConfig = ref<AppConfig>({
  port_name: null,
  baud_rate: 115200,
  mode: 'serial',
  active_tab: 'waveform',
  ai_config: {
    provider: 'deepseek',
    api_key: '',
    api_key_configured: false,
    api_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  channel_mapping: {
    target: 'setpoint',
    actual: 'actual',
    output: 'output',
  },
  // Device-specific commands must be added explicitly by the user; no
  // firmware command is assumed to exist on a fresh workspace.
  quick_commands: [],
  emergency_command: null,
  serial_settings: { dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' },
  protocol_config: { type: 'firewater' },
});

const workspaceDocument = computed<WorkspaceDocument>(() => buildWorkspaceDocument({
  portName: selectedPort.value || appConfig.value.port_name,
  baudRate: Number.parseInt(selectedBaud.value, 10) || appConfig.value.baud_rate || 115200,
  mode: mode.value,
  serialSettings: appConfig.value.serial_settings,
  protocolConfig: appConfig.value.protocol_config,
  channelMapping: appConfig.value.channel_mapping,
  commands: appConfig.value.quick_commands,
  emergencyCommand: appConfig.value.emergency_command,
  aiConfig: appConfig.value.ai_config,
  dashboard: widgetStore.dashboardState.value,
  projectModel: globalProjectModel.getModel(),
  recordSessionIds: recordingSummaries.value.map((item) => item.manifest.sessionId),
}));

// 刷新串口列表
async function refreshPorts(silent = false) {
  if (!silent) isRefreshingPorts.value = true;
  try {
    const list = await session.refreshPorts();
    ports.value = list as any;
    if (list.length > 0) {
      const portExists = list.some((p: any) => (p.port_name || p.id) === selectedPort.value);
      if (!selectedPort.value || !portExists || selectedPort.value === 'VIRTUAL_COM' || selectedPort.value === 'mock') {
        selectedPort.value = list[0].port_name || list[0].id;
      }
    } else {
      if (selectedPort.value === 'VIRTUAL_COM' || selectedPort.value === 'mock') {
        selectedPort.value = '';
      }
    }
  } catch (err) {
    if (!silent) {
      console.error('Failed to list serial ports:', err);
      appendLog('warn', '[SERIAL]', `扫描串口列表失败: ${err}`);
    }
  } finally {
    if (!silent) isRefreshingPorts.value = false;
  }
}

// WebSerial 手势授权新串口
async function handleRequestPort() {
  try {
    const port = await session.requestPort();
    if (port) {
      selectedPort.value = port.port_name || port.id;
      appendLog('info', '[SERIAL]', `已添加并授权 Web 串口: ${port.label || port.id}`);
    }
  } catch (err: any) {
    appendLog('warn', '[SERIAL]', `授权串口失败: ${err?.message || err}`);
  }
}

// 加载工作区持久化配置
async function loadConfig() {
  try {
    const cfg = await session.loadAppConfig();
    if (cfg) {
      appConfig.value = {
        ...appConfig.value,
        ...cfg,
        serial_settings: {
          ...appConfig.value.serial_settings,
          ...(cfg.serial_settings || {}),
        },
        protocol_config: cfg.protocol_config || appConfig.value.protocol_config,
      };
      await session.configureProtocol(appConfig.value.protocol_config);
      if (cfg.port_name && cfg.port_name !== 'VIRTUAL_COM' && cfg.port_name !== 'mock') {
        selectedPort.value = cfg.port_name;
      }
      if (Number.isInteger(cfg.baud_rate) && cfg.baud_rate > 0) {
        selectedBaud.value = String(cfg.baud_rate);
      }
      if (cfg.mode && cfg.mode === 'mock') {
        mode.value = 'serial';
      } else if (cfg.mode) {
        mode.value = cfg.mode;
      } else {
        mode.value = 'serial';
      }
    }
  } catch (err) {
    configPersistenceBlocked.value = true;
    const message = err instanceof Error ? err.message : String(err);
    appendLog('error', '[CONFIG]', `配置读取失败，已保留原文件并暂停后台保存: ${message}`);
  }
}

// 防抖静默保存工作区配置
function debouncedSaveConfig() {
  if (configPersistenceBlocked.value) return;
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  saveConfigTimer = window.setTimeout(async () => {
    try {
      appConfig.value.port_name = (mode.value === 'serial' && selectedPort.value !== 'VIRTUAL_COM' && selectedPort.value !== 'mock') ? selectedPort.value : null;
      appConfig.value.baud_rate = parseInt(selectedBaud.value, 10) || 115200;
      appConfig.value.mode = mode.value;
      await session.saveAppConfig(appConfig.value);
    } catch (err) {
      appendLog('error', '[CONFIG]', `配置保存失败，已停止继续自动保存: ${err instanceof Error ? err.message : String(err)}`);
      configPersistenceBlocked.value = true;
    }
  }, 500);
}

async function handleImportWorkspace(json: string) {
  workspaceImportStatus.value = null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    workspaceImportStatus.value = { type: 'error', text: `工作区 JSON 语法错误：${error instanceof Error ? error.message : String(error)}` };
    return;
  }
  const preview = previewWorkspaceDocument(raw);
  if (!preview.ok || !preview.document) {
    workspaceImportStatus.value = { type: 'error', text: `工作区未导入：${preview.errors.join('；')}` };
    appendLog('error', '[WORKSPACE]', `导入预览失败：${preview.errors.join('；')}`);
    return;
  }
  if (isRunning.value) {
    workspaceImportStatus.value = { type: 'error', text: '当前已有连接；请先断开设备，再导入工作区。' };
    appendLog('warn', '[WORKSPACE]', '拒绝在连接期间整体替换工作区，避免协议和发送状态发生半导入。');
    return;
  }

  const warningText = preview.warnings.length > 0 ? `\n\n提示：${preview.warnings.join('；')}` : '';
  const approved = typeof window === 'undefined'
    || window.confirm(`将替换当前连接、协议、通道和画布配置。命令只会作为草稿导入，自动写入保持关闭。${warningText}\n\n是否应用？`);
  if (!approved) return;

  const projectCheck = preview.document.projectModel
    ? validateProjectModel(preview.document.projectModel)
    : { valid: true, errors: [] as string[] };
  if (!projectCheck.valid) {
    workspaceImportStatus.value = { type: 'error', text: `控制结构校验失败：${projectCheck.errors.join('；')}` };
    return;
  }
  // Validate the migrated dashboard without mutating the live store. The
  // import operation below is transactional: protocol/application state is
  // changed only after every synchronous structure check has passed, and a
  // later runtime failure restores all snapshots before reporting the error.
  const dashboardResult = validateAndMigrateDashboard(preview.document.dashboard);
  if (!dashboardResult.ok || !dashboardResult.data) {
    workspaceImportStatus.value = { type: 'error', text: `画布导入失败：${dashboardResult.error || '格式无效'}` };
    return;
  }
  const document = preview.document;
  const previousAppConfig = JSON.parse(JSON.stringify(appConfig.value)) as AppConfig;
  const previousDashboard = widgetStore.exportDashboardJson();
  const previousProjectModel = globalProjectModel.getModel();
  const previousPort = selectedPort.value;
  const previousBaud = selectedBaud.value;
  const previousMode = mode.value;
  const previousProtocol = JSON.parse(JSON.stringify(appConfig.value.protocol_config)) as ProtocolConfig;

  const transaction = await runWorkspaceTransaction(
    { appConfig: previousAppConfig, dashboard: previousDashboard, projectModel: previousProjectModel, port: previousPort, baud: previousBaud, mode: previousMode, protocol: previousProtocol },
    async () => {
      // Configure the transport first. If the driver rejects the protocol, no
      // visible workspace state has changed yet.
      await session.configureProtocol(document.connection.protocolConfig);

      const importedDashboard = widgetStore.importDashboardJson(JSON.stringify(dashboardResult.data));
      if (!importedDashboard.ok) throw new Error(`画布导入失败：${importedDashboard.error || '格式无效'}`);

      if (document.projectModel && !globalProjectModel.setModel(document.projectModel as any)) {
        throw new Error('控制结构校验失败：导入模型未能应用。');
      }

      appConfig.value = {
        ...appConfig.value,
        port_name: document.connection.portName,
        baud_rate: document.connection.baudRate,
        mode: document.connection.mode,
        serial_settings: { ...document.connection.serialSettings },
        protocol_config: document.connection.protocolConfig,
        channel_mapping: { ...document.channelMapping },
        quick_commands: document.commands.map((command) => ({
          id: command.id,
          name: command.name,
          command: command.command,
          is_hex: command.isHex,
          danger: command.danger,
        })),
        // Imported stop commands remain drafts; a user must bind one explicitly.
        emergency_command: null,
        ai_config: {
          ...appConfig.value.ai_config,
          provider: document.ai.provider,
          api_url: document.ai.apiUrl,
          model: document.ai.model,
          api_key: '',
          api_key_configured: appConfig.value.ai_config.api_key_configured,
        },
      };
      selectedPort.value = document.connection.portName || '';
      selectedBaud.value = String(document.connection.baudRate);
      mode.value = document.connection.mode;
      debouncedSaveConfig();
    },
    async (snapshot) => {
      const restoreErrors: string[] = [];
      appConfig.value = snapshot.appConfig;
      selectedPort.value = snapshot.port;
      selectedBaud.value = snapshot.baud;
      mode.value = snapshot.mode;
      try {
        await session.configureProtocol(snapshot.protocol);
      } catch (error) {
        restoreErrors.push(`协议：${error instanceof Error ? error.message : String(error)}`);
      }
      const restoredDashboard = widgetStore.importDashboardJson(snapshot.dashboard);
      if (!restoredDashboard.ok) restoreErrors.push(`画布：${restoredDashboard.error || '未知错误'}`);
      if (!globalProjectModel.setModel(snapshot.projectModel)) restoreErrors.push('控制结构：模型校验失败。');
      if (restoreErrors.length > 0) throw new Error(`工作区回滚失败（${restoreErrors.join('；')}）`);
    },
  );
  if (!transaction.ok) {
    const reason = transaction.error instanceof Error ? transaction.error.message : String(transaction.error);
    const rollback = transaction.rollbackError instanceof Error ? ` 回滚也失败：${transaction.rollbackError.message}` : '';
    workspaceImportStatus.value = { type: 'error', text: `工作区未应用，已恢复当前配置：${reason}${rollback}` };
    appendLog('error', '[WORKSPACE]', `工作区应用失败并已回滚：${reason}${rollback}`);
    return;
  }
  workspaceImportStatus.value = {
    type: 'success',
    text: `已应用版本化工作区；${document.commands.length} 条命令保持草稿，未导入 API Key、记录数据或自动写入授权。`,
  };
  appendLog('info', '[WORKSPACE]', '版本化工作区已应用；需要用户复核的发送命令和急停绑定保持关闭。');
}

watch([selectedPort, selectedBaud, mode, () => JSON.stringify(appConfig.value.serial_settings)], () => {
  debouncedSaveConfig();
});

// 定时拉取后端状态
async function checkStatus() {
  try {
    const status = await session.getPipelineStatus();
    isRunning.value = status.is_running;
    isAcquiring.value = status.is_acquiring ?? status.is_running;
    mode.value = status.mode;
    sampleRate.value = status.sample_rate;
    totalSamples.value = status.total_samples;
    if (session.transport.value?.kind === 'tauri' && status.rx_bytes !== undefined) {
      totalRxBytes.value = status.rx_bytes;
    }
    pipelineErrorCount.value = status.error_count ?? session.protocolErrors.value;
    pipelineDroppedBytes.value = status.protocol_dropped_bytes ?? session.droppedBytes.value;
    if (session.isNativeHost || session.supportsRecording.value) {
      const recording = await session.getRecordingStatus();
      if (recording) {
        const previousRecordingError = recordingStatus.value.error;
        recordingStatus.value = recording;
        if (recording.error && recording.error !== previousRecordingError) {
          appendLog('error', '[RECORD]', `原始记录状态异常: ${recording.error}`);
        }
      }
      await session.refreshWriteLockStatus();
    }

    if (status.is_running) {
      connectionState.value = 'connected';
    } else if (connectionState.value === 'connected') {
      connectionState.value = 'disconnected';
    }
  } catch (e) {
    // 降级处理
  }
}

async function handleResumeWrites() {
  try {
    await session.resumeWrites();
    appendLog('warn', '[SOFTWARE STOP]', '用户已显式解除软件发送屏障；普通发送现已恢复。');
  } catch (error: any) {
    appendLog('error', '[SOFTWARE STOP]', `无法恢复普通发送: ${error?.message || error}`);
  }
}

async function handleToggleRecording() {
  if (recordingBusy.value) return;
  recordingBusy.value = true;
  try {
    recordingStatus.value = recordingStatus.value.isRecording
      ? await session.stopRecording()
      : await session.startRecording();
    appendLog('info', '[RECORD]', recordingStatus.value.isRecording
      ? `已开始原始 RX 记录: ${recordingStatus.value.directory || '会话目录准备中'}`
      : `原始 RX 记录已停止，共 ${recordingStatus.value.rxBytes.toLocaleString()} 字节。`);
  } catch (error: any) {
    const message = typeof error === 'string' ? error : error?.message || '记录操作失败';
    recordingStatus.value = { ...recordingStatus.value, error: message };
    appendLog('error', '[RECORD]', message);
  } finally {
    recordingBusy.value = false;
  }
}

async function loadRecordingLibrary() {
  if (recordingLibraryLoading.value) return;
  recordingLibraryLoading.value = true;
  recordingLibraryError.value = null;
  try {
    recordingSummaries.value = await session.listRecordings();
  } catch (error) {
    recordingLibraryError.value = error instanceof Error ? error.message : String(error);
  } finally {
    recordingLibraryLoading.value = false;
  }
}

async function handleOpenRecordingLibrary() {
  recordingLibraryOpen.value = true;
  await loadRecordingLibrary();
}

async function handleStartRecordingReplay(item: RecordingSummary) {
  await recordingReplayController.open(item);
}

function handleCloseRecordingReplay() {
  recordingReplayController.close();
}

async function loadRecordingReplayPage(afterRxSequence?: number) {
  await recordingReplayController.load(afterRxSequence);
}

function handleExportRecordingReplay() {
  const item = recordingReplaySession.value;
  if (!item || recordingReplaySamples.value.length === 0 || !item.manifest.protocolConfig) return;
  const csv = formatRecordingSamplesCsv(recordingReplaySamples.value, {
    sessionId: item.manifest.sessionId,
    epoch: item.manifest.epoch,
    protocol: item.manifest.protocolConfig.type,
    timeSource: item.manifest.timeSource,
  });
  const blob = new Blob([new TextEncoder().encode(`\uFEFF${csv}`)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `recording-${item.manifest.sessionId}-samples.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  appendLog('info', '[RECORD]', `已导出 ${recordingReplaySamples.value.length.toLocaleString()} 个离线解析样本；时间来源为${item.manifest.timeSource}`);
}

function handleExportRecordingRaw() {
  const item = recordingReplaySession.value;
  if (!item || recordingReplayChunks.value.length === 0) return;
  const csv = formatRecordingRawChunksCsv(recordingReplayChunks.value, {
    sessionId: item.manifest.sessionId,
    epoch: item.manifest.epoch,
  });
  const blob = new Blob([new TextEncoder().encode(`\uFEFF${csv}`)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `recording-${item.manifest.sessionId}-raw-chunks.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  appendLog('info', '[RECORD]', `已导出 ${recordingReplayChunks.value.length.toLocaleString()} 个原始 RX 分块；如需完整会话请先读取到记录末尾`);
}

// 连接与断开控制
async function handleToggleConnect() {
  if (isRunning.value) {
    try {
      const status = await session.stopPipeline();
      isRunning.value = status.is_running;
      isAcquiring.value = status.is_acquiring ?? false;
      connectionState.value = 'disconnected';
      activeChannels.value = [];
      appendLog('info', '[DISCONNECT]', '串口连接已关闭，数据采集已停止。');
    } catch (err) {
      console.error('Failed to stop pipeline:', err);
      appendLog('error', '[ERROR]', `关闭串口失败: ${err}`);
    }
  } else {
    if (!selectedPort.value || selectedPort.value === 'VIRTUAL_COM' || selectedPort.value === 'mock') {
      appendLog('error', '[ERROR]', '未选择物理串口。请先插入设备并点击“刷新”按钮选择可用端口 (如 COM3)。');
      triggerDisconnectAlert('请先选择有效物理串口端口');
      return;
    }
    connectionState.value = 'connecting';
    // Start the next live view with empty display buffers so samples from the prior
    // connection cannot share a time axis or be mistaken for current telemetry.
    globalChannelStore.clear();
    totalSamples.value = 0;
    sampleRate.value = 0;
    activeChannels.value = [];
    activeSnapshot.value = null;
    activeAnomaly.value = null;
    const byteCountsAvailable = ['webserial', 'tauri'].includes(session.transport.value?.kind ?? '');
    totalRxBytes.value = byteCountsAvailable ? 0 : null;
    totalTxBytes.value = byteCountsAvailable ? 0 : null;
    pipelineDroppedBytes.value = 0;
    try {
      const status = await session.startPipeline({
        mode: 'serial',
        port: selectedPort.value,
        baudRate: parseInt(selectedBaud.value, 10) || 115200,
        serialSettings: appConfig.value.serial_settings,
      });
      isRunning.value = status.is_running;
      isAcquiring.value = status.is_acquiring ?? status.is_running;
      if (session.transport.value?.kind === 'tauri' && status.rx_bytes !== undefined) {
        totalRxBytes.value = status.rx_bytes;
      }
      connectionState.value = 'connected';
      appendLog(
        'info',
        '[CONNECT]',
        `物理串口 [${selectedPort.value}] 成功打开 (波特率: ${selectedBaud.value})`
      );
    } catch (err: any) {
      console.error('Failed to start pipeline:', err);
      connectionState.value = 'error';
      isRunning.value = false;
      totalRxBytes.value = null;
      totalTxBytes.value = null;
      const errorMsg = typeof err === 'string' ? err : err?.message || '连接失败';
      appendLog('error', '[ERROR]', `打开串口失败: ${errorMsg}`);
      triggerDisconnectAlert(`打开串口失败: ${errorMsg}`);
    }
  }
}

async function handleToggleAcquisition() {
  if (!isRunning.value) return;
  const next = !isAcquiring.value;
  try {
    const applied = await session.setAcquisitionEnabled(next);
    isAcquiring.value = applied;
    appendLog('info', '[FLOW]', applied
      ? '串口采集已恢复；显示和记录状态保持不变。'
      : '串口采集已暂停；连接保持打开，显示缓冲和已启用记录不会被清除。');
  } catch (error) {
    appendLog('error', '[FLOW]', `采集状态切换失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleStartDemo() {
  if (demoBusy.value || isRunning.value) return;
  demoBusy.value = true;
  connectionState.value = 'connecting';
  globalChannelStore.clear();
  totalSamples.value = 0;
  sampleRate.value = 0;
  activeChannels.value = [];
  activeSnapshot.value = null;
  activeAnomaly.value = null;
  const byteCountsAvailable = ['webserial', 'tauri'].includes(session.transport.value?.kind ?? '');
  totalRxBytes.value = byteCountsAvailable ? 0 : null;
  totalTxBytes.value = byteCountsAvailable ? 0 : null;
  pipelineDroppedBytes.value = 0;
  try {
    const status = await session.startPipeline({
      mode: 'mock',
      baudRate: parseInt(selectedBaud.value, 10) || 115200,
      serialSettings: appConfig.value.serial_settings,
    });
    mode.value = 'mock';
    if (session.transport.value?.kind === 'tauri' && status.rx_bytes !== undefined) {
      totalRxBytes.value = status.rx_bytes;
    }
    isRunning.value = status.is_running;
    isAcquiring.value = status.is_acquiring ?? status.is_running;
    connectionState.value = status.is_running ? 'connected' : 'error';
    appendLog('info', '[DEMO]', '隔离演示数据源已启动；不会打开或写入物理串口。');
  } catch (error: any) {
    connectionState.value = 'error';
    appendLog('error', '[DEMO]', `演示数据源启动失败: ${error?.message || error}`);
  } finally {
    demoBusy.value = false;
  }
}

async function handleReset() {
  try {
    await session.reset();
    totalSamples.value = 0;
    activeChannels.value = [];
    const byteCountsAvailable = ['webserial', 'tauri'].includes(session.transport.value?.kind ?? '');
    totalRxBytes.value = byteCountsAvailable ? 0 : null;
    totalTxBytes.value = byteCountsAvailable ? 0 : null;
    pipelineDroppedBytes.value = 0;
    appendLog('info', '[RESET]', '数据缓冲与波形已清空重置。');
  } catch (err) {
    console.error('Failed to reset pipeline:', err);
    appendLog('error', '[ERROR]', `重置失败: ${err}`);
  }
}

function handlePortChange(newPort: string) {
  selectedPort.value = newPort;
}

function handleBaudChange(newBaud: string) {
  selectedBaud.value = newBaud;
}

function handleSerialSettingsChange(settings: SerialSettings) {
  appConfig.value.serial_settings = settings;
}

async function handleOpenLogDir() {
  try {
    const dir = await session.openLogDir();
    appendLog('info', '[SYSTEM]', `已在资源管理器中打开日志目录: ${dir}`);
  } catch (err) {
    appendLog('error', '[ERROR]', `打开日志目录失败: ${err}`);
  }
}

// ADR 0004 全局急停空格键拦截处理
function handleKeyDown(event: KeyboardEvent) {
  // The channel dialog owns its focus, Escape and Tab keys. Let its document
  // capture handler run before any workbench-wide drawer shortcut consumes them.
  if (event.target instanceof Element && event.target.closest('[data-channel-config-dialog]')) return;
  // 快捷键 Ctrl + ~ 切换终端日志抽屉
  if ((event.ctrlKey || event.metaKey) && (event.key === '`' || event.key === '~')) {
    event.preventDefault();
    isTerminalDrawerOpen.value = !isTerminalDrawerOpen.value;
    return;
  }

  // Esc 键收起抽屉
  if (event.key === 'Escape') {
    const dismiss = (close: () => void) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    if (showHelpModal.value) {
      dismiss(() => { showHelpModal.value = false; });
      return;
    }
    if (recordingLibraryOpen.value) {
      dismiss(() => { recordingLibraryOpen.value = false; });
      return;
    }
    if (activeDockDrawer.value) {
      dismiss(() => { activeDockDrawer.value = null; });
      return;
    }
    if (analysisOpen.value) { dismiss(() => { analysisOpen.value = false; }); return; }
    if (isCopilotDrawerOpen.value) { dismiss(() => { isCopilotDrawerOpen.value = false; }); return; }
    if (isTerminalDrawerOpen.value) {
      dismiss(() => { isTerminalDrawerOpen.value = false; });
      return;
    }
  }

  // 空格键急停检查
  if (event.code !== 'Space' && event.key !== ' ') {
    return;
  }
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const path = (event.composedPath ? event.composedPath() : [event.target]) as EventTarget[];
  const isInteractive = path.some((el) => {
    if (!el || !(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      el.isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.closest?.('input, textarea, select, button, a[href], [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="slider"], [role="radio"], [contenteditable="true"]') !== null
    );
  });
  if (isInteractive) {
    return;
  }

  event.preventDefault();
  triggerEmergencyStop();
}

// ADR 0004 急停发送状态机
function reportSoftwareStopFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  emergencyToastTitle.value = '软件停止未完成 · 驱动屏障未确认';
  emergencyToastDesc.value = `${session.softwareStopLocked.value ? '本机新增发送已锁定。' : '本机发送锁定尚未确认。'}驱动停止操作失败：${detail}。此前进入驱动的命令可能继续写入，设备停机需另外确认。`;
  emergencyToastLevel.value = 'error';
  showEmergencyToast.value = true;
  appendLog('error', '[SOFTWARE STOP]', emergencyToastDesc.value);
  resetEmergencyTimer();
}

async function triggerEmergencyStop() {
  if (!isTuningBusy.value) ordinaryWriteRevision.value += 1;
  tuningStopToken.value += 1;
  const cmd = appConfig.value.emergency_command?.trim();

  if (!cmd) {
    try {
      await session.emergencyStop();
    } catch (error) {
      reportSoftwareStopFailure(error);
      return;
    }
    emergencyToastTitle.value = '软件停止已启用';
    emergencyToastDesc.value = '软件已锁定普通发送并取消待发命令；未发送设备停止字节。请确认设备状态后再显式恢复发送。';
    emergencyToastLevel.value = 'warn';
    showEmergencyToast.value = true;
    appendLog('warn', '[SOFTWARE STOP]', '已锁定普通发送并清理待发队列；未发出设备停止字节。');
    resetEmergencyTimer();
    return;
  }

  if (!isRunning.value) {
    try {
      await session.emergencyStop();
    } catch (error) {
      reportSoftwareStopFailure(error);
      return;
    }
    emergencyToastTitle.value = '软件停止已启用，设备命令未送达';
    emergencyToastDesc.value = `普通发送已锁定；端口未打开，设备停止字节 [${cmd}] 未发送。`;
    emergencyToastLevel.value = 'error';
    showEmergencyToast.value = true;
    appendLog('error', '[EMERGENCY]', `全局空格键触发：串口未打开，急停指令未送达: ${cmd} (ADR 0004)。`);
    resetEmergencyTimer();
    return;
  }

  try {
    await session.emergencyStop(cmd);
    emergencyToastTitle.value = '停止字节已提交，驱动写入待回执';
    emergencyToastDesc.value = `文本停止命令 [${cmd}] 已提交到本地串口发送线程；驱动写入结果尚待回执，且不代表设备已收到或已停止。普通发送仍保持锁定。`;
    emergencyToastLevel.value = 'warn';
    showEmergencyToast.value = true;
    appendLog('warn', '[EMERGENCY]', `全局空格键触发：停止字节已提交到本地发送线程，驱动写入待回执：${cmd}。`);
    resetEmergencyTimer();
  } catch (err: any) {
    emergencyToastTitle.value = '急停发送失败 (ADR 0004)';
    emergencyToastDesc.value = `下发急停指令失败: ${err?.message || err}`;
    emergencyToastLevel.value = 'error';
    showEmergencyToast.value = true;
    appendLog('error', '[EMERGENCY]', `下发急停指令失败: ${err?.message || err}`);
    resetEmergencyTimer();
  }
}

function handleTuningSafetyStop(reason: string) {
  appendLog('error', '[TUNING SAFETY]', reason);
  void triggerEmergencyStop();
}

function resetEmergencyTimer() {
  if (emergencyTimer) clearTimeout(emergencyTimer);
  emergencyTimer = window.setTimeout(() => {
    showEmergencyToast.value = false;
  }, 4000);
}

function bindEmergencyCommand(cmd: string) {
  appConfig.value.emergency_command = cmd;
  debouncedSaveConfig();
  showEmergencyToast.value = false;
  appendLog('info', '[CONFIG]', `急停槽位已成功绑定指令: ${cmd}`);
}

function configureEmergencyCommand() {
  const current = appConfig.value.emergency_command || '';
  const command = window.prompt(
    '设置文本停止命令。该命令会在软件停止屏障锁定后排队发送；不会得到设备执行确认。\n\n常见文本转义：\\r、\\n、\\t。留空可移除命令。',
    current,
  );
  if (command === null) return;
  if (!command.trim()) {
    appConfig.value.emergency_command = null;
    debouncedSaveConfig();
    appendLog('info', '[CONFIG]', '已移除停止命令；软件停止仍会锁定普通发送并清理待发队列。');
    return;
  }
  bindEmergencyCommand(command);
}

function triggerDisconnectAlert(msg: string) {
  disconnectAlertMsg.value = msg;
  showDisconnectAlert.value = true;
  if (disconnectTimer) clearTimeout(disconnectTimer);
  disconnectTimer = window.setTimeout(() => {
    showDisconnectAlert.value = false;
  }, 5000);
}

// 终端数据发送
async function handleSendSerialData(data: string, isHex: boolean, appendNewline: boolean, escapeText = true, lineEnding: 'none' | 'lf' | 'cr' | 'crlf' = 'crlf'): Promise<void> {
  if (isTuningBusy.value) {
    const message = '范围内自动调参正在控制参数写入；普通发送已暂停。请先停止实验。';
    appendLog('warn', '[TX_BLOCKED]', message);
    throw new Error(message);
  }
  try {
    ordinaryWriteRevision.value += 1;
    const result = await session.sendSerialData(data, isHex, appendNewline, escapeText, lineEnding);
    reportWriteReceipt(result, result.status === 'queued' ? '[TX_QUEUED]' : '[TX_WRITTEN]', `${isHex ? '(HEX) ' : ''}${data}`);
  } catch (err: any) {
    appendLog('error', '[TX_ERR]', `发送失败: ${err?.message || err}`);
    throw err;
  }
}

async function handleTuningSend(request: { trialId: string; command: string; payload: TuningCommandPayload }) {
  tuningWriteResult.value = null;
  try {
    if (!isRunning.value) throw new Error('串口未连接，参数命令没有发送。');
    if (!isAcquiring.value) throw new Error('采集已暂停，不能监测本轮实验，参数命令没有发送。');
    if (isApplyingProtocol.value) throw new Error('协议正在切换，参数命令没有发送。');
    if (mode.value === 'mock') throw new Error('当前为演示数据源，无法验证设备控制，参数命令没有发送。');
    if (!appConfig.value.emergency_command?.trim()) throw new Error('请先配置设备停止命令，再授权参数实验。');
    if (session.softwareStopLocked.value) throw new Error('软件停止已锁定发送，参数命令没有发送。');
    if (!isTuningBusy.value || !tuningWriteAccessReady.value) throw new Error('本轮实验未取得独占写入权限，参数命令没有发送。');
    // The reviewed payload owns escaping and line endings. Write these exact
    // bytes through the shared barrier without a second text transformation.
    const bytes = tuningCommandBytes(request.payload, request.command);
    const result = await session.write(bytes);
    reportWriteReceipt(result, result.status === 'queued' ? '[TX:TUNING_QUEUED]' : '[TX:TUNING_WRITTEN]', request.payload.visibleText);
    const completed = result.status === 'queued'
      ? await waitForWriteResult(result.request_id, 3000)
      : null;
    const status = completed
      ? completed.status === 'written' ? 'written' : 'failed'
      : result.status;
    tuningWriteResult.value = {
      id: request.trialId,
      requestId: result.request_id,
      sessionId: result.session_id,
      epoch: result.epoch,
      status,
      at: Date.now(),
      error: completed && completed.status !== 'written'
        ? completed.reason || `参数写入状态为 ${completed.status}`
        : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog('error', '[TX:TUNING_ERR]', `参数命令发送失败: ${message}`);
    tuningWriteResult.value = { id: request.trialId, status: 'failed', at: Date.now(), error: message };
  }
}

async function handleTuningExecutionState(working: boolean) {
  isTuningBusy.value = working;
  if (working) {
    tuningWriteAccessReady.value = false;
    await globalSendGate.acquireExperimentLock();
    if (!isTuningBusy.value) return;
    const drained = await session.waitForWriteQuiescence(5000);
    if (!isTuningBusy.value) return;
    if (!drained.ready) {
      appendLog('error', '[TUNING QUEUE]', drained.reason || '普通命令的驱动写入状态尚未明确，实验不会取得写入权。');
      tuningStopToken.value += 1;
      return;
    }
    tuningWriteAccessReady.value = true;
    return;
  }
  globalSendGate.releaseExperimentLock();
  tuningWriteAccessReady.value = true;
}

function openSceneAssistant() {
  analysisOpen.value = false;
  assistantTab.value = 'tuning';
  tuningVisited.value = true;
  isCopilotDrawerOpen.value = true;
}

function selectAssistantTab(tab: 'tuning' | 'debug') {
  if (isTuningBusy.value) return;
  assistantTab.value = tab;
  if (tab === 'tuning') tuningVisited.value = true;
}

function openAssistantSettings() {
  if (isTuningBusy.value) return;
  assistantTab.value = 'debug';
  isCopilotDrawerOpen.value = true;
  copilotVisited.value = true;
  if (copilotDrawerRef.value) copilotDrawerRef.value.openSettings();
  else pendingAssistantSettings.value = true;
}

function handleClearLogs() {
  logs.value = [];
}

// 快捷指令发送
async function handleSendQuickCommand(cmd: QuickCmd) {
  if (cmd.danger) {
    triggerEmergencyStop();
    return;
  }
  if (isTuningBusy.value) {
    appendLog('warn', '[TX_BLOCKED]', '范围内自动调参正在控制参数写入；普通快捷命令已暂停。');
    return;
  }
  try {
    ordinaryWriteRevision.value += 1;
    const result = await session.sendSerialData(cmd.command, cmd.is_hex, true);
    reportWriteReceipt(result, result.status === 'queued' ? '[TX:CMD_QUEUED]' : '[TX:CMD_WRITTEN]', `${cmd.name}: ${cmd.command}`);
  } catch (err: any) {
    appendLog('error', '[TX:CMD_ERR]', `${cmd.name} 发送失败: ${err?.message || err}`);
  }
}

function handleUpdateAiConfig(cfg: AiConfig) {
  appConfig.value.ai_config = cfg;
  debouncedSaveConfig();
}

async function saveAssistantConfig(config: AiConfig, clearStoredKey = false): Promise<AiConfig> {
  if (configPersistenceBlocked.value) throw new Error('工作区保存已暂停，请先处理配置读取或保存错误');
  if (saveConfigTimer) { clearTimeout(saveConfigTimer); saveConfigTimer = null; }
  const previous = appConfig.value.ai_config;
  const sameService = config.provider === previous.provider && config.api_url === previous.api_url;
  const next = { ...config, api_key: config.api_key || (sameService && config.api_key_configured ? previous.api_key : ''),
    api_key_configured: Boolean(config.api_key) || (sameService && Boolean(config.api_key_configured)) };
  if (!clearStoredKey && aiServiceNeedsKey(next) && !next.api_key && !next.api_key_configured) throw new Error('此服务需要密钥。切换服务或地址时请重新填写，避免把旧密钥发给另一服务。');
  await session.saveAppConfig({ ...appConfig.value, ai_config: next });
  const effective = isTauri() ? { ...next, api_key: '' } : { ...next, api_key_configured: false };
  appConfig.value.ai_config = effective;
  aiConfigRevision.value++;
  return effective;
}

async function applyAssistantAction(action: AssistantAction): Promise<string> {
  if (isTuningBusy.value) throw new Error('请先停止参数实验再应用建议');
  if (action.type === 'command_draft') {
    terminalStripRef.value?.fillCommandDraft(action);
    if (!terminalStripRef.value) throw new Error('请先返回串口工作台');
    return '已填入发送草稿，请在终端核对字节和换行后自行发送。';
  }
  if (action.type === 'protocol') {
    const success = await handleProtocolChange(action.config);
    if (!success) throw new Error('协议未应用，请检查连接面板或终端错误');
    return '协议已应用。';
  }
  if (!action.channels.every(id => activeChannels.value.includes(id))) throw new Error('绑定通道已变化，请重新分析');
  if (widgetStore.activeWidgets.value.length >= 64) throw new Error('当前画布已达到 64 个控件，请先整理布局');
  const config = action.widget === 'chart'
    ? { auto_bind: false, series: action.channels.map((channel, i) => ({ channel, color: DEFAULT_CHANNEL_PALETTE[i], visible: true })) }
    : { channel: action.channels[0], unit: action.unit, precision: 2 };
  const widget = createNewWidget(action.widget, 20, 20 + widgetStore.activeWidgets.value.reduce((max, w) => Math.max(max, w.y + w.h), 0), action.title, config);
  widgetStore.addWidget(widget);
  appendLog('info', '[ASSISTANT]', `已添加显示控件：${action.title}；可在编辑布局中删除或调整。`);
  return '已添加显示控件，可在编辑布局中调整或删除。';
}

function openAnalysis() {
  if (isTuningBusy.value) return;
  analysisVisited.value = true;
  analysisOpen.value = true;
  isCopilotDrawerOpen.value = false;
}

function handleWakeCopilotAnomaly(anomaly: FirmwareAnomaly) {
  if (isTuningBusy.value) return;
  assistantTab.value = 'debug';
  analysisOpen.value = false;
  isCopilotDrawerOpen.value = true;
  const prompt = `请分析异常 [${anomaly.type}]，说明证据、不确定性和可验证的排查步骤。`;
  if (copilotDrawerRef.value) copilotDrawerRef.value.prefill(prompt, anomaly.message);
  else pendingCopilotPrompt.value = { prompt, log: anomaly.message };
}

function handleWakeCopilot(anomaly?: FirmwareAnomaly) {
  if (isTuningBusy.value) return;
  assistantTab.value = 'debug';
  analysisOpen.value = false;
  isCopilotDrawerOpen.value = true;
  if (anomaly) {
    handleWakeCopilotAnomaly(anomaly);
  }
}

function handleToggleTerminal() {
  isTerminalDrawerOpen.value = !isTerminalDrawerOpen.value;
}

function handleFillSendArea(command: string) {
  terminalStripRef.value?.fillSendInput(command);
  appendLog('info', '[COPILOT]', `已将 Copilot 建议指令填入发送区: ${command.trim()}`);
}

function handleSaveQuickCommand(cmd: { name: string; command: string }) {
  const newCmd: QuickCmd = {
    id: `cmd_copilot_${Date.now()}`,
    name: cmd.name,
    command: cmd.command,
    is_hex: false,
  };
  appConfig.value.quick_commands.push(newCmd);
  debouncedSaveConfig();
  appendLog('info', '[COPILOT]', `已将建议指令暂存为快捷指令: [${cmd.name}] -> ${cmd.command.trim()}`);
}

function handleUpdateCommands(list: QuickCmd[]) {
  appConfig.value.quick_commands = list;
  debouncedSaveConfig();
}

async function applySerialSignals(signals: { dtr?: boolean; rts?: boolean; brk?: boolean }, label: string): Promise<boolean> {
  const transport = session.transport.value;
  if (!isRunning.value || !transport?.setSignals || transport.supportsSignals === false) {
    appendLog('warn', '[SERIAL]', `${label}不可用：当前连接驱动未提供串口信号控制`);
    return false;
  }
  // A Break release must remain possible even when an experiment has started.
  // Other signal changes may reset the board and cannot share its control scope.
  if (isTuningBusy.value && signals.brk !== false) {
    appendLog('warn', '[SERIAL]', '先停止参数实验并核对设备，再修改 DTR、RTS 或开始 Break。');
    return false;
  }
  if (isTuningBusy.value) tuningStopToken.value += 1;
  ordinaryWriteRevision.value += 1;
  pendingSignalChanges.value += 1;

  try {
    await transport.setSignals(signals);
    appendLog('info', '[SERIAL]', `${label}已提交到当前串口驱动`);
    return true;
  } catch (error) {
    appendLog('error', '[SERIAL]', `${label}设置失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    pendingSignalChanges.value -= 1;
  }
}

async function handleSetDtr(enabled: boolean) {
  if (await applySerialSignals({ dtr: enabled }, `DTR 置为${enabled ? '有效' : '无效'}`)) {
    dtrState.value = enabled;
  }
}

async function handleSetRts(enabled: boolean) {
  if (await applySerialSignals({ rts: enabled }, `RTS 置为${enabled ? '有效' : '无效'}`)) {
    rtsState.value = enabled;
  }
}

async function handleSetBreak(enabled: boolean) {
  await applySerialSignals({ brk: enabled }, `Break ${enabled ? '开始' : '结束'}`);
}

function handleAutoScaleCharts() {
  widgetStore.triggerAutoScale();
  appendLog('info', '[CHART]', '已触发波形图全量 Y 轴与时基自动缩放');
}

function handleScrubHistory(ratio: number) {
  isStreamPaused.value = ratio < 0.99;
  widgetStore.setScrubState(ratio < 0.999, ratio);
}

function handleResumeLive() {
  isStreamPaused.value = false;
  widgetStore.setScrubState(false, 1.0);
}

// 单行报错 AI 诊断
async function handleDiagnoseLog(log: LogLine) {
  if (isTuningBusy.value) return;
  handleWakeCopilot();
  const prompt = `请解释这条日志，区分已知证据和推测，并列出可验证的排查步骤。`;
  // The panel is lazy loaded. Wait for its ref before pre-filling, without issuing a model request.
  if (copilotDrawerRef.value) copilotDrawerRef.value.prefill(prompt, log.text);
  else pendingCopilotPrompt.value = { prompt, log: log.text };
}


// 流控与缓冲控制
function handleToggleStreamPause() {
  isStreamPaused.value = !isStreamPaused.value;
  globalRenderScheduler.setPaused(isStreamPaused.value);
  if (isStreamPaused.value) {
    appendLog('warn', '[FLOW]', '所有图表绘制已暂停；串口采集与已启用的磁盘记录继续运行');
  } else {
    appendLog('info', '[FLOW]', '所有图表绘制已恢复，显示窗口继续实时跟随或保留浏览位置');
  }
}

function handleClearBuffer() {
  globalChannelStore.clear();
  handleReset();
}

async function handleProtocolChange(protocol: ProtocolConfig) {
  if (isApplyingProtocol.value) return false;
  if (isTuningBusy.value) {
    appendLog('error', '[PROTOCOL]', '当前参数实验尚未结束。先停止调参流程并核对设备状态，再切换解析协议。');
    return false;
  }
  isApplyingProtocol.value = true;
  try {
    await session.configureProtocol(protocol);
    appConfig.value.protocol_config = protocol;
    globalChannelStore.clear();
    totalSamples.value = 0;
    sampleRate.value = 0;
    activeChannels.value = [];
    debouncedSaveConfig();
    appendLog('info', '[PROTOCOL]', `协议已应用: ${protocol.type.toUpperCase()}；解析残留和实时曲线已清空`);
    activeDockDrawer.value = null;
    return true;
  } catch (err: any) {
    appendLog('error', '[PROTOCOL]', `协议应用失败，当前配置保持不变: ${err?.message || err}`);
    return false;
  } finally {
    isApplyingProtocol.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleKeyDown, true);

  await loadConfig();
  await refreshPorts();

  // 监听统一串口状态变更
  unsubStatus = session.onStatusChange((status) => {
    if (status === 'connected') {
      connectionState.value = 'connected';
      isRunning.value = true;
    } else if (status === 'connecting') {
      connectionState.value = 'connecting';
    } else if (status === 'disconnecting') {
      connectionState.value = 'disconnected';
    } else if (status === 'reconnecting') {
      connectionState.value = 'reconnecting';
      appendLog('info', '[SERIAL]', '检测到串口已重新插入，可点击重新连接。');
      triggerDisconnectAlert('串口已重新插入，可点击重新连接');
    } else if (status === 'device-lost') {
      connectionState.value = 'error';
      isRunning.value = false;
      appendLog('warn', '[SERIAL]', '串口设备异常拔出断开');
      triggerDisconnectAlert('串口设备已被拔出');
    } else if (status === 'error') {
      connectionState.value = 'error';
      isRunning.value = false;
    } else {
      connectionState.value = 'disconnected';
      isRunning.value = false;
    }
  });

  unsubError = session.onError((err) => {
    appendLog('warn', '[SERIAL]', `串口传输异常 [${err.code}]: ${err.message}`);
    triggerDisconnectAlert(`串口异常: ${err.message}`);
  });

  unsubWriteResult = session.onWriteResult(rememberWriteResult);

  unsubLogsBatch = session.onLogsBatch((lines) => {
    if (!lines || !Array.isArray(lines)) return;
    for (const line of lines) {
      const level = (line.level?.toLowerCase() || 'info') as 'info' | 'warn' | 'error';
      const tag = `[${line.direction || 'RX'}]`;
      const text = line.raw_hex && line.text.startsWith('RawData RX:')
        ? `${line.text} · ${line.raw_hex}`
        : line.text;
      appendLog(level, tag, text);
    }
  });

  // Count actual raw byte chunks. Web Serial reports them directly; the desktop
  // pipeline reports the same counter through PipelineStatus. Parsed logs and
  // plotted samples are never used as a byte-count substitute.
  if (session.transport.value?.kind === 'webserial') {
    unsubRawData = session.transport.value.onRawData?.((chunk) => {
      if (totalRxBytes.value !== null) totalRxBytes.value += chunk.byteLength;
      const config = appConfig.value.protocol_config;
      if (config.type === 'rawdata' && config.mode === 'display') {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - lastRawPreviewAt >= 100) {
          lastRawPreviewAt = now;
          const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
          appendLog('info', '[RX HEX PREVIEW]', `${chunk.byteLength} 字节（节流预览）: ${hex}`);
        }
      }
    }) ?? null;
  }

  unsubChannelCapacity = globalChannelStore.onCapacityExceeded((channelId) => {
    appendLog('error', '[BUFFER_LIMIT]', `活动通道已达 64 个上限；新通道“${channelId}”没有写入显示缓冲。已启用的原始记录不受显示缓冲上限影响。`);
  });

  unsubStepSnapshot = session.onStepSnapshot((snapshot) => {
    if (!activeSnapshot.value) {
      activeSnapshot.value = snapshot;
    }
  });

  let pollCycle = 0;
  checkStatus();
  statusInterval = window.setInterval(async () => {
    await checkStatus();
    if (!isRunning.value && mode.value === 'serial') {
      pollCycle++;
      if (pollCycle >= 4) {
        pollCycle = 0;
        await refreshPorts(true);
      }
    }
  }, 500);

  globalSendGate.setSender(async (payload, isHex, appendNewline) => {
    if (isTuningBusy.value) throw new Error('自动调参期间普通串口发送已暂停。');
    ordinaryWriteRevision.value += 1;
    const result = await session.sendSerialData(payload, isHex, appendNewline);
    reportWriteReceipt(result, result.status === 'queued' ? '[TX:WIDGET_QUEUED]' : '[TX:WIDGET_WRITTEN]', payload);
  });
  globalSendGate.setLogWriter((title, payload, isHex) => {
    appendLog('info', `[控件:${title}]`, `${isHex ? '(HEX) ' : ''}${payload}`);
  });
  globalSendGate.setPortConnected(isRunning.value);

  unsubWaveformBatch = session.onWaveformBatch((batch) => {
    // 即使界面暂停跟随或正在 Scrubber 回溯，后台环形缓冲与安全分析也决不丢弃数据
    if (!batch || !batch.timestamps || batch.timestamps.length === 0) return;
    const previousContext = globalChannelStore.getSessionContext();
    const nextSessionId = batch.session_id || null;
    const nextEpoch = Number.isSafeInteger(batch.channel_epoch) ? batch.channel_epoch : null;
    if (previousContext.sessionId !== nextSessionId || previousContext.epoch !== nextEpoch) {
      // The volatile chart cache must never relabel earlier-session samples as
      // current evidence. Raw recording history remains in its recording store.
      globalChannelStore.clear();
    }
    globalChannelStore.setSessionContext(batch.session_id || null, batch.channel_epoch);
    const frozenSelection = assistantEvidenceSelection.value;
    const currentContext = globalChannelStore.getSessionContext();
    if (frozenSelection && (frozenSelection.context.sessionId !== currentContext.sessionId
      || frozenSelection.context.epoch !== currentContext.epoch
      || frozenSelection.context.generation !== globalChannelStore.getGeneration())) clearEvidenceSelection();
    const names = batch.channel_names || batch.series.map((_series, index) => `!${index}`);
    globalChannelStore.pushSeries(names, batch.timestamps, batch.series);
    activeChannels.value = globalChannelStore.listChannels().filter(id => (globalChannelStore.getBuffer(id, false)?.getSize() || 0) > 0);
  });

  unsubProjectModel = globalProjectModel.onModelChanged(() => {
    activeLoop.value = globalProjectModel.getActiveLoop() || null;
  });
});

watch(isRunning, (val) => {
  dtrState.value = null;
  rtsState.value = null;
  if (!val) { clearEvidenceSelection(); activeChannels.value = []; activeAnomaly.value = null; anomaliesList.value = []; globalLogAnalyzer.clearAnomalies(); }
  globalSendGate.setPortConnected(val);
});

onUnmounted(() => {
  clearAssistantOnChannelClear();
  clearEvidenceSelection();
  recordingReplayController.close();
  window.removeEventListener('keydown', handleKeyDown, true);
  if (statusInterval) clearInterval(statusInterval);
  if (emergencyTimer) clearTimeout(emergencyTimer);
  if (disconnectTimer) clearTimeout(disconnectTimer);
  if (saveConfigTimer) clearTimeout(saveConfigTimer);
  if (unsubStatus) unsubStatus();
  if (unsubError) unsubError();
  if (unsubWriteResult) unsubWriteResult();
  if (unsubLogsBatch) unsubLogsBatch();
  if (unsubRawData) unsubRawData();
  if (unsubChannelCapacity) unsubChannelCapacity();
  if (unsubStepSnapshot) unsubStepSnapshot();
  if (unsubWaveformBatch) unsubWaveformBatch();
  if (unsubProjectModel) unsubProjectModel();
});
</script>

<template>
  <div class="workbench-vofa-app">
    <!-- 1. 精简顶栏 AppHeader (移除三模式，保留串口快捷胶囊、急停指示与监控) -->
    <AppHeader
      :is-running="isRunning"
      :connection-state="connectionState"
      :selected-port="selectedPort"
      :selected-baud="selectedBaud"
      :ports="ports"
      :is-refreshing-ports="isRefreshingPorts"
      :total-samples="totalSamples"
      :sample-rate="sampleRate"
      :data-state-label="dataStateLabel"
      :dropped-bytes="displayedDroppedBytes"
      :protocol-errors="diagnosticErrorCount"
      :emergency-command="appConfig.emergency_command"
      :can-request-port="session.capabilities.value.requiresUserGestureToAddPort"
      :assistant-open="isCopilotDrawerOpen"
      :workspace-busy="isTuningBusy"
      :supports-recording="session.supportsRecording.value"
      :is-acquiring="isAcquiring"
      :recording-status="recordingStatus"
      :recording-busy="recordingBusy"
      :is-display-paused="isStreamPaused"
      :writes-locked="session.softwareStopLocked.value"
      :demo-busy="demoBusy"
      @toggle-connect="handleToggleConnect"
      @reset="handleReset"
      @change-port="handlePortChange"
      @change-baud="handleBaudChange"
      @refresh-ports="refreshPorts"
      @request-port="handleRequestPort"
      @trigger-emergency-stop="triggerEmergencyStop"
      @open-help="showHelpModal = true"
      @toggle-recording="handleToggleRecording"
      @toggle-acquisition="handleToggleAcquisition"
      @open-recordings="handleOpenRecordingLibrary"
      @resume-writes="handleResumeWrites"
      @start-demo="handleStartDemo"
      @open-assistant="isCopilotDrawerOpen ? isCopilotDrawerOpen = false : openSceneAssistant()"
      @open-analysis="openAnalysis"
    />

    <RecordingLibraryDrawer
      v-if="recordingsVisited"
      :open="recordingLibraryOpen"
      :recordings="recordingSummaries"
      :loading="recordingLibraryLoading"
      :error="recordingLibraryError"
      :replay-session="recordingReplaySession"
      :replay-page="recordingReplayPage"
      :replay-loading="recordingReplayLoading"
      :replay-error="recordingReplayError"
      :replay-samples="recordingReplaySamples"
      :replay-logs="recordingReplayLogs"
      :replay-decode-notice="recordingReplayDecodeNotice"
      :replay-decode-error-count="recordingReplayDecodeErrorCount"
      @close="recordingLibraryOpen = false"
      @refresh="loadRecordingLibrary"
      @start-replay="handleStartRecordingReplay"
      @close-replay="handleCloseRecordingReplay"
      @load-next-page="loadRecordingReplayPage"
      @export-replay="handleExportRecordingReplay"
      @export-raw="handleExportRecordingRaw"
    />

    <div class="canvas-workspace">
    <div class="serial-workspace-row">
    <div class="serial-main">
    <!-- 2. 主视窗工作区：左侧 44px IconDock + 100% 自由多 Tab 画布 + 悬浮抽屉 -->
    <div class="workbench-middle-area">
      <!-- 左侧垂直侧边栏 IconDock -->
      <IconDock
        v-model:active-drawer="activeDockDrawer"
        :is-running="isRunning"
        :connection-state="connectionState"
        :is-locked="widgetStore.isLocked.value"
        @toggle-lock="widgetStore.isLocked.value = !widgetStore.isLocked.value"
      />

      <!-- 100% 全自由多 Tab 画布主体 -->
      <UnifiedCanvasWorkbench
        ref="workbenchRef"
        :is-running="isRunning"
        @open-serial-request="handleToggleConnect"
        @click-canvas="handleCanvasClick"
      />

      <!-- 右侧多通道数据抽屉侧边栏 (RightDataSidebar) -->
      <RightDataSidebar ref="rightSidebarRef" :is-running="isRunning" />

      <!-- ① 悬浮抽屉：协议与物理接口连接 -->
      <ConnectionAndProtocolDrawer
        :is-open="activeDockDrawer === 'connection'"
        :is-running="isRunning"
        :connection-state="connectionState"
        :selected-port="selectedPort"
        :selected-baud="selectedBaud"
        :serial-settings="appConfig.serial_settings"
        :protocol-config="appConfig.protocol_config"
        :is-applying-protocol="isApplyingProtocol"
        :rx-bytes="totalRxBytes"
        :parsed-samples="totalSamples"
        :protocol-errors="diagnosticErrorCount"
        :dropped-bytes="displayedDroppedBytes"
        :ports="ports"
        :is-refreshing-ports="isRefreshingPorts"
        :can-request-port="session.capabilities.value.requiresUserGestureToAddPort"
        :can-control-signals="canControlSerialSignals"
        :dtr-state="dtrState"
        :rts-state="rtsState"
        @close="activeDockDrawer = null"
        @toggle-connect="handleToggleConnect"
        @change-port="handlePortChange"
        @change-baud="handleBaudChange"
        @change-serial-settings="handleSerialSettingsChange"
        @refresh-ports="refreshPorts"
        @request-port="handleRequestPort"
        @apply-protocol="handleProtocolChange"
        @set-dtr="handleSetDtr"
        @set-rts="handleSetRts"
        @set-break="handleSetBreak"
      />

      <!-- ② 悬浮抽屉：预设命令库 -->
      <CommandLibraryDrawer
        :is-open="activeDockDrawer === 'commands'"
        :is-running="isRunning"
        :commands="appConfig.quick_commands"
        @close="activeDockDrawer = null"
        @send-command="handleSendQuickCommand"
        @fill-input="handleFillSendArea"
        @update-commands="handleUpdateCommands"
        @emergency-stop="triggerEmergencyStop"
      />

      <!-- ③ 悬浮抽屉：元器件仓库 -->
      <WidgetDrawer
        :is-open="activeDockDrawer === 'widgets'"
        :is-locked="widgetStore.isLocked.value"
        @close="activeDockDrawer = null"
      />

      <!-- ④ 悬浮抽屉：工程与画布管理 -->
      <ProjectDrawer
        :is-open="activeDockDrawer === 'project'"
        :workspace-document="workspaceDocument"
        :workspace-import-status="workspaceImportStatus"
        @close="activeDockDrawer = null"
        @import-workspace="handleImportWorkspace"
      />
    </div>

    <TerminalLogDrawer
      :is-open="isTerminalDrawerOpen"
      :docked="true"
      :logs="logs"
      :is-running="isRunning"
      :active-anomaly="activeAnomaly"
      @close="isTerminalDrawerOpen = false"
      @clear-logs="handleClearLogs"
      @diagnose-log="handleDiagnoseLog"
      @wake-copilot-anomaly="handleWakeCopilotAnomaly"
    />

    <!-- Shared terminal composer remains directly below the receive pane. -->
    <DockedTerminalStrip
      ref="terminalStripRef"
      :is-running="isRunning"
      :is-paused="isStreamPaused"
      :total-samples="totalSamples"
      :sample-rate="sampleRate"
      :dropped-bytes="displayedDroppedBytes"
      :active-anomaly="activeAnomaly"
      :phase-margin="currentPhaseMargin"
      :quick-commands="appConfig.quick_commands"
      :unread-log-count="unreadLogCount"
      :is-terminal-open="isTerminalDrawerOpen"
      :active-channels="activeChannels"
      :rx-bytes="totalRxBytes"
      :tx-bytes="totalTxBytes"
      :send-command="handleSendSerialData"
      @toggle-pause="handleToggleStreamPause"
      @clear-buffer="handleClearBuffer"
      @auto-scale="handleAutoScaleCharts"
      @scrub-history="handleScrubHistory"
      @resume-live="handleResumeLive"
      @wake-copilot="handleWakeCopilot"
      @toggle-terminal="handleToggleTerminal"
      @emergency-stop="triggerEmergencyStop"
      @send-quick-command="handleSendQuickCommand"
      @clear-terminal-logs="handleClearLogs"
      @open-command-drawer="activeDockDrawer = 'commands'"
    />

    </div>
    <aside v-show="isCopilotDrawerOpen" class="integrated-assistant" aria-label="AI 辅助">
      <header class="integrated-assistant-header">
        <div><h2>AI 辅助</h2><p>{{ isTuningBusy ? '实验进行中 · 收起面板后仍继续' : assistantContextLabel }}</p></div>
        <button type="button" aria-label="收起 AI 辅助" @click="isCopilotDrawerOpen = false">收起</button>
      </header>
      <nav class="assistant-tabs" aria-label="AI 辅助方式">
        <button type="button" :aria-pressed="assistantTab === 'tuning'" :disabled="isTuningBusy" @click="selectAssistantTab('tuning')">场景调参</button>
        <button type="button" :aria-pressed="assistantTab === 'debug'" :disabled="isTuningBusy" @click="selectAssistantTab('debug')">日志解读</button>
      </nav>
      <TuningWorkbench
        v-if="tuningVisited"
        v-show="assistantTab === 'tuning'"
        class="tuning-assistant-slot"
        :connected="isRunning"
        :connection-label="assistantContextLabel"
        :demo="mode === 'mock'"
        :ai-config="appConfig.ai_config"
        :protocol-config="appConfig.protocol_config"
        :logs="logs"
        :write-result="tuningWriteResult"
        :stop-token="tuningStopToken"
        :write-access-ready="tuningWriteAccessReady"
        :ordinary-write-revision="ordinaryWriteRevision"
        :ordinary-writes-ready="session.writesReady.value && pendingSignalChanges === 0 && !isApplyingProtocol"
        :execution-enabled="isRunning && isAcquiring && !isApplyingProtocol && mode !== 'mock' && Boolean(appConfig.emergency_command?.trim()) && !session.softwareStopLocked.value"
        @open-ai-settings="openAssistantSettings"
        @open-protocol-settings="activeDockDrawer = 'connection'"
        @send-command="handleTuningSend"
        @execution-state="handleTuningExecutionState"
        @safety-stop="handleTuningSafetyStop"
      />
      <DebugAssistantPanel
        v-if="copilotVisited"
        ref="copilotDrawerRef"
        :open="isCopilotDrawerOpen && assistantTab === 'debug'"
        :embedded="true"
        :config="appConfig.ai_config"
        :logs="logs"
        :channels="activeChannels"
        :context-label="assistantContextLabel"
        :protocol="appConfig.protocol_config"
        :configuration-version="assistantConfigurationVersion"
        :save-config="saveAssistantConfig"
        :apply-action="applyAssistantAction"
        @close="isCopilotDrawerOpen = false"
      />
    </aside>
    </div>

    <!-- Existing control analysis is retained as an advanced tool. -->
    <CopilotDrawer
      v-if="analysisVisited"
      v-model:is-open="analysisOpen"
      :advanced-only="true"
      :active-loop="activeLoop"
      :phase-margin="currentPhaseMargin"
      :step-metrics="activeSnapshot?.metrics || null"
      :anomalies="anomaliesList"
      :logs="logs"
      :ai-config="appConfig.ai_config"
      :is-running="isRunning"
      @fill-send-area="handleFillSendArea"
      @save-quick-command="handleSaveQuickCommand"
      @update-ai-config="handleUpdateAiConfig"
      @open-log-dir="handleOpenLogDir"
    />

    <!-- 9. 帮助说明弹窗 -->
    <div v-if="showHelpModal" class="modal-backdrop" @click="showHelpModal = false">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="help-title" @click.stop style="max-width: 600px;">
        <div class="modal-header">
          <span class="modal-title" id="help-title">开始使用 LLM 串口</span>
          <button class="modal-close" aria-label="关闭帮助" @click="showHelpModal = false">✕</button>
        </div>
        <div class="modal-body help-body">
          <div class="help-section">
            <div class="help-heading">连接、观察、记录</div>
            <p>在顶栏选择端口和波特率，通过左侧「连接」配置固件协议。波形与终端一起观察数据；「记录」保存原始字节，「记录库」回放和导出。</p>
          </div>
          <div class="help-section">
            <div class="help-heading">场景 AI 辅助</div>
            <p>点击「AI 辅助」，依次选择场景、控制环节和调参方式。模型计算可离线使用；自动反馈需要真实设备通道、参数边界、停止配置和本次授权。日志解读在同一面板中选择证据后请求分析。「工具」提供按需模型与仿真。演示与预测均不代表实机结果。</p>
          </div>
          <div class="help-section">
            <div class="help-heading">常用快捷键</div>
            <ul class="help-list">
              <li><kbd class="kbd">Space</kbd>：焦点在画布空白处时锁定软件发送、清空待发队列，并可选排队配置的停止命令；焦点在按钮或输入框时保留原有键盘操作。软件停止不替代硬件急停。</li>
              <li><kbd class="kbd">Ctrl + ~</kbd>：平滑呼出 / 隐藏底部终端日志抽屉。</li>
              <li><kbd class="kbd">Esc</kbd>：快速收起当前展开的抽屉与弹窗。</li>
              <li><kbd class="kbd">Delete</kbd>：删除当前在画布中选中的元器件（解锁态有效）。</li>
              <li><kbd class="kbd">Ctrl + D</kbd>：克隆复制选中的元器件。</li>
            </ul>
          </div>
          <div class="help-section">
            <div class="help-heading">画布编辑</div>
            <p>点击左侧侧边栏底部或画布右上角的挂锁图标。锁定态（🔒）防止调试现场误触位移；解锁态（🔓）允许自由添加、移动与拉伸控件。</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-modal-close" @click="showHelpModal = false">知道了</button>
        </div>
      </div>
    </div>

    <!-- 10. 全局指针拖拽跟随浮层 (1:1 原型半透明投影) -->
    <div
      v-if="widgetStore.pointerDragState.value.active"
      class="global-pointer-drag-ghost"
      :style="{
        left: `${widgetStore.pointerDragState.value.pointerX}px`,
        top: `${widgetStore.pointerDragState.value.pointerY}px`,
        width: `${widgetStore.pointerDragState.value.previewW}px`,
        height: `${widgetStore.pointerDragState.value.previewH}px`,
      }"
    >
      <div class="pointer-ghost-badge">
        <span class="pointer-ghost-icon">{{ widgetStore.pointerDragState.value.icon }}</span>
        <span class="pointer-ghost-name">{{ widgetStore.pointerDragState.value.name }}</span>
      </div>
      <div class="pointer-ghost-size">
        {{ widgetStore.pointerDragState.value.previewW }} × {{ widgetStore.pointerDragState.value.previewH }}
      </div>
    </div>
    </div>

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

    <transition name="fade">
      <div v-if="showEmergencyToast" class="emergency-toast" :class="emergencyToastLevel">
        <div class="toast-icon">🛑</div>
        <div class="toast-content">
          <div class="toast-title">{{ emergencyToastTitle }}</div>
          <div class="toast-desc">{{ emergencyToastDesc }}</div>
          <div v-if="!appConfig.emergency_command" class="bind-quick-action">
            <button class="btn-bind-quick" @click="configureEmergencyCommand">配置停止文本命令…</button>
          </div>
        </div>
        <button class="toast-close" @click="showEmergencyToast = false">✕</button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.workbench-vofa-app {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-base);
  color: var(--text-main);
  overflow: hidden;
  position: relative;
  transition: background-color 0.25s ease, color 0.25s ease;
}

.workbench-middle-area {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
  overflow: hidden;
}

.canvas-workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.serial-workspace-row {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.serial-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
}
.integrated-assistant {
  width: clamp(360px, 37vw, 480px);
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-strong);
  overflow: hidden;
}
.integrated-assistant-header {
  padding: 12px 16px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.integrated-assistant-header h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.integrated-assistant-header p { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.integrated-assistant-header button, .assistant-tabs button {
  min-height: 32px;
  padding: 5px 10px;
  background: var(--bg-base);
  color: var(--text-main);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  font: inherit;
  cursor: pointer;
}
.assistant-tabs { display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border-subtle); }
.assistant-tabs button { flex: 1; background: transparent; border-color: transparent; }
.assistant-tabs button[aria-pressed='true'] { background: var(--accent-terracotta-soft); color: var(--accent-terracotta); }
.assistant-tabs button:disabled { opacity: .5; cursor: not-allowed; }
.tuning-assistant-slot { flex: 1; min-height: 0; }
@media (max-height: 700px) {
  .integrated-assistant-header { padding: 6px 12px; align-items: center; }
  .integrated-assistant-header > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  .integrated-assistant-header h2 { margin: 0; font-size: 14px; }
  .assistant-tabs { padding: 4px 12px; }
}
@media (max-width: 760px) {
  .integrated-assistant { position: absolute; right: 0; top: 0; bottom: 0; width: min(420px, calc(100% - 44px)); z-index: 55; }
}

/* 弹窗通用样式 */
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(4px);
}

.modal-card {
  width: 90%;
  max-width: 520px;
  background-color: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  box-shadow: var(--card-shadow, 0 16px 36px rgba(0, 0, 0, 0.35));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: var(--bg-elevated);
}

.modal-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.modal-avatar-badge {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  border: 1.5px solid var(--accent-terracotta);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-mascot-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.modal-title-wrap {
  display: flex;
  flex-direction: column;
}

.modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.modal-subtitle {
  font-size: 10px;
  color: var(--text-muted);
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background-color: var(--bg-surface);
  color: var(--text-main);
}

.modal-body {
  padding: 16px;
  overflow-y: auto;
  max-height: 480px;
  background-color: var(--bg-surface);
  color: var(--text-main);
}

.modal-footer {
  padding: 10px 16px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  justify-content: flex-end;
  background-color: var(--bg-elevated);
}

.btn-modal-close {
  padding: 6px 14px;
  background-color: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  color: var(--text-main);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-modal-close:hover {
  background-color: var(--bg-elevated);
  border-color: var(--accent-terracotta);
  color: var(--accent-terracotta);
}

.diagnose-target {
  padding: 8px 10px;
  background-color: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  font-size: 11px;
  margin-bottom: 12px;
  display: flex;
  gap: 8px;
}

.diagnose-scope {
  margin: -4px 0 12px;
  padding: 7px 9px;
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--accent-terracotta) 10%, transparent);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.45;
}

.target-tag {
  color: #ef4444;
  font-weight: 600;
}

.target-text {
  color: var(--text-main);
  word-break: break-all;
}

.loading-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-terracotta);
  font-size: 12px;
  padding: 16px 0;
  justify-content: center;
}

.spinner {
  animation: pulse 1s infinite;
}

.diagnosis-text {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-main);
  white-space: pre-wrap;
}

/* Toast 提示 */
.disconnect-alert,
.emergency-toast {
  position: fixed;
  bottom: 48px;
  right: 20px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  background-color: var(--bg-surface);
  border: 1px solid #ef4444;
  box-shadow: 0 8px 24px rgba(239, 68, 68, 0.25);
  z-index: 90;
  max-width: 420px;
  color: var(--text-main);
}

.emergency-toast.warn {
  border-color: #f59e0b;
  box-shadow: 0 8px 24px rgba(245, 158, 11, 0.25);
}

.alert-content,
.toast-content {
  flex: 1;
}

.alert-title,
.toast-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 2px;
}

.alert-desc,
.toast-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.alert-close,
.toast-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
}

.alert-close:hover,
.toast-close:hover {
  color: var(--text-main);
}

.btn-bind-quick {
  margin-top: 8px;
  padding: 4px 8px;
  background-color: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border: 1px solid var(--accent-terracotta);
  border-radius: 6px;
  color: var(--accent-terracotta);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-bind-quick:hover {
  background-color: var(--accent-terracotta);
  color: #ffffff;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 帮助弹窗 */
.help-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.help-heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-terracotta);
  margin-bottom: 4px;
}

.help-section p {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
  margin: 0;
}

.help-list {
  margin: 0;
  padding-left: 18px;
  font-size: 11px;
  color: var(--text-main);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kbd {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 10px;
  font-family: monospace;
  color: var(--accent-terracotta);
}

/* 全局 1:1 指针拖拽半透明投影 (VOFA+ 原生交互) */
.global-pointer-drag-ghost {
  position: fixed;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 99999;
  border: 2px dashed var(--accent-terracotta);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  backdrop-filter: blur(4px);
  border-radius: 8px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.25), 0 0 20px rgba(218, 119, 86, 0.25);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  user-select: none;
  will-change: left, top;
}

.pointer-ghost-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  padding: 6px 12px;
  border-radius: 6px;
  box-shadow: var(--card-shadow, 0 4px 12px rgba(0, 0, 0, 0.2));
}

.pointer-ghost-icon {
  font-size: 20px;
}

.pointer-ghost-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.pointer-ghost-size {
  font-size: 11px;
  font-family: monospace;
  color: var(--accent-terracotta);
  background: var(--bg-elevated);
  padding: 2px 8px;
  border-radius: 4px;
}

</style>
