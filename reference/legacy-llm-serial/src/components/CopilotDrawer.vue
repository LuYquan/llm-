<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import type { AiConfig } from '../services/ai';
import { PROVIDER_DEFAULTS, fetchAvailableModels, requestChatCompletion } from '../services/ai';
import type { ControlLoop } from '../core/project/types';
import { globalProjectModel } from '../core/project/ProjectModel';
import type {
  FirmwareAnomaly,
  CopilotChatMessage,
  CopilotOutputSchema,
} from '../core/copilot/types';
import { ContextBuilder } from '../core/copilot/ContextBuilder';
import { validateCopilotResponse } from '../core/copilot/CopilotSchema';
import { CopilotSafetyGuard } from '../core/copilot/CopilotSafetyGuard';
import type { IdentifyPlantResult, PlantModel } from '../core/control/types';
import { globalChannelStore } from '../core/channel/ChannelStore';
import { analysisWorker, type CancellableAnalysis } from '../services/analysis/analysis-worker-client';
import { CascadeStateMachine } from '../core/control/cascadeStateMachine';
import BodePlotViewer from './BodePlotViewer.vue';
import SimulationCompareView from './SimulationCompareView.vue';
import LoopTopologyWizard from './LoopTopologyWizard.vue';

const props = defineProps<{
  isOpen: boolean;
  activeLoop?: ControlLoop | null;
  phaseMargin?: number;
  stepMetrics?: any | null;
  anomalies: FirmwareAnomaly[];
  logs: Array<{ time: string; level: string; tag: string; text: string }>;
  aiConfig: AiConfig;
  isRunning?: boolean;
  advancedOnly?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:isOpen', open: boolean): void;
  (e: 'fill-send-area', command: string): void;
  (e: 'save-quick-command', cmd: { name: string; command: string }): void;
  (e: 'update-ai-config', config: AiConfig): void;
  (e: 'open-log-dir'): void;
}>();

// 抽屉高度控制与拖拽 (30% ~ 55%)
const drawerHeight = ref(340);
const isResizing = ref(false);
const activeTab = ref<'chat' | 'bode' | 'sim'>(props.advancedOnly ? 'bode' : 'chat');
const lastSolvedPid = ref<{ kp: number; ki: number; kd: number } | null>(null);
const identifiedPlant = ref<PlantModel | null>(null);
const identifiedPlantOrigin = ref<'identified' | 'manual'>('manual');
const identificationMode = ref<'' | 'open_loop' | 'closed_loop'>('');
const controllerConfirmed = ref(false);
const identificationStatus = ref('选择实验方式后，从环路已绑定的输入和反馈通道辨识。');
let identificationJob: CancellableAnalysis<IdentifyPlantResult> | null = null;
const identificationInputBinding = computed(() => {
  const loop = props.activeLoop;
  if (!loop) return '未选择控制环路';
  if (!identificationMode.value) return '请先选择实验方式';
  const channel = identificationMode.value === 'closed_loop' ? loop.channels.setpoint : loop.channels.output;
  return String(channel ?? '').trim() || '未绑定';
});
const identificationFeedbackBinding = computed(() => {
  const channel = props.activeLoop?.channels.feedback;
  return String(channel ?? '').trim() || '未绑定';
});

// 快捷配置弹窗
const showConfigModal = ref(false);
const showTopologyWizard = ref(false);
const editConfig = ref<AiConfig>({ ...props.aiConfig });
const isFetchingModels = ref(false);
const fetchedModels = ref<string[]>([]);
const fetchModelsError = ref<string | null>(null);

// 对话消息列表
const chatMessages = ref<CopilotChatMessage[]>([
  {
    id: 'msg_welcome',
    sender: 'system',
    timestamp: Date.now(),
    text: 'Copilot 控制副驾驶已就绪。已接入项目环路拓扑与 SafetyGuard 本地安全防线。点击状态条指标或输入问题开展诊断。',
  },
]);

const userInput = ref('');
const isThinking = ref(false);
const chatBodyRef = ref<HTMLDivElement | null>(null);

// 状态条派生计算
const activeLoopName = computed(() => {
  if (props.activeLoop) {
    return props.activeLoop.name || props.activeLoop.id;
  }
  return '速度环';
});

const currentLoopOrderBadge = computed(() => {
  if (!props.activeLoop) return '单环';
  const order = props.activeLoop.order;
  const stateLabel = props.activeLoop.state === 'tuned' ? '已整定' : props.activeLoop.state === 'identified' ? '已辨识' : '待整定';
  const levelLabel = order === 0 ? '内环' : order === 1 ? '中环' : '外环';
  return `${levelLabel}·${stateLabel}`;
});

const cascadeBadge = computed(() => {
  const sm = new CascadeStateMachine(globalProjectModel);
  return sm.getPipelineStatus(props.activeLoop?.id).formattedBadge;
});

const currentMp = computed<number | null>(() => {
  if (props.stepMetrics && typeof props.stepMetrics.overshoot_pct === 'number') {
    return props.stepMetrics.overshoot_pct;
  }
  return null;
});

const currentGamma = computed<number | null>(() => {
  if (typeof props.phaseMargin === 'number') {
    return props.phaseMargin;
  }
  return null;
});

const anomalyCount = computed(() => props.anomalies.length);

// 拖拽手柄逻辑
function startResize(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startY = e.clientY;
  const startH = drawerHeight.value;

  function onMouseMove(me: MouseEvent) {
    const delta = startY - me.clientY;
    const minH = Math.max(200, Math.round(window.innerHeight * 0.28));
    const maxH = Math.min(650, Math.round(window.innerHeight * 0.55));
    drawerHeight.value = Math.max(minH, Math.min(maxH, startH + delta));
  }

  function onMouseUp() {
    isResizing.value = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    try {
      localStorage.setItem('copilot_drawer_height', String(drawerHeight.value));
    } catch {
      // ignore
    }
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

onMounted(() => {
  try {
    const saved = localStorage.getItem('copilot_drawer_height');
    if (saved) {
      const h = parseInt(saved, 10);
      if (!isNaN(h) && h >= 200 && h <= 650) {
        drawerHeight.value = h;
      }
    }
  } catch {
    // ignore
  }
});

onUnmounted(() => {
  identificationJob?.cancel();
  identificationJob = null;
});

watch(() => {
  const loop = props.activeLoop;
  if (!loop) return '';
  const controller = identificationMode.value === 'closed_loop' ? loop.current_params : null;
  return JSON.stringify({
    id: loop.id,
    channels: loop.channels,
    sampleTime: loop.sample_time,
    samplePeriod: loop.sample_period_s,
    controller,
  });
}, () => {
  identificationJob?.cancel();
  identificationJob = null;
  identifiedPlant.value = null;
  controllerConfirmed.value = false;
  identificationStatus.value = '环路绑定或控制参数已变化，请重新核对实验方式后辨识。';
});

watch(identificationMode, (mode) => {
  identificationJob?.cancel();
  identificationJob = null;
  identifiedPlant.value = null;
  controllerConfirmed.value = false;
  identificationStatus.value = mode
    ? '模式已更改，请重新运行辨识。'
    : '选择实验方式后，从环路已绑定的输入和反馈通道辨识。';
});

function toggleDrawer() {
  emit('update:isOpen', !props.isOpen);
}

function scrollToBottom() {
  nextTick(() => {
    if (chatBodyRef.value) {
      chatBodyRef.value.scrollTop = chatBodyRef.value.scrollHeight;
    }
  });
}

// 从 ChannelStore 历史波形中自动辨识模型参数；拟合在分析 Worker 执行。
async function autoIdentifyFromCurrentData(): Promise<boolean> {
  identificationJob?.cancel();
  identificationJob = null;
  identifiedPlant.value = null;
  const loop = props.activeLoop;
  if (!loop || !identificationMode.value) {
    identificationStatus.value = '请先选择开环或闭环实验方式。';
    return false;
  }
  if (identificationMode.value === 'closed_loop' && (!controllerConfirmed.value || !loop.current_params)) {
    identificationStatus.value = '闭环辨识前，请确认当前环路中的 PID 参数与本次设备实验一致。';
    return false;
  }

  const mode = identificationMode.value;
  const feedbackChannel = String(loop.channels.feedback ?? '').trim();
  const inputBinding = mode === 'open_loop' ? loop.channels.output : loop.channels.setpoint;
  const inputChannel = String(inputBinding ?? '').trim();
  if (!feedbackChannel || !inputChannel || feedbackChannel === inputChannel) {
    identificationStatus.value = '环路输入和反馈通道未配置完整，或错误地绑定到同一通道。';
    return false;
  }
  const generation = globalChannelStore.getGeneration();
  const feedback = globalChannelStore.snapshot(feedbackChannel);
  const input = globalChannelStore.snapshot(inputChannel);
  if (feedback.count < 10 || input.count < 10) {
    identificationStatus.value = '等待输入与反馈通道至少各有 10 个样本。';
    return false;
  }

  const baselineCount = Math.min(5, input.count);
  let inputBaseline = 0;
  for (let index = 0; index < input.count; index++) {
    if (!Number.isFinite(input.values[index])
      || !Number.isFinite(input.timestamps[index])
      || (index > 0 && input.timestamps[index] <= input.timestamps[index - 1])) {
      identificationStatus.value = `输入通道第 ${index + 1} 个样本无效或时间戳不递增，无法定位阶跃。`;
      return false;
    }
  }
  for (let index = 0; index < baselineCount; index++) inputBaseline += input.values[index];
  inputBaseline /= baselineCount;
  const threshold = Math.max(1e-4, Math.abs(inputBaseline) * 1e-6);
  let stepIndex = -1;
  for (let index = baselineCount; index < input.count; index++) {
    if (!Number.isFinite(input.values[index])
      || !Number.isFinite(input.timestamps[index])
      || input.timestamps[index] <= input.timestamps[index - 1]) {
      identificationStatus.value = '输入通道时间戳或数值无效，无法定位阶跃。';
      return false;
    }
    if (Math.abs(input.values[index] - inputBaseline) > threshold) {
      stepIndex = index;
      break;
    }
  }
  if (stepIndex < baselineCount || stepIndex < 0 || input.count - stepIndex < 5) {
    identificationStatus.value = '输入通道没有可确认的阶跃边沿；请检查通道绑定和采集区间。';
    return false;
  }

  let postMean = 0;
  const postCount = Math.min(5, input.count - stepIndex);
  let postMin = Infinity;
  let postMax = -Infinity;
  for (let index = input.count - postCount; index < input.count; index++) {
    const value = input.values[index];
    postMean += value;
    postMin = Math.min(postMin, value);
    postMax = Math.max(postMax, value);
  }
  const stepAmplitude = postMean / postCount - inputBaseline;
  if (!Number.isFinite(stepAmplitude) || Math.abs(stepAmplitude) < 1e-6) {
    identificationStatus.value = '输入阶跃幅值过小，无法进行定量辨识。';
    return false;
  }
  if (postMax - postMin > Math.max(Math.abs(stepAmplitude) * 0.05, threshold * 5)) {
    identificationStatus.value = '输入通道末段仍在明显变化，无法确认稳定阶跃幅值。';
    return false;
  }

  const options = {
    family: 'auto',
    mode,
    stepTime: input.timestamps[stepIndex],
    stepAmplitude,
    sampleTime: loop.sample_time || loop.sample_period_s || 0.001,
    ...(mode === 'closed_loop' && loop.current_params
      ? { controller: { ...loop.current_params, sampleTime: loop.sample_time || loop.sample_period_s || 0.001 } }
      : {}),
  } as const;

  const sessionContext = globalChannelStore.getSessionContext();
  const job = analysisWorker.runIdentification(feedback.timestamps, feedback.values, options, {
    source: 'live',
    ...sessionContext,
    generation,
    channelIds: [inputChannel, feedbackChannel],
  });
  identificationJob = job;
  identificationStatus.value = '正在后台拟合模型…';
  try {
    const res = await job.promise;
    if (identificationJob?.id !== job.id) return false;
    if (generation !== globalChannelStore.getGeneration()) {
      identificationStatus.value = '数据会话在辨识期间已重置，旧结果已丢弃；请重新采集后再试。';
      return false;
    }
    if (res.usable) {
      identifiedPlant.value = res.model;
      identifiedPlantOrigin.value = 'identified';
      // Persist only a usable, session-bound identification result.  The dashboard
      // Bode widget must never reconstruct a plant from plant_family alone.
      if (props.activeLoop) {
        globalProjectModel.updateLoop(props.activeLoop.id, {
          identified_model: res.model,
          state: 'identified',
        });
      }
      identificationStatus.value = res.message;
      return true;
    }
    identificationStatus.value = res.message;
    return false;
  } catch (error) {
    if (identificationJob?.id !== job.id) return false;
    console.warn('[copilot] 当前波形辨识失败:', error);
    identificationStatus.value = `辨识失败：${error instanceof Error ? error.message : String(error)}`;
    return false;
  } finally {
    if (identificationJob?.id === job.id) identificationJob = null;
  }
}

// 供外部（如 EventCapsule 点击）调用的预置诊断唤醒
function askWithPreset(query: string, triggerImmediately = true) {
  userInput.value = query;
  if (!props.isOpen) {
    emit('update:isOpen', true);
  }
  if (triggerImmediately) {
    handleSendQuery();
  }
}

defineExpose({
  askWithPreset,
  autoIdentifyFromCurrentData,
});

// 处理用户发送提问
async function handleSendQuery() {
  const query = userInput.value.trim();
  if (!query || isThinking.value) return;

  const userMsgId = `user_${Date.now()}`;
  chatMessages.value.push({
    id: userMsgId,
    sender: 'user',
    timestamp: Date.now(),
    text: query,
  });
  userInput.value = '';
  isThinking.value = true;
  scrollToBottom();

  try {
    // 1. 零复制打包上下文
    const payload = ContextBuilder.buildPayload({
      projectManager: globalProjectModel,
      stepMetrics: props.stepMetrics,
      identifiedModel: {
        phase_margin: currentGamma.value ?? undefined,
      },
      logs: props.logs,
      anomalies: props.anomalies,
    });

    const sysPrompt = ContextBuilder.formatSystemPrompt(payload);
    const usrPrompt = ContextBuilder.formatUserPrompt(query, payload);

    let rawReply = '';

    // 2. 统一 AI 请求边界。Ollama 本机服务不需要 API Key；云服务无 Key 时
    // 只运行本地规则提示，避免把未授权请求伪装成已调用模型。
    if (props.aiConfig?.api_key?.trim() || props.aiConfig?.api_key_configured || props.aiConfig?.provider === 'ollama') {
      rawReply = await requestChatCompletion(props.aiConfig, sysPrompt, usrPrompt, {
        timeoutMs: 25_000,
        jsonMode: true,
        temperature: 0.2,
      });
    } else {
      // 离线控制理论规则引擎降级保底 (生成符合 Schema 的结构化响应)
      rawReply = generateOfflineRuleResponse(query, payload);
    }

    // 3. Schema 强校验与数值溯源拦截
    const valResult = validateCopilotResponse(rawReply);

    if (valResult.valid && valResult.data) {
      // 4. 接入 SafetyGuard 本地安全防线
      const safetyCheck = CopilotSafetyGuard.checkSafety({
        command: valResult.data.command,
        params: valResult.data.params,
        activeLoop: props.activeLoop,
      });

      // 如果 SafetyGuard 拦截或溯源未通过，禁止填入发送区
      const canFill = valResult.can_fill_send_area && safetyCheck.passed;

      chatMessages.value.push({
        id: `copilot_${Date.now()}`,
        sender: 'copilot',
        timestamp: Date.now(),
        text: valResult.data.diagnosis,
        card: valResult.data,
        canFillSendArea: canFill,
        validationErrors: safetyCheck.errors.length > 0 ? safetyCheck.errors : undefined,
      });
    } else {
      // 不展示未经验证的原始 JSON，以免数值候选或设备指令被误认为有效建议。
      chatMessages.value.push({
        id: `copilot_${Date.now()}`,
        sender: 'copilot',
        timestamp: Date.now(),
        text: '回复未通过本地结构或数值校验，不能作为参数候选或设备指令。请根据拦截原因补齐信息，或转到“AI 调参”工作区执行有记录的分析。',
        validationErrors: valResult.errors,
        canFillSendArea: false,
      });
    }
  } catch (err: any) {
    chatMessages.value.push({
      id: `err_${Date.now()}`,
      sender: 'system',
      timestamp: Date.now(),
      text: `❌ 诊断请求异常: ${err?.message || err}`,
    });
  } finally {
    isThinking.value = false;
    scrollToBottom();
  }
}

// 离线时不伪装模型调用或工具执行，也不生成参数和设备命令。
function generateOfflineRuleResponse(_query: string, payload: any): string {
  const context = payload.active_loop
    ? `已读取当前工程环路“${payload.active_loop.name || payload.active_loop.id}”的上下文。`
    : '当前没有已选择的工程环路。';
  return JSON.stringify({
    diagnosis: '本地规则模式不能依据自然语言推测调参值。',
    evidence: [context, '本次没有调用大语言模型、PID 解算器或仿真工具。'],
    recommendation: '请连接并配置模型服务；如需调参，请进入“AI 调参”工作区，补齐模型、基线、通道和约束后再生成候选。',
    command: '',
    risk_level: 'low',
    requires_confirmation: true,
  }, null, 2);
}

// 填入发送区 (受溯源与 SafetyGuard 严格约束)
function handleFillSend(card: CopilotOutputSchema) {
  if (!card.command) return;
  emit('fill-send-area', card.command);
}

// 暂存为快捷指令
function handleSaveQuick(card: CopilotOutputSchema) {
  if (!card.command) return;
  const name = `Copilot: ${activeLoopName.value} 优化`;
  emit('save-quick-command', { name, command: card.command });
}

// 模型设置弹窗
function openConfig() {
  editConfig.value = { ...props.aiConfig };
  fetchedModels.value = [];
  fetchModelsError.value = null;
  showConfigModal.value = true;
}

function onProviderChange() {
  const provider = editConfig.value.provider;
  const def = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  editConfig.value.api_url = def.url;
  if (def.model) editConfig.value.model = def.model;
  fetchedModels.value = [];
  fetchModelsError.value = null;
}

async function handleFetchModels() {
  if (editConfig.value.provider !== 'ollama' && !editConfig.value.api_key?.trim() && !editConfig.value.api_key_configured) {
    fetchModelsError.value = '请先填写 API Key 再导入模型';
    return;
  }
  isFetchingModels.value = true;
  fetchModelsError.value = null;
  try {
    const list = await fetchAvailableModels({
      provider: editConfig.value.provider,
      api_url: editConfig.value.api_url,
      api_key: editConfig.value.api_key,
    });
    fetchedModels.value = list;
    if (list.length > 0 && (!editConfig.value.model || !list.includes(editConfig.value.model))) {
      editConfig.value.model = list[0];
    }
  } catch (err: any) {
    fetchModelsError.value = err?.message || '拉取模型失败';
  } finally {
    isFetchingModels.value = false;
  }
}

function clearStoredApiKey() {
  editConfig.value.api_key = '';
  editConfig.value.api_key_configured = false;
}

function saveConfig() {
  emit('update-ai-config', editConfig.value);
  showConfigModal.value = false;
}
</script>

<template>
  <footer
    v-if="isOpen"
    class="copilot-drawer"
    :class="{ 'is-expanded': isOpen, 'is-resizing': isResizing, 'advanced-analysis': props.advancedOnly }"
    :style="props.advancedOnly ? {} : { height: `${drawerHeight}px` }"
  >
    <!-- 拖拽调整高度手柄 (仅展开态有效) -->
    <div
      v-if="isOpen && !props.advancedOnly"
      class="drawer-resize-handle"
      @mousedown="startResize"
      title="按住上下拖拽调整 Copilot 抽屉高度 (30%~55%)"
    >
      <div class="resize-bar"></div>
    </div>

    <!-- 收起态：单行紧凑状态条 (任务 2.1 明确规范) -->
    <header v-if="props.advancedOnly" class="advanced-heading"><div><h2>模型与仿真</h2><p>选择实验语义和通道后分析；模型预测不能替代设备实测。</p></div><button type="button" @click="emit('update:isOpen', false)">关闭</button></header>
    <div v-if="!props.advancedOnly" class="drawer-status-bar" @click="toggleDrawer">
      <div class="status-indicators">
        <!-- 激活对象 -->
        <span class="status-chip chip-obj" title="当前激活的被控对象环路">
          <span class="chip-label">对象:</span>
          <strong class="chip-val">{{ activeLoopName }}</strong>
        </span>

        <!-- 串级整定管道状态与当前层级 (点击打开拓扑向导) -->
        <span
          class="status-chip chip-cascade"
          :title="cascadeBadge + ' (点击打开多环拓扑向导)'"
          @click.stop="showTopologyWizard = true"
        >
          <span class="chip-label">层级:</span>
          <strong class="chip-val">{{ currentLoopOrderBadge }}</strong>
          <span class="cascade-wizard-link">🌐 向导</span>
        </span>

        <!-- 相位裕度 γ -->
        <span
          class="status-chip chip-gamma"
          :class="currentGamma == null ? 'chip-zero' : currentGamma < 45 ? 'chip-warn' : 'chip-good'"
          title="开环相位裕度 γ (低于 45° 提示弱阻尼与振荡风险)"
        >
          <span class="chip-label">γ=</span>
          <strong class="chip-val">{{ currentGamma != null ? `${currentGamma.toFixed(0)}°` : '--' }}</strong>
          <span v-if="currentGamma != null && currentGamma < 45" class="warn-icon">⚠</span>
        </span>

        <!-- 阶跃超调量 Mp -->
        <span
          class="status-chip chip-mp"
          :class="currentMp == null ? 'chip-zero' : currentMp > 20 ? 'chip-alert' : currentMp > 10 ? 'chip-warn' : 'chip-good'"
          title="实测阶跃超调量 Mp"
        >
          <span class="chip-label">Mp=</span>
          <strong class="chip-val">{{ currentMp != null ? `${currentMp.toFixed(0)}%` : '--' }}</strong>
        </span>

        <!-- 最近异常数量 -->
        <span
          class="status-chip chip-anom"
          :class="anomalyCount > 0 ? 'chip-bad' : 'chip-zero'"
          title="最近捕获的固件与通道异常总数"
        >
          <span class="chip-label">最近异常:</span>
          <strong class="chip-val">{{ anomalyCount }}</strong>
        </span>
      </div>

      <!-- 右侧操作胶囊 -->
      <div class="status-bar-actions" @click.stop>
        <button
          type="button"
          class="btn-log-dir"
          @click="showTopologyWizard = true"
          title="打开环路拓扑向导配置多环串级与分层校验"
        >
          <span>🌐 拓扑向导</span>
        </button>
        <button
          type="button"
          class="btn-log-dir"
          @click="emit('open-log-dir')"
          title="打开系统日志文件夹 (%APPDATA%/LLM-Serial/logs)"
        >
          <span>📂 日志目录</span>
        </button>
        <button
          type="button"
          class="btn-drawer-toggle"
          @click="toggleDrawer"
          :title="isOpen ? '收起 Copilot 抽屉' : '展开 Copilot 控制副驾驶'"
        >
          <span>{{ isOpen ? '收起 ▼' : '展开 ▲' }}</span>
        </button>
      </div>
    </div>

    <!-- 展开态：主体内容区 -->
    <div v-if="isOpen" class="drawer-expanded-body">
      <!-- 顶部工具栏与标签页 -->
      <div class="expanded-tabs-bar">
        <div class="tab-buttons">
          <button
            v-if="!props.advancedOnly"
            type="button"
            class="tab-btn"
            :class="{ active: activeTab === 'chat' }"
            @click="activeTab = 'chat'"
          >
            💬 对话与智能诊断
          </button>
          <button
            type="button"
            class="tab-btn"
            :class="{ active: activeTab === 'bode' }"
            @click="activeTab = 'bode'"
          >
            频域分析与模型
          </button>
          <button
            type="button"
            class="tab-btn"
            :class="{ active: activeTab === 'sim' }"
            @click="activeTab = 'sim'"
          >
            仿真预测对比
          </button>
        </div>

        <div class="tabs-actions">
          <button
            type="button"
            class="btn-setting-ghost"
            @click="showTopologyWizard = true"
            title="打开控制环路拓扑向导 (FOC/无人机/温控模板、先内后外状态流转与带宽分层校验)"
          >
            环路配置
          </button>
          <button
            v-if="!props.advancedOnly"
            type="button"
            class="btn-setting-ghost"
            @click="openConfig"
            title="配置 Copilot 模型与 API"
          >
            ⚙️ 模型: {{ aiConfig.model || 'deepseek-chat' }}
          </button>
        </div>
      </div>

      <!-- Tab 1: 对话与诊断流 -->
      <div v-show="activeTab === 'chat'" class="copilot-chat-view">
        <div class="chat-message-stream" ref="chatBodyRef">
          <div
            v-for="msg in chatMessages"
            :key="msg.id"
            class="chat-bubble-wrap"
            :class="msg.sender"
          >
            <div class="bubble-header">
              <span class="sender-tag">
                {{ msg.sender === 'user' ? '工程师' : msg.sender === 'copilot' ? 'Copilot 专家' : '系统' }}
              </span>
              <span class="msg-time">{{ new Date(msg.timestamp).toLocaleTimeString() }}</span>
            </div>

            <!-- 气泡文字 -->
            <div class="bubble-text">{{ msg.text }}</div>

            <div
              v-if="msg.validationErrors && msg.validationErrors.length > 0"
              class="message-validation-errors"
              role="status"
              aria-live="polite"
            >
              <div class="validation-title">本地校验拦截</div>
              <div v-for="(err, i) in msg.validationErrors" :key="i" class="error-line">
                ⚠️ {{ err }}
              </div>
            </div>

            <!-- 结构化诊断建议卡片 (任务 2.4 & 2.5) -->
            <div v-if="msg.card" class="diagnosis-card">
              <div class="card-top-row">
                <div class="card-title">🎯 诊断依据与建议</div>
                <div class="card-badges">
                  <!-- 溯源标识 -->
                  <span
                    v-if="msg.card.tool_call_source"
                    class="badge-trace"
                    title="参数数值已由控制工具或理论反算溯源"
                  >
                    溯源: {{ msg.card.tool_call_source }}
                  </span>
                  <span v-else class="badge-untraced" title="数值未标明工具来源">
                    未溯源 ⚠
                  </span>

                  <!-- 风险等级 -->
                  <span class="badge-risk" :class="`risk-${msg.card.risk_level}`">
                    风险: {{ msg.card.risk_level.toUpperCase() }}
                  </span>
                </div>
              </div>

              <!-- 依据列表 -->
              <div class="card-evidence-list">
                <div class="section-label">依据：</div>
                <template v-if="Array.isArray(msg.card.evidence)">
                  <div
                    v-for="(ev, idx) in msg.card.evidence"
                    :key="idx"
                    class="evidence-item"
                  >
                    • {{ ev }}
                  </div>
                </template>
                <div v-else class="evidence-item">• {{ msg.card.evidence }}</div>
              </div>

              <!-- 处置动作建议 -->
              <div class="card-rec-box">
                <span class="section-label">建议：</span>
                <span class="rec-text">{{ msg.card.recommendation }}</span>
              </div>

              <!-- 推荐参数对比 -->
              <div v-if="msg.card.params" class="params-preview-row">
                <span class="param-tag">Kp: {{ msg.card.params.kp }}</span>
                <span class="param-tag">Ki: {{ msg.card.params.ki }}</span>
                <span class="param-tag" :class="{ 'kd-zero': msg.card.params.kd === 0 }">
                  Kd: {{ msg.card.params.kd }} {{ msg.card.params.kd === 0 ? '(拓扑禁用)' : '' }}
                </span>
              </div>

              <!-- 建议指令槽位与动作按钮 (任务 2.5) -->
              <div v-if="msg.card.command" class="command-action-slot">
                <div class="cmd-display-line font-mono">
                  {{ msg.card.command }}
                </div>
                <div class="cmd-buttons-group">
                  <button
                    type="button"
                    class="btn-fill-send"
                    :disabled="!msg.canFillSendArea"
                    @click="handleFillSend(msg.card)"
                    :title="msg.canFillSendArea ? '将此指令填入终端发送区，由人工审查后回车执行' : '安全防线未通过或数值未溯源，禁止填入'"
                  >
                    📥 填入发送区
                  </button>
                  <button
                    type="button"
                    class="btn-save-quick"
                    @click="handleSaveQuick(msg.card)"
                    title="将此推荐指令保存至快捷指令列表"
                  >
                    ⭐ 暂存为快捷指令
                  </button>
                </div>
              </div>

              <!-- 安全提醒条 -->
              <div class="safety-guard-disclaimer">
                <span>🛡️ SafetyGuard 防线介入 · 永远禁止静默自动发送，需人工核准执行</span>
              </div>

            </div>
          </div>
        </div>

        <!-- 底部输入与预置胶囊 -->
        <div class="copilot-input-area">
          <div class="preset-chips-row">
            <span class="preset-label">快捷诊断:</span>
            <button
              type="button"
              class="chip-btn"
              @click="askWithPreset('检测到当前阶跃超调量偏大，请依据速度环阻尼比给出优化参数与指令')"
            >
              ⚡ 阶跃超调诊断
            </button>
            <button
              type="button"
              class="chip-btn"
              @click="askWithPreset('通道存在持续震荡迹象，请分析根因并评估是否需要降低增益')"
            >
              〰 振荡失稳分析
            </button>
            <button
              type="button"
              class="chip-btn"
              @click="askWithPreset('请结合近期错误日志排查固件 HardFault 或断言发生的物理原因')"
            >
              🔍 固件异常排查
            </button>
          </div>

          <div class="input-box-row">
            <input
              type="text"
              class="chat-input"
              v-model="userInput"
              placeholder="向控制理论 Copilot 提问（按 Enter 发送）..."
              @keydown.enter="handleSendQuery"
              :disabled="isThinking"
            />
            <button
              type="button"
              class="btn-chat-send"
              @click="handleSendQuery"
              :disabled="!userInput.trim() || isThinking"
            >
              <span>{{ isThinking ? '分析中...' : '发送' }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Tab 2: 频域 Bode 视图 (任务 3.6) -->
      <div v-show="activeTab === 'bode'" class="copilot-tab-panel">
        <div class="identification-setup">
          <label class="identify-mode-field">
            <span>辨识实验方式</span>
            <select v-model="identificationMode">
              <option value="">请选择</option>
              <option value="open_loop">开环：输出通道作为输入阶跃</option>
              <option value="closed_loop">闭环：设定值阶跃与 PID 模型</option>
            </select>
          </label>
          <div class="identify-binding" v-if="activeLoop">
            输入：{{ identificationInputBinding }}
            <span>→</span>
            反馈：{{ identificationFeedbackBinding }}
          </div>
          <label v-if="identificationMode === 'closed_loop'" class="identify-controller-confirm">
            <input v-model="controllerConfirmed" type="checkbox" :disabled="!activeLoop?.current_params" />
            <span>我确认环路中保存的 PID 参数与本次设备实验一致</span>
          </label>
          <p class="identify-status" role="status">{{ identificationStatus }}</p>
        </div>
        <BodePlotViewer
          :plant="identifiedPlant"
          :plant-origin="identifiedPlantOrigin"
          :sampleTime="activeLoop?.sample_time || 0.001"
          :initialKp="activeLoop?.current_params?.kp"
          :initialKi="activeLoop?.current_params?.ki"
          :initialKd="activeLoop?.current_params?.kd"
          :loopId="activeLoop?.id || 'speed'"
          :loopName="activeLoopName"
          @solved-pid="p => lastSolvedPid = p"
          @update:plant="p => { identifiedPlant = p; identifiedPlantOrigin = 'manual'; }"
          @trigger-identify="autoIdentifyFromCurrentData"
        />
      </div>

      <!-- Tab 3: 仿真预测对比视图 (任务 3.6) -->
      <div v-show="activeTab === 'sim'" class="copilot-tab-panel">
        <SimulationCompareView
          :plant="identifiedPlant"
          :pid="lastSolvedPid"
          :sampleTime="activeLoop?.sample_time || 0.001"
          :stepMetrics="stepMetrics"
          :loopId="activeLoop?.id || 'speed'"
          :loopName="activeLoopName"
          :measured-channel-id="activeLoop?.channels.feedback != null ? String(activeLoop.channels.feedback) : null"
        />
      </div>
    </div>

    <!-- AI 配置 Modal -->
    <div v-if="showConfigModal" class="config-modal-mask" @click="showConfigModal = false">
      <div class="config-modal-panel" @click.stop>
        <div class="modal-header">
          <h3>Copilot 智能体参数配置</h3>
          <button class="btn-close" @click="showConfigModal = false">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Provider 供应商</label>
            <select class="form-select" v-model="editConfig.provider" @change="onProviderChange">
              <option value="deepseek">DeepSeek (官方推荐)</option>
              <option value="openai">OpenAI (GPT-4o)</option>
              <option value="ollama">Ollama (本地私有)</option>
              <option value="custom">Custom (OpenAI Compatible)</option>
            </select>
          </div>
          <div class="form-group">
            <label>API URL</label>
            <input class="form-input font-mono" v-model="editConfig.api_url" />
          </div>
          <div class="form-group">
            <label>API Key {{ editConfig.api_key_configured ? '(已安全保存，留空保持不变)' : '' }}</label>
            <div class="key-input-row">
              <input
                type="password"
                class="form-input font-mono"
                v-model="editConfig.api_key"
                :placeholder="editConfig.api_key_configured ? '已配置；输入新 Key 可替换' : 'sk-...'"
              />
              <button
                v-if="editConfig.api_key_configured"
                type="button"
                class="btn-ghost"
                @click="clearStoredApiKey"
              >清除</button>
            </div>
          </div>
          <div class="form-group">
            <label>模型名称</label>
            <div class="model-row">
              <input class="form-input font-mono" v-model="editConfig.model" />
              <button
                class="btn-fetch"
                :disabled="isFetchingModels"
                @click="handleFetchModels"
              >
                {{ isFetchingModels ? '...' : '拉取' }}
              </button>
            </div>
            <span v-if="fetchModelsError" class="fetch-err">{{ fetchModelsError }}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-ghost" @click="showConfigModal = false">取消</button>
          <button class="btn-save" @click="saveConfig">保存生效</button>
        </div>
      </div>
    </div>

    <!-- 串级多环与控制拓扑向导 (Phase 4 核心) -->
    <LoopTopologyWizard
      :is-open="showTopologyWizard"
      @close="showTopologyWizard = false"
      @applied="showTopologyWizard = false"
    />
  </footer>
</template>

<style scoped>
.copilot-drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 38px; /* 位于底部控制条之上 */
  background: var(--bg-surface, #272623);
  border-top: 2px solid var(--accent-terracotta, #DA7756);
  box-shadow: var(--card-shadow, 0 -8px 30px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  z-index: 40;
  animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background-color 0.25s ease, border-color 0.25s ease;
}
.copilot-drawer.advanced-analysis { top:12px; bottom:12px; left:4%; right:4%; height:auto; border:1px solid var(--border-strong); border-radius:8px; animation:none; box-shadow:var(--card-shadow); z-index:55; }
.advanced-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 20px; border-bottom:1px solid var(--border-subtle); }
.advanced-heading h2 { font-size:16px; margin:0 0 6px; font-weight:600; }.advanced-heading p { font-size:12px; color:var(--text-muted); margin:0; line-height:1.5; }.advanced-heading button { padding:6px 10px; min-height:32px; border:1px solid var(--border-strong); border-radius:5px; background:var(--bg-base); color:var(--text-main); }
.advanced-analysis .expanded-tabs-bar { padding:8px 20px; }.advanced-analysis .tab-btn { font-size:13px; min-height:32px; }

@keyframes slideUp {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.copilot-drawer.is-resizing {
  transition: none;
  user-select: none;
}

/* 顶部拖拽手柄 */
.drawer-resize-handle {
  width: 100%;
  height: 6px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.drawer-resize-handle:hover .resize-bar {
  background: var(--accent-terracotta, #DA7756);
  width: 48px;
}

.resize-bar {
  width: 32px;
  height: 3px;
  background: var(--border-strong, #4A4843);
  border-radius: 2px;
  transition: all 0.2s ease;
}

/* 收起态紧凑单行状态条 */
.drawer-status-bar {
  height: 34px;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-elevated, #2F2E2A);
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle, #383633);
  user-select: none;
  transition: background 0.15s ease;
}

.drawer-status-bar:hover {
  background: var(--bg-surface, #272623);
}

.status-indicators {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
}

.chip-label {
  color: var(--text-muted, #9E9C94);
}

.chip-val {
  font-weight: 600;
}

.chip-obj .chip-val {
  color: var(--accent-terracotta, #DA7756);
}

.chip-good {
  color: #7AA89B;
}

.chip-warn {
  color: #E59E38;
  border-color: rgba(229, 158, 56, 0.3);
}

.chip-cascade {
  cursor: pointer;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  transition: all 0.2s ease;
}

.chip-cascade:hover {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.22));
}

.cascade-wizard-link {
  font-size: 10px;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.2));
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 2px;
}

.chip-alert {
  color: #E06D85;
  border-color: rgba(224, 109, 133, 0.3);
}

.chip-bad {
  color: #E06D85;
  background: rgba(224, 109, 133, 0.12);
  border-color: rgba(224, 109, 133, 0.4);
}

.chip-zero {
  opacity: 0.6;
}

.btn-log-dir {
  background: transparent;
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 4px;
  margin-right: 6px;
  transition: all 0.15s ease;
}

.btn-log-dir:hover {
  color: var(--text-main, #ECEAE4);
  border-color: var(--accent-terracotta, #DA7756);
  background: var(--bg-surface, #272623);
}

.btn-drawer-toggle {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}

.btn-drawer-toggle:hover {
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
}

/* 展开态主体 */
.drawer-expanded-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.expanded-tabs-bar {
  flex-shrink: 0;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.tab-buttons {
  display: flex;
  gap: 4px;
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  color: var(--accent-terracotta, #DA7756);
  font-weight: 600;
}

.copilot-tab-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.identification-setup {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
}

.identify-mode-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.identify-mode-field select {
  max-width: 290px;
  padding: 5px 8px;
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 5px;
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-main, #ECEAE4);
}

.identify-binding {
  display: flex;
  gap: 6px;
  align-items: center;
}

.identify-binding span {
  color: var(--accent-terracotta, #DA7756);
}

.identify-controller-confirm {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.identify-status {
  flex: 1 1 100%;
  margin: 0;
  line-height: 1.4;
}

.btn-setting-ghost {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #94a3b8;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-setting-ghost:hover {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.25);
}

/* 对话流 */
.copilot-chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-message-stream {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-bubble-wrap {
  display: flex;
  flex-direction: column;
  max-width: 90%;
  animation: fadeIn 0.15s ease;
}

.chat-bubble-wrap.user {
  align-self: flex-end;
}

.chat-bubble-wrap.copilot {
  align-self: flex-start;
}

.chat-bubble-wrap.system {
  align-self: center;
  max-width: 95%;
  opacity: 0.8;
}

.bubble-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #64748b;
  margin-bottom: 2px;
}

.bubble-text {
  font-size: 13px;
  line-height: 1.5;
  padding: 8px 12px;
  border-radius: 8px;
  white-space: pre-wrap;
}

.message-validation-errors {
  margin-top: 6px;
  padding: 7px 9px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: 5px;
  background: rgba(239, 68, 68, 0.08);
  color: #fca5a5;
  font-size: 11px;
  line-height: 1.45;
}

.validation-title {
  margin-bottom: 3px;
  font-weight: 600;
  color: #fecaca;
}

.chat-bubble-wrap.user .bubble-text {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
  border-bottom-right-radius: 2px;
}

.chat-bubble-wrap.copilot .bubble-text {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
  border-bottom-left-radius: 2px;
}

.chat-bubble-wrap.system .bubble-text {
  background: var(--bg-surface, #272623);
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  padding: 4px 8px;
}

/* 诊断卡片 */
.diagnosis-card {
  margin-top: 8px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-left: 3px solid var(--accent-terracotta, #DA7756);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: var(--card-shadow, 0 4px 12px rgba(0, 0, 0, 0.2));
}

.card-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-weight: 700;
  font-size: 12px;
  color: var(--accent-terracotta, #DA7756);
}

.card-badges {
  display: flex;
  align-items: center;
  gap: 6px;
}

.badge-trace {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(122, 168, 155, 0.15);
  color: #7AA89B;
  border: 1px solid rgba(122, 168, 155, 0.3);
}

.badge-untraced {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(224, 109, 133, 0.15);
  color: #E06D85;
  border: 1px solid rgba(224, 109, 133, 0.3);
}

.badge-risk {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 600;
}

.badge-risk.risk-low {
  background: rgba(122, 168, 155, 0.15);
  color: #7AA89B;
}

.badge-risk.risk-medium {
  background: rgba(229, 158, 56, 0.15);
  color: #E59E38;
}

.badge-risk.risk-high {
  background: rgba(224, 109, 133, 0.15);
  color: #E06D85;
}

.section-label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  font-weight: 600;
}

.card-evidence-list {
  font-size: 12px;
  color: var(--text-main, #ECEAE4);
  line-height: 1.4;
}

.evidence-item {
  padding-left: 4px;
}

.card-rec-box {
  font-size: 12px;
  color: var(--text-main, #ECEAE4);
  line-height: 1.4;
  background: var(--bg-surface, #272623);
  padding: 6px 8px;
  border-radius: 4px;
}

.params-preview-row {
  display: flex;
  gap: 8px;
}

.param-tag {
  font-size: 11px;
  padding: 2px 6px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 3px;
  font-family: var(--font-mono, monospace);
  color: var(--text-main, #ECEAE4);
}

.param-tag.kd-zero {
  color: var(--accent-terracotta, #DA7756);
}

.command-action-slot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 8px;
}

.cmd-display-line {
  font-size: 12px;
  color: var(--accent-terracotta, #DA7756);
  word-break: break-all;
  font-family: var(--font-mono, monospace);
}

.cmd-buttons-group {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.btn-fill-send {
  background: var(--accent-terracotta, #DA7756);
  color: #fff;
  border: none;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.15s ease;
}

.btn-fill-send:hover:not(:disabled) {
  background: var(--accent-terracotta-hover, #E58565);
}

.btn-fill-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-save-quick {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-main, #ECEAE4);
  border: 1px solid var(--border-subtle, #383633);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-save-quick:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.safety-guard-disclaimer {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  letter-spacing: 0.3px;
}

.card-errors-box {
  font-size: 11px;
  color: #E06D85;
  background: rgba(224, 109, 133, 0.1);
  padding: 4px 8px;
  border-radius: 3px;
}

/* 底部输入栏 */
.copilot-input-area {
  padding: 8px 12px;
  background: var(--bg-elevated, #2F2E2A);
  border-top: 1px solid var(--border-subtle, #383633);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preset-chips-row {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
}

.preset-label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  flex-shrink: 0;
}

.chip-btn {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.chip-btn:hover {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.input-box-row {
  display: flex;
  gap: 8px;
}

.chat-input {
  flex: 1;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.chat-input:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.btn-chat-send {
  background: var(--accent-terracotta, #DA7756);
  color: #fff;
  border: none;
  padding: 0 14px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.15s ease;
}

.btn-chat-send:hover:not(:disabled) {
  background: var(--accent-terracotta-hover, #E58565);
}

.btn-chat-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Bode 视图 */
.copilot-bode-view {
  flex: 1;
  padding: 14px;
  overflow-y: auto;
}

.bode-placeholder-card {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 14px;
}

.bode-desc {
  font-size: 12px;
  color: var(--text-muted, #9E9C94);
  margin-top: 4px;
}

.bode-mock-chart {
  margin: 12px 0;
  padding: 16px;
  background: var(--bg-base, #1F1E1D);
  border: 1px dashed var(--border-subtle, #383633);
  border-radius: 4px;
  text-align: center;
}

.mock-line-title {
  font-size: 12px;
  color: var(--text-muted, #9E9C94);
}

.mock-graph-box {
  display: flex;
  justify-content: center;
  gap: 20px;
  margin-top: 10px;
}

.mock-freq-tag {
  font-size: 11px;
  color: var(--accent-terracotta, #DA7756);
}

.mock-margin-tag {
  font-size: 11px;
  color: #fbbf24;
}

.simulation-compare-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  margin-top: 10px;
}

.table-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 3px;
}

.table-head {
  font-weight: 600;
  color: var(--text-muted, #9E9C94);
  background: transparent;
}

.val-bad {
  color: #E06D85;
  font-weight: 600;
}

.val-good {
  color: #7AA89B;
}

.val-pred {
  color: var(--accent-terracotta, #DA7756);
  font-weight: 600;
}

.val-target {
  color: var(--text-muted, #9E9C94);
}

/* Modal */
.config-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  backdrop-filter: blur(4px);
}

.config-modal-panel {
  width: 420px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--card-shadow, 0 16px 36px rgba(0, 0, 0, 0.4));
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.modal-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  margin: 0;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 18px;
  cursor: pointer;
}

.btn-close:hover {
  color: var(--text-main, #ECEAE4);
}

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.form-input,
.form-select {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}

.form-input:focus,
.form-select:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.key-input-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.key-input-row .form-input {
  flex: 1;
  min-width: 0;
}

.model-row {
  display: flex;
  gap: 6px;
}

.btn-fetch {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
  padding: 0 10px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-fetch:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.fetch-err {
  font-size: 10px;
  color: #E06D85;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle, #383633);
  background: var(--bg-elevated, #2F2E2A);
}

.btn-ghost {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-ghost:hover {
  color: var(--text-main, #ECEAE4);
}

.btn-save {
  background: var(--accent-terracotta, #DA7756);
  color: #fff;
  border: 1px solid var(--accent-terracotta, #DA7756);
  padding: 5px 16px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-save:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
