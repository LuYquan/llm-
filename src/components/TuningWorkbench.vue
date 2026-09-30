<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { AiConfig } from '../services/ai';
import { aiServiceNeedsKey } from '../services/ai';
import { proposeFeedbackCandidate, proposePlantModelDraft } from '../services/tuningAgent';
import { calculateModelCandidate, createCandidateRecord, evaluateResponse, fingerprint, formatTuningParameter, importCapabilityPlan, isActiveParameter, isTrialForPlan, matchesParameterReadback, packagePlan, trialBudgetUsed, tuningPlanSignature, validateCandidate, validateCandidateInputs, validateCapabilityPackage, validatePlan } from '../core/tuning/engine';
import { loadTuningSession, loadTuningStageSession, saveTuningSession } from '../core/tuning/sessionStore';
import type { FeedbackProposal, PidParameter, TuningCapabilityPackage, TuningMetrics, TuningPlan, TuningSession, TuningTrial, ToolExecutionRecord, WriteConfirmationMode } from '../core/tuning/types';
import { SCENARIO_SUITES, createScenarioContext, deriveScenarioPlant, getScenarioPhysicalFields, getScenarioSuite, materializeTransferFunctionDraft, parseTransferFunctionInput, validateCustomStages } from '../core/tuning/scenarios';
import type { ScenarioPhysicalField, ScenarioStage, TransferFunctionDraft, TuningScenarioContext, TuningScenarioId } from '../core/tuning/scenarios';
import type { LoopStructure } from '../core/project/types';
import { globalChannelStore } from '../core/channel/ChannelStore';
import { globalProjectModel } from '../core/project/ProjectModel';
import { isAcknowledgementForWrite, isFreshChannelValue, isWriteResultForTrial } from '../core/tuning/write-correlation';
import { executionSafetyStopReason, manualCandidateEligibility } from '../core/tuning/flow';

type LogLine = { id: number; time: string; at?: number; tag: string; level: string; text: string };
type WriteResult = { id: string; requestId?: string; sessionId?: string; epoch?: number; status: 'queued' | 'written' | 'failed'; at: number; error?: string } | null;

const props = defineProps<{
  connected: boolean;
  demo?: boolean;
  connectionLabel: string;
  aiConfig: AiConfig;
  logs: LogLine[];
  writeResult: WriteResult;
  stopToken: number;
  writeAccessReady: boolean;
  executionEnabled?: boolean;
}>();

const emit = defineEmits<{
  (event: 'send-command', request: { trialId: string; command: string }): void;
  (event: 'execution-state', working: boolean): void;
  (event: 'leave', workspace: 'canvas' | 'tuning'): void;
  (event: 'open-ai-settings'): void;
  (event: 'safety-stop', reason: string): void;
}>();

const assistantPane = ref<'setup' | 'result'>('setup');
const approvalDialog = ref<HTMLDialogElement | null>(null);
const approvalText = ref('');
let approvalResolve: ((approved: boolean) => void) | null = null;

async function requestApproval(text: string): Promise<boolean> {
  if (approvalResolve) return false;
  approvalText.value = text;
  const answer = new Promise<boolean>((resolve) => { approvalResolve = resolve; });
  await nextTick();
  approvalDialog.value?.showModal();
  return answer;
}

function finishApproval(approved: boolean) {
  approvalDialog.value?.close();
  const resolve = approvalResolve;
  approvalResolve = null;
  approvalText.value = '';
  resolve?.(approved);
}
const modelSource = ref<'physical' | 'transfer' | 'ai'>('physical');
const modelBusy = ref(false);
const modelDraft = ref<TransferFunctionDraft | null>(null);
const transferForm = reactive({ numerator: '', denominator: '', delay: '' });
const modelInputErrors = ref<string[]>([]);
const customStages = ref<ScenarioStage[]>([{ id: 'inner', title: '控制环', structure: 'PID', supportedStructures: ['P', 'PI', 'PD', 'PID'] }]);
const channelSettingsOpen = ref(false);
const parameterSettingsOpen = ref(false);
const goalSettingsOpen = ref(false);
const suiteSettingsOpen = ref(false);
const channelIds = ref<string[]>(globalChannelStore.listChannels());
const channelValues = ref<Record<string, { value: number; receivedAt: number; generation: number }>>({});
const clockNow = ref(Date.now());
const isWorking = ref(false);
const stopRequested = ref(false);
const authorizedPlanSignature = ref<string | null>(null);
const aiBusy = ref(false);
const notice = ref<{ type: 'info' | 'warning' | 'error' | 'success'; title: string; body: string } | null>(null);
const proposalErrors = ref<string[]>([]);
const importInput = ref<HTMLInputElement | null>(null);
const pendingTrialId = ref<string | null>(null);
const manualConfirmation = ref(false);
const awaitingManualConfirmation = ref(false);
const autoProgress = ref('');
const channelUnsubscribe = ref<(() => void) | null>(null);
const channelListUnsubscribe = ref<(() => void) | null>(null);
let sessionPersistTimer: number | null = null;
let freshnessTimer: number | null = null;
let observedChannelGeneration = globalChannelStore.getGeneration();

const activeLoop = computed(() => globalProjectModel.getLoop(plan.value.loopId));

function newPlan(): TuningPlan {
  return {
    id: id(),
    version: 1,
    name: '新建场景调参',
    project: '',
    description: '',
    prompt: '',
    route: 'feedback',
    mode: 'manual',
    loopId: '',
    structure: 'PID',
    controlDirection: null,
    sampleTimeSeconds: null,
    commandTemplate: '',
    baseline: { params: null, source: 'unset', confirmed: false, stableBaseConfirmed: false },
    bounds: { kp: null, ki: null, kd: null },
    maxParameterChangePercent: null,
    maximumTrials: null,
    evaluationWindowSeconds: null,
    maximumTelemetryAgeSeconds: null,
    maximumOutputMagnitude: null,
    channels: { setpoint: '', feedback: '', output: '', parameters: {} },
    units: { setpoint: '', feedback: '', output: '', parameters: {} },
    confirmation: { mode: 'manual', acknowledgementText: '', timeoutSeconds: null, parameterTolerance: null },
    goal: {
      mode: 'settle',
      maximumSteadyError: null,
      maximumOvershootPct: null,
      maximumTrackingError: null,
      targetPhaseMarginDeg: null,
      targetCrossoverRadPerSec: null,
    },
    model: null,
  };
}

function hydratePlan(value: TuningPlan): TuningPlan {
  const base = newPlan();
  const next = { ...base, ...value };
  next.baseline = { ...base.baseline, ...value.baseline };
  next.bounds = { ...base.bounds, ...value.bounds };
  next.channels = { ...base.channels, ...value.channels, parameters: { ...base.channels.parameters, ...value.channels?.parameters } };
  next.units = { ...base.units, ...value.units, parameters: { ...base.units.parameters, ...value.units?.parameters } };
  next.confirmation = { ...base.confirmation, ...value.confirmation };
  next.goal = { ...base.goal, ...value.goal };
  next.controlDirection = value.controlDirection ?? null;
  next.commandTemplate = value.commandTemplate ?? globalProjectModel.getLoop(next.loopId)?.cmd_template ?? '';
  next.model = value.model ?? null;
  return next;
}

const loaded = loadTuningSession();
const initialPlan = loaded ? hydratePlan(loaded.plan) : newPlan();
const plan = ref<TuningPlan>(initialPlan);
const session = ref<TuningSession>(loaded ? {
  ...loaded,
  plan: initialPlan,
  trials: loaded.trials.map((trial) => trial.status === 'sent'
    ? { ...trial, status: 'queued', confirmation: '旧版本的“已发送”状态没有驱动写入回执，无法证明写入完成。' }
    : trial),
  status: ['awaiting-confirmation', 'collecting', 'ready'].includes(loaded.status) ? 'paused' : loaded.status,
  stopReason: ['awaiting-confirmation', 'collecting', 'ready'].includes(loaded.status)
    ? '软件重新启动后实验已暂停。请确认设备状态，再手动恢复。'
    : loaded.stopReason,
} : {
  id: id(),
  plan: initialPlan,
  status: 'draft',
  trials: [],
  bestVerified: null,
  lastConfirmed: null,
  startedAt: null,
  updatedAt: Date.now(),
  stopReason: null,
});
session.value.plan = plan.value;

const parameterForm = reactive({
  kp: initialPlan.baseline.params?.kp.toString() ?? '',
  ki: initialPlan.baseline.params?.ki.toString() ?? '',
  kd: initialPlan.baseline.params?.kd.toString() ?? '',
});

session.value.scenarioGroupId ??= session.value.id;

function captureFormDraft() {
  session.value.formDraft = { modelSource: modelSource.value, ...transferForm, parameters: { ...parameterForm } };
}

function restoreFormDraft() {
  loadModelFormFromPlan();
  modelDraft.value = plan.value.suite?.modelDraft ?? null;
  modelSource.value = plan.value.suite?.modelOrigin === 'ai-proposal' ? 'ai' : plan.value.suite?.modelOrigin === 'user-transfer-function' || plan.value.suite?.id === 'custom' ? 'transfer' : 'physical';
  const form = session.value.formDraft;
  if (form) {
    modelSource.value = form.modelSource;
    Object.assign(transferForm, { numerator: form.numerator, denominator: form.denominator, delay: form.delay });
    Object.assign(parameterForm, form.parameters);
  } else {
    for (const key of ['kp', 'ki', 'kd'] as const) parameterForm[key] = plan.value.baseline.params?.[key].toString() ?? '';
  }
}

function archiveCurrentStage() {
  captureFormDraft();
  session.value.updatedAt = Date.now();
  if (!saveTuningSession(session.value)) setNotice('warning', '环节草稿未保存', '本地保存失败，请先导出当前套组。');
}

const activeParameters = computed(() => (['kp', 'ki', 'kd'] as PidParameter[]).filter((key) => isActiveParameter(plan.value.structure, key)));
const planErrors = computed(() => validatePlan(plan.value));
const candidateErrors = computed(() => validateCandidateInputs(plan.value));
const selectedSuite = computed(() => plan.value.suite ? getScenarioSuite(plan.value.suite.id) : null);
const selectedTopology = computed(() => selectedSuite.value?.topologies.find((item) => item.id === plan.value.suite?.topologyId));
const sceneStages = computed(() => plan.value.suite?.id === 'custom' ? customStages.value : selectedTopology.value?.stages ?? []);
const selectedStage = computed(() => sceneStages.value.find((item) => item.id === plan.value.suite?.stageId));
const physicalModelResult = computed(() => plan.value.suite ? deriveScenarioPlant(plan.value.suite.id, plan.value.suite.topologyId, plan.value.suite.stageId, plan.value.suite.physicalInputs) : null);
const stageErrors = computed(() => plan.value.suite?.id === 'custom' ? validateCustomStages(customStages.value) : []);
const modelFieldInputs = computed<ScenarioPhysicalField[]>(() => modelSource.value === 'ai' && modelDraft.value ? modelDraft.value.physicalFields : plan.value.suite ? getScenarioPhysicalFields(plan.value.suite.id, plan.value.suite.stageId) : []);
const aiConfigured = computed(() => Boolean(props.aiConfig.model && (!aiServiceNeedsKey(props.aiConfig) || props.aiConfig.api_key?.trim() || props.aiConfig.api_key_configured)));
const liveStatus = computed(() => props.connected ? props.demo ? '演示会话 · 模拟遥测' : '已连接 · 正在接收遥测' : '未连接 · 不能开展实机试验');
const liveChannelOptions = computed(() => channelIds.value);
const mostRecentTelemetry = computed(() => Math.max(0, ...Object.values(channelValues.value).map((item) => item.receivedAt)));
const telemetryAge = computed(() => mostRecentTelemetry.value ? (clockNow.value - mostRecentTelemetry.value) / 1000 : null);
const latestSummary = computed(() => {
  const bindings = plan.value.channels;
  return [
    { key: '目标', channel: bindings.setpoint },
    { key: '实际反馈', channel: bindings.feedback },
    { key: '控制输出', channel: bindings.output },
  ].map((item) => ({ ...item, reading: channelValues.value[item.channel] }));
});
const currentParams = computed(() => session.value.lastConfirmed?.params ?? plan.value.baseline.params);
const currentParamsLabel = computed(() => session.value.lastConfirmed
  ? confirmationLabel(session.value.lastConfirmed.mode)
  : plan.value.baseline.confirmed ? '用户确认的当前参数' : '未确认设备当前值');
const currentProposal = computed(() => session.value.trials.find((trial) => trial.id === pendingTrialId.value));
const proposalRationale = computed(() => {
  const proposal = currentProposal.value;
  if (!proposal) return '';
  // 解释保留验证方法；完整精度仍保存在候选和命令中，不在说明段重复参数表。
  return proposal.evidence?.tool === 'pid-solver'
    ? proposal.note.replace(/[：:]\s*Kp=[\s\S]*$/, '。')
    : proposal.note;
});
const openIssues = computed(() => {
  const issues = [...planErrors.value];
  if (props.executionEnabled !== true) issues.push('参数执行未就绪：开启设备采集、配置设备停止命令，并解除软件停止。');
  if (!props.connected) issues.push('连接设备后才能发送参数与采集试验数据。');
  else if (!telemetryFresh()) issues.push('等待绑定通道的实时遥测更新后再开始试验。');
  return issues.slice(0, 3);
});
const experimentCanStart = computed(() => props.executionEnabled === true && props.connected && telemetryFresh() && planErrors.value.length === 0 && !isWorking.value && session.value.status !== 'completed');
const canProposeCandidate = computed(() => manualCandidateEligibility({
  planErrorCount: candidateErrors.value.length,
  isWorking: isWorking.value,
  sessionStatus: session.value.status,
  route: plan.value.route,
  connected: props.connected,
  telemetryFresh: telemetryFresh(),
}).allowed);

watch(plan, (next) => {
  session.value.plan = next;
  session.value.updatedAt = Date.now();
  if (!sessionPersistTimer) {
    sessionPersistTimer = window.setTimeout(() => {
      captureFormDraft();
      const saved = saveTuningSession(session.value);
      if (!saved) setNotice('warning', '草稿暂未保存', '本地空间不足或访问失败。请先导出套件保存当前配置。');
      sessionPersistTimer = null;
    }, 350);
  }
}, { deep: true });

watch([transferForm, parameterForm, modelSource], () => {
  if (!sessionPersistTimer) sessionPersistTimer = window.setTimeout(() => {
    archiveCurrentStage();
    sessionPersistTimer = null;
  }, 350);
}, { deep: true });

// 轮次与确认可能在计划最后一次编辑之后才更新，必须单独保存。
// 不观察 formDraft/updatedAt，避免保存本身再次排队而形成空转循环。
watch(() => [session.value.trials, session.value.status, session.value.lastConfirmed,
  session.value.bestVerified, session.value.stopReason], () => {
  if (!sessionPersistTimer) sessionPersistTimer = window.setTimeout(() => {
    archiveCurrentStage();
    sessionPersistTimer = null;
  }, 350);
}, { deep: true });

watch(() => props.writeResult, (result) => {
  if (!result || result.id !== pendingTrialId.value) return;
  const trial = findTrial(result.id);
  if (!trial) return;
  // A successful/queued result must carry the transport request id. Without it
  // a late result from an earlier attempt could advance this trial by id alone.
  if (result.status !== 'failed' && !isWriteResultForTrial({
    trialId: result.id,
    requestId: result.requestId,
    sessionId: result.sessionId,
    epoch: result.epoch,
    status: result.status,
  }, trial.id, trial.writeRequestId)) return;
  if (result.requestId) trial.writeRequestId = result.requestId;
  trial.writeSessionId = result.sessionId;
  trial.writeEpoch = result.epoch;
  if (stopRequested.value) {
    trial.status = 'failed';
    trial.confirmation = `停止后收到驱动回执：${result.status}；设备状态需重新核对。`;
    return;
  }
  if (result.status === 'failed') {
    trial.status = 'failed';
    requestSafetyStop(result.error || '参数写入失败，设备可能收到部分字节。');
    return;
  }
  if (result.status === 'queued') {
    trial.status = 'queued';
    requestSafetyStop('参数命令仅已排队，驱动写入状态尚不可用。');
    return;
  }
  trial.status = 'sent';
  trial.command = trial.command || '';
  const writeGeneration = globalChannelStore.getGeneration();
  // A disconnect/reconnect during an in-flight write must invalidate the
  // receipt. Keeping the generation captured before sending prevents samples
  // from the new session being used as confirmation for the old command.
  if (trial.writeChannelGeneration !== undefined && writeGeneration !== trial.writeChannelGeneration) {
    trial.status = 'failed';
    session.value.status = 'paused';
    session.value.stopReason = '串口会话在写入完成前发生变化；本轮命令未进入确认或评价。';
    setNotice('warning', '命令确认已失效', session.value.stopReason);
    return;
  }
  trial.writeCompletedAt = result.at;
  trial.writeChannelGeneration = writeGeneration;
  session.value.status = 'awaiting-confirmation';
  trial.confirmation = '串口写入已完成；等待设备回传或应答。';
  session.value.updatedAt = Date.now();
}, { deep: true });

watch(() => props.stopToken, (token, previous) => {
  if (token !== previous && isWorking.value) requestStop('设备紧急操作已触发，调参循环暂停。');
});

watch(isWorking, (working) => emit('execution-state', working), { flush: 'sync' });

watch(() => props.connected, (connected) => {
  invalidateDeviceContext();
  if (!connected) {
    channelValues.value = {};
    if (isWorking.value) requestSafetyStop('串口断开，设备停止字节可能无法送达。');
  }
});

watch(() => props.executionEnabled, (enabled) => {
  if (enabled !== true && (isWorking.value || ['awaiting-confirmation', 'collecting'].includes(session.value.status))) requestStop('采集、设备保护或会话执行条件已变化；调参流程暂停。');
});

watch(() => [plan.value.channels, plan.value.confirmation.mode, plan.value.confirmation.acknowledgementText], () => refreshSubscription(), { deep: true });

onMounted(() => {
  restoreFormDraft();
  if (plan.value.suite?.customStages?.length) customStages.value = plan.value.suite.customStages.map((stage) => ({ ...stage, supportedStructures: [...stage.supportedStructures] }));
  freshnessTimer = window.setInterval(() => {
    clockNow.value = Date.now();
    if (observedChannelGeneration !== globalChannelStore.getGeneration()) invalidateDeviceContext();
    checkExecutionSafety();
  }, 250);
  channelListUnsubscribe.value = globalChannelStore.onChannelsChanged((ids) => {
    channelIds.value = ids;
    refreshSubscription();
  });
  refreshSubscription();
});

onUnmounted(() => {
  finishApproval(false);
  channelUnsubscribe.value?.();
  channelListUnsubscribe.value?.();
  if (sessionPersistTimer) window.clearTimeout(sessionPersistTimer);
  if (freshnessTimer) window.clearInterval(freshnessTimer);
});

function refreshSubscription() {
  channelUnsubscribe.value?.();
  const p = plan.value;
  const ids = [p.channels.setpoint, p.channels.feedback, p.channels.output, ...Object.values(p.channels.parameters)].filter(Boolean);
  if (ids.length) channelUnsubscribe.value = globalChannelStore.subscribe([...new Set(ids)], (batch) => {
    const receivedAt = Date.now();
    for (const channel of batch.updatedChannelIds) {
      const latest = batch.latest[channel];
      if (latest && Number.isFinite(latest.v)) {
      channelValues.value[channel] = {
        value: latest.v,
        receivedAt: batch.updatedAtMs[channel] ?? receivedAt,
        generation: batch.generation,
      };
      }
    }
  }, { fps: 10, immediate: true });
}

function setNotice(type: NonNullable<typeof notice.value>['type'], title: string, body: string) {
  notice.value = { type, title, body };
}

function selectScenario(scenarioId: TuningScenarioId) {
  if (isWorking.value || aiBusy.value || modelBusy.value) return;
  const suite = getScenarioSuite(scenarioId);
  if (!suite) return;
  archiveCurrentStage();
  const topology = suite.topologies[0];
  const stages = scenarioId === 'custom' ? customStages.value : topology.stages;
  const context = createScenarioContext(scenarioId, topology.id, stages[0].id, scenarioId === 'custom' ? stages : undefined);
  const next = newPlan();
  next.suite = context;
  next.name = `${suite.title}调参`;
  next.project = suite.title;
  next.loopId = stages[0].id;
  next.structure = stages[0].structure;
  next.mode = 'bounded-auto';
  next.confirmation.mode = 'parameter-channels';
  plan.value = next;
  session.value = { id: id(), plan: next, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null };
  session.value.scenarioGroupId = session.value.id;
  parameterForm.kp = parameterForm.ki = parameterForm.kd = '';
  pendingTrialId.value = null;
  modelDraft.value = null;
  modelInputErrors.value = [];
  modelSource.value = scenarioId === 'custom' ? 'transfer' : 'physical';
  transferForm.numerator = transferForm.denominator = transferForm.delay = '';
  assistantPane.value = 'setup';
  notice.value = null;
}

function selectTopology(topologyId: string) {
  if (!plan.value.suite || !selectedSuite.value || isWorking.value) return;
  const topology = selectedSuite.value.topologies.find((item) => item.id === topologyId);
  if (!topology) return;
  archiveCurrentStage();
  const stages = plan.value.suite.id === 'custom' ? customStages.value : topology.stages;
  const context = createScenarioContext(plan.value.suite.id, topologyId, stages[0].id, plan.value.suite.id === 'custom' ? stages : undefined);
  context.physicalInputs = { ...plan.value.suite.physicalInputs };
  activateStage(context);
}

function selectStage(stageId: string) {
  if (!plan.value.suite || isWorking.value) return;
  const stage = sceneStages.value.find((item) => item.id === stageId);
  if (!stage) return;
  if (stageId === plan.value.suite.stageId) return;
  archiveCurrentStage();
  const context = createScenarioContext(plan.value.suite.id, plan.value.suite.topologyId, stageId, plan.value.suite.id === 'custom' ? customStages.value : undefined);
  context.physicalInputs = { ...plan.value.suite.physicalInputs };
  activateStage(context);
}

function activateStage(context: TuningScenarioContext) {
  const prior = plan.value;
  const groupId = session.value.scenarioGroupId ?? session.value.id;
  const restored = loadTuningStageSession(groupId, context.id, context.topologyId, context.stageId);
  const next = restored?.plan ?? { ...newPlan(), name: prior.name, project: prior.project, description: prior.description, prompt: prior.prompt, route: prior.route, mode: prior.mode, suite: context, loopId: context.stageId };
  if (!restored) next.structure = (context.id === 'custom' ? customStages.value : selectedSuite.value?.topologies.find((topology) => topology.id === context.topologyId)?.stages)?.find((stage) => stage.id === context.stageId)?.structure ?? 'PID';
  if (next.suite?.id === 'custom') next.suite.customStages = customStages.value.map((stage) => ({ ...stage, supportedStructures: [...stage.supportedStructures] }));
  plan.value = next;
  session.value = restored ?? { id: id(), scenarioGroupId: groupId, plan: next, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null };
  pendingTrialId.value = null;
  manualConfirmation.value = false;
  stopRequested.value = false;
  authorizedPlanSignature.value = null;
  modelInputErrors.value = [];
  restoreFormDraft();
  if (!restored && modelSource.value === 'physical') syncPhysicalModel();
  setNotice('info', restored ? '已恢复这个环节的草稿' : '当前环节已切换', '各环节的模型、配置和记录分别保存。重新核对模型与设备基线后才能执行；先验收内环，再处理外环。');
}

function setRoute(route: 'feedback' | 'model') {
  plan.value.route = route;
  plan.value.mode = route === 'feedback' ? 'bounded-auto' : 'manual';
  if (route === 'feedback' && plan.value.confirmation.mode === 'manual') plan.value.confirmation.mode = 'parameter-channels';
}

function setModelSource(source: 'physical' | 'transfer' | 'ai') {
  modelSource.value = source;
  plan.value.model = null;
  if (plan.value.suite) { plan.value.suite.modelConfirmed = false; plan.value.suite.assumptions = []; }
  modelInputErrors.value = [];
  if (source === 'physical') syncPhysicalModel();
  if (source === 'transfer') updateTransferModel();
  if (source === 'ai') updateDraftModel();
}

function setPhysicalInput(fieldId: string, raw: string) {
  if (!plan.value.suite) return;
  plan.value.suite.physicalInputs[fieldId] = parseOptionalNumber(raw);
  plan.value.suite.modelConfirmed = false;
  if (modelSource.value === 'ai') updateDraftModel();
  else syncPhysicalModel();
}

function syncPhysicalModel() {
  const context = plan.value.suite;
  if (!context) return;
  const result = deriveScenarioPlant(context.id, context.topologyId, context.stageId, context.physicalInputs);
  plan.value.model = result.model;
  context.assumptions = [...result.assumptions];
  context.modelOrigin = result.model ? 'physical-inputs' : 'pending';
  modelInputErrors.value = result.warnings;
}

function updateTransferModel(field?: keyof typeof transferForm, raw?: string) {
  if (field && raw !== undefined) transferForm[field] = raw;
  if (!plan.value.suite) return;
  plan.value.suite.modelConfirmed = false;
  const delay = parseOptionalNumber(transferForm.delay);
  if (delay === null) {
    plan.value.model = null;
    modelInputErrors.value = transferForm.numerator || transferForm.denominator ? ['填写并确认模型纯延迟；无延迟时明确填 0。'] : [];
    return;
  }
  const result = parseTransferFunctionInput(transferForm.numerator, transferForm.denominator, delay);
  plan.value.model = result.model;
  plan.value.suite.modelOrigin = result.model ? 'user-transfer-function' : 'pending';
  plan.value.suite.assumptions = ['用户提供的 s 域线性模型，仅适用于用户核对的工况和输入输出单位。'];
  modelInputErrors.value = result.errors;
}

function updateDraftModel() {
  if (!plan.value.suite || !modelDraft.value) return;
  const result = materializeTransferFunctionDraft(modelDraft.value, plan.value.suite.physicalInputs);
  plan.value.model = result.model;
  plan.value.suite.modelOrigin = result.model ? 'ai-proposal' : 'pending';
  plan.value.suite.assumptions = [...modelDraft.value.assumptions];
  modelInputErrors.value = [...result.pendingInputs.map((label) => `待填写：${label}`), ...result.warnings];
}

async function deriveWithAi() {
  if (!plan.value.suite || !plan.value.description.trim()) {
    setNotice('warning', '先说明对象与工况', '描述执行器、传感器、输入输出和所控制的运动或过程；AI 将据此提出可核对的模型草稿。');
    return;
  }
  if (!await requestApproval(`将对象描述、当前场景和补充提示词发送给 AI 服务，用于生成模型草稿及物理输入表。\n\n服务：${props.aiConfig.api_url}\n模型：${props.aiConfig.model}\n\n请核对接收方与待发送描述。`)) return;
  modelBusy.value = true;
  const scope = tuningPlanSignature(plan.value);
  try {
    const draft = await proposePlantModelDraft({ config: props.aiConfig, description: plan.value.description, prompt: plan.value.prompt, suite: plan.value.suite });
    if (tuningPlanSignature(plan.value) !== scope) {
      setNotice('warning', '模型草稿已失效', '对象或场景配置已变化，请重新请求模型推导。');
      return;
    }
    modelDraft.value = draft;
    plan.value.suite.modelDraft = draft;
    plan.value.suite.modelConfirmed = false;
    updateDraftModel();
    setNotice('info', '请核对模型草稿', '填写模型列出的物理参数，并核对方程、单位和假设；确认前不会计算 PID 候选。');
  } catch (error) {
    setNotice('error', '模型推导没有完成', error instanceof Error ? error.message : String(error));
  } finally {
    modelBusy.value = false;
  }
}

function updateCustomStage(stageId: string, field: 'title' | 'structure', value: string) {
  const stage = customStages.value.find((item) => item.id === stageId);
  if (!stage || !plan.value.suite) return;
  if (field === 'title') stage.title = value;
  else stage.structure = value as LoopStructure;
  plan.value.suite.customStages = customStages.value.map((item) => ({ ...item, supportedStructures: [...item.supportedStructures] }));
  if (stageId === plan.value.suite.stageId && field === 'structure') handleStructureChange(stage.structure);
}

function addCustomStage() {
  if (!plan.value.suite || customStages.value.length >= 4) return;
  customStages.value.push({ id: `loop-${id()}`, title: `外环 ${customStages.value.length}`, structure: 'PI', supportedStructures: ['P', 'PI', 'PD', 'PID'] });
  plan.value.suite.customStages = customStages.value.map((stage) => ({ ...stage, supportedStructures: [...stage.supportedStructures] }));
  plan.value.suite.topologyId = 'cascade';
}

function removeCustomStage(stageId: string) {
  if (!plan.value.suite || customStages.value.length <= 1) return;
  customStages.value = customStages.value.filter((stage) => stage.id !== stageId);
  plan.value.suite.customStages = customStages.value.map((stage) => ({ ...stage, supportedStructures: [...stage.supportedStructures] }));
  if (customStages.value.length === 1) plan.value.suite.topologyId = 'single';
  if (plan.value.suite.stageId === stageId) selectStage(customStages.value[0].id);
}

function setBound(key: PidParameter, field: 'min' | 'max', raw: string) {
  const value = parseOptionalNumber(raw);
  const current = plan.value.bounds[key];
  plan.value.bounds[key] = value === null && !current ? null : { min: current?.min ?? 0, max: current?.max ?? 0, [field]: value ?? 0 };
}

function syncManualParams(changedKey?: PidParameter, rawValue?: string) {
  session.value.lastConfirmed = null;
  // Keep this field in sync explicitly. Native number-input `v-model` may
  // update after the sibling @input handler runs, leaving the first completed
  // manual baseline looking empty until the user edits another field.
  if (changedKey && rawValue !== undefined) parameterForm[changedKey] = rawValue;
  const params = {
    kp: isActiveParameter(plan.value.structure, 'kp') ? parseOptionalNumber(parameterForm.kp) : 0,
    ki: isActiveParameter(plan.value.structure, 'ki') ? parseOptionalNumber(parameterForm.ki) : 0,
    kd: isActiveParameter(plan.value.structure, 'kd') ? parseOptionalNumber(parameterForm.kd) : 0,
  };
  plan.value.baseline.params = activeParameters.value.every((key) => params[key] !== null)
    ? { kp: params.kp as number, ki: params.ki as number, kd: params.kd as number }
    : null;
  plan.value.baseline.source = plan.value.baseline.params ? 'manual' : 'unset';
  plan.value.baseline.confirmed = false;
  plan.value.baseline.stableBaseConfirmed = false;
}

function handleStructureChange(structure: LoopStructure) {
  plan.value.structure = structure;
  if (plan.value.suite?.id === 'custom') {
    const stage = customStages.value.find((item) => item.id === plan.value.suite?.stageId);
    if (stage) stage.structure = structure;
    plan.value.suite.customStages = customStages.value.map((item) => ({ ...item, supportedStructures: [...item.supportedStructures] }));
  }
  for (const key of ['kp', 'ki', 'kd'] as PidParameter[]) {
    if (!isActiveParameter(structure, key)) {
      parameterForm[key] = '0';
      plan.value.bounds[key] = { min: 0, max: 0 };
    }
  }
  syncManualParams();
}

function readParametersFromChannels() {
  const values: Partial<Record<PidParameter, number>> = {};
  for (const key of activeParameters.value) {
    const channel = plan.value.channels.parameters[key];
    const item = channel ? channelValues.value[channel] : undefined;
    if (!item || item.generation !== globalChannelStore.getGeneration() || !plan.value.maximumTelemetryAgeSeconds || (Date.now() - item.receivedAt) / 1000 > plan.value.maximumTelemetryAgeSeconds) {
      setNotice('warning', '参数通道尚未就绪', `先绑定并接收当前会话的新鲜参数数据。请核对 ${key.toUpperCase()}。`);
      return;
    }
    values[key] = item.value;
  }
  plan.value.baseline.params = {
    kp: values.kp ?? 0,
    ki: values.ki ?? 0,
    kd: values.kd ?? 0,
  };
  session.value.lastConfirmed = null;
  plan.value.baseline.source = 'parameter-channels';
  plan.value.baseline.confirmed = false;
  plan.value.baseline.stableBaseConfirmed = false;
  parameterForm.kp = String(plan.value.baseline.params.kp);
  parameterForm.ki = String(plan.value.baseline.params.ki);
  parameterForm.kd = String(plan.value.baseline.params.kd);
}

function currentReadback(trial?: TuningTrial): Partial<Record<PidParameter, number>> {
  const values: Partial<Record<PidParameter, number>> = {};
  const correlation = trial && trial.writeCompletedAt !== undefined && trial.writeChannelGeneration !== undefined
    ? { completedAt: trial.writeCompletedAt, channelGeneration: trial.writeChannelGeneration }
    : null;
  for (const key of activeParameters.value) {
    const channel = plan.value.channels.parameters[key];
    const item = channel ? channelValues.value[channel] : undefined;
    if (item && correlation && isFreshChannelValue(item, correlation)) values[key] = item.value;
  }
  return values;
}

function toggleConfirmationMode(mode: WriteConfirmationMode) {
  plan.value.confirmation.mode = mode;
  if (mode === 'manual') plan.value.mode = 'manual';
}

function renderCommandTemplate(params: { kp: number; ki: number; kd: number }, protocolRequestId: string): string | null {
  if (!plan.value.commandTemplate.trim()) return null;
  const loop = activeLoop.value;
  return plan.value.commandTemplate
    .replace(/{order}/g, String(loop?.order ?? Math.max(0, sceneStages.value.findIndex((item) => item.id === plan.value.suite?.stageId))))
    .replace(/{id}/g, plan.value.loopId)
    .replace(/{kp}/g, formatTuningParameter(params.kp))
    .replace(/{ki}/g, formatTuningParameter(params.ki))
    .replace(/{kd}/g, formatTuningParameter(params.kd))
    .replace(/{request_id}/g, protocolRequestId);
}

function executionPlanSignature(): string {
  const { baseline, ...executionPlan } = plan.value;
  // Candidate writes legitimately advance the baseline. Keep the preflight
  // stability attestation inside the authorization scope.
  return JSON.stringify({ ...executionPlan, baselineStableBaseConfirmed: baseline.stableBaseConfirmed });
}

async function proposeCandidate(aiTransferAlreadyAuthorized = false): Promise<TuningTrial | null> {
  if (candidateErrors.value.length || stageErrors.value.length) {
    proposalErrors.value = [...candidateErrors.value, ...stageErrors.value];
    setNotice('warning', '暂时不能生成候选', proposalErrors.value[0]);
    return null;
  }
  if (plan.value.route === 'feedback' && (!props.connected || !telemetryFresh())) {
    setNotice('warning', '遥测数据尚未就绪', '连接设备并确保绑定通道的数值更新时间在设定范围内。');
    return null;
  }
  const before = currentParams.value ?? (plan.value.route === 'model' ? { kp: 0, ki: 0, kd: 0 } : null);
  if (!before) return null;
  const capturedPlanSignature = tuningPlanSignature(plan.value);
  const capturedGeneration = globalChannelStore.getGeneration();
  let proposal: FeedbackProposal;
  let evidence: ToolExecutionRecord;
  if (plan.value.route === 'model') {
    if (!plan.value.model) {
      setNotice('warning', '物理模型信息不完整', '请提供对象增益、时间常数、延迟及适用的工作点，再运行模型计算。');
      return null;
    }
    const result = calculateModelCandidate(plan.value.model, plan.value);
    if (!result.params || !result.result.success) {
      setNotice('warning', '当前模型无法求解', result.result.message || '请检查模型参数、结构和目标。');
      return null;
    }
    proposal = { params: result.params, rationale: result.result.message };
    evidence = {
      id: id(),
      tool: 'pid-solver',
      executedAt: Date.now(),
      inputFingerprint: await fingerprint({ model: plan.value.model, goal: plan.value.goal, sampleTime: plan.value.sampleTimeSeconds, structure: plan.value.structure }),
      result: result.params,
      summary: result.result.message,
      planSignature: capturedPlanSignature,
    };
  } else {
    const measured = readMetrics();
    if (!measured.metrics) {
      setNotice('warning', '实测数据不足', measured.message);
      return null;
    }
    const planWithoutSending = JSON.parse(JSON.stringify(plan.value)) as TuningPlan;
    const authorized = aiTransferAlreadyAuthorized || await requestApproval(`AI 将向 ${props.aiConfig.api_url} 发送以下摘要：项目/控制结构、当前参数、目标、约束和遥测统计。\n\n请确认接收方与发送范围，再请求候选。`);
    if (!authorized) return null;
    if (capturedPlanSignature !== tuningPlanSignature(plan.value) || capturedGeneration !== globalChannelStore.getGeneration()) {
      setNotice('warning', '请求范围已变化', '设备会话或配置已变化，请重新核对基线后请求候选。');
      return null;
    }
    aiBusy.value = true;
    try {
      const result = await proposeFeedbackCandidate({ config: props.aiConfig, plan: planWithoutSending, params: before, metrics: measured.metrics });
      proposal = result.proposal;
      evidence = result.record;
    } catch (error) {
      setNotice('error', '没有生成候选值', error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      aiBusy.value = false;
    }
  }
  if (capturedPlanSignature !== tuningPlanSignature(plan.value) || evidence.planSignature !== capturedPlanSignature || capturedGeneration !== globalChannelStore.getGeneration()) {
    setNotice('warning', '候选已失效', '模型、约束或场景配置在请求期间发生变化。请重新生成候选。');
    return null;
  }
  if (isWorking.value && (!authorizedPlanSignature.value || executionPlanSignature() !== authorizedPlanSignature.value)) {
    requestStop('实验配置在执行期间发生变化；本轮不会继续下发。');
    return null;
  }
  if (isWorking.value && stopRequested.value) return null;
  const checked = plan.value.route === 'model' ? { valid: true, errors: [] } : validateCandidate(proposal.params, plan.value, before);
  proposalErrors.value = checked.errors;
  if (!checked.valid) {
    setNotice('error', '候选超出约束', checked.errors.join(' '));
    return null;
  }
  const trial = createCandidateRecord(proposal.params, plan.value, before, proposal.rationale);
  trial.sourceChannelGeneration = capturedGeneration;
  trial.evidence = evidence;
  trial.protocolRequestId = trial.id;
  trial.command = renderCommandTemplate(trial.candidate, trial.protocolRequestId) ?? undefined;
  session.value.trials.unshift(trial);
  pendingTrialId.value = trial.id;
  manualConfirmation.value = false;
  session.value.status = 'ready';
  session.value.updatedAt = Date.now();
  setNotice('success', plan.value.route === 'model' ? '模型计算已完成' : 'AI 候选已通过本地约束', '参数仍需人工确认或授权实验执行器下发。');
  if (!isWorking.value) assistantPane.value = 'result';
  return trial;
}

async function sendTrial(trial: TuningTrial, auto = false): Promise<boolean> {
  if (props.executionEnabled !== true) {
    setNotice('warning', '调参执行暂不可用', '候选生成和审阅可用；参数写入在驱动写入回执与本轮设备确认完成关联前保持禁用。');
    return false;
  }
  if (trial.status !== 'proposed' || !trial.command) return false;
  const executionErrors = validatePlan(plan.value);
  if (executionErrors.length || !isTrialForPlan(trial, plan.value, globalChannelStore.getGeneration())) {
    setNotice('warning', '下发条件已变化', executionErrors[0] || '候选生成后配置已变化，请重新生成并核对候选。');
    return false;
  }
  if (auto && (stopRequested.value || !isWorking.value || !authorizedPlanSignature.value || executionPlanSignature() !== authorizedPlanSignature.value)) {
    requestStop('实验配置或停止状态已变化；参数命令未下发。');
    return false;
  }
  if (auto && !props.writeAccessReady) {
    setNotice('warning', '等待串口写入权切换', '普通控件命令尚未完成排空，自动试验不会提前发送。');
    return false;
  }
  const guard = validateCandidate(trial.candidate, plan.value, currentParams.value ?? trial.before);
  if (!guard.valid) {
    trial.status = 'rejected';
    proposalErrors.value = guard.errors;
    setNotice('error', '下发前约束检查未通过', guard.errors.join(' '));
    return false;
  }
  if (!props.connected || !telemetryFresh()) {
    setNotice('warning', '数据或连接已失效', '恢复连接并等待新遥測数据后重新进行检查。');
    return false;
  }
  if (!auto && !await requestApproval(`即将向当前设备发送参数写入命令：\n\n${trial.command}\n\n请确认字节与当前设备协议一致。`)) return false;
  checkExecutionSafety();
  if (stopRequested.value || !isWorking.value || !props.writeAccessReady || !authorizedPlanSignature.value || executionPlanSignature() !== authorizedPlanSignature.value || !isTrialForPlan(trial, plan.value, globalChannelStore.getGeneration())) return false;
  session.value.status = 'awaiting-confirmation';
  trial.writeStartedAt = Date.now();
  trial.writeStartLogId = Math.max(0, ...props.logs.map((log) => log.id));
  trial.writeRequestId = undefined;
  trial.writeSessionId = undefined;
  trial.writeEpoch = undefined;
  trial.writeCompletedAt = undefined;
  trial.writeChannelGeneration = globalChannelStore.getGeneration();
  pendingTrialId.value = trial.id;
  manualConfirmation.value = false;
  session.value.updatedAt = Date.now();
  emit('send-command', { trialId: trial.id, command: trial.command });
  const sent = await waitFor(() => {
    const result = props.writeResult;
    return Boolean(result && result.id === trial.id && (result.status === 'failed' || result.requestId));
  }, 8000);
  if (!sent || !props.writeResult || props.writeResult.status === 'failed') {
    trial.status = 'failed';
    if (stopRequested.value) return false;
    requestSafetyStop(props.writeResult?.error || '参数发送状态未得到确认。');
    return false;
  }
  if (props.writeResult.status === 'queued') {
    trial.status = 'queued';
    session.value.status = 'paused';
    session.value.stopReason = '命令已排队，驱动写入状态尚未确认；为避免使用不确定数据，本轮已暂停。';
    return false;
  }
  // Vue may deliver the prop watcher on the next scheduler turn when a Web
  // Serial write completes synchronously. Wait for the same watcher to commit
  // the correlated trial metadata before the caller advances the state machine.
  if (findTrial(trial.id)?.status !== 'sent') await waitFor(() => findTrial(trial.id)?.status === 'sent', 1000, 10);
  return findTrial(trial.id)?.status === 'sent';
}

async function confirmManualTrial() {
  const trial = currentProposal.value;
  if (!awaitingManualConfirmation.value || !isWorking.value || stopRequested.value || props.executionEnabled !== true || !props.writeAccessReady || !trial || !manualConfirmation.value || trial.status !== 'sent') return;
  if (!isTrialForPlan(trial, plan.value, globalChannelStore.getGeneration()) || !authorizedPlanSignature.value || executionPlanSignature() !== authorizedPlanSignature.value || trial.writeChannelGeneration !== globalChannelStore.getGeneration()) {
    requestStop('设备会话或确认配置已变化，原轮次不能继续确认。');
    setNotice('warning', '设备确认配置已变化', '请停止当前轮次并核对设备状态；原候选不再适用于当前配置。');
    return;
  }
  awaitingManualConfirmation.value = false;
  try {
    checkExecutionSafety();
    if (stopRequested.value) return;
    acceptWrite(trial, 'manual', '用户根据固件或仪器核对并确认。');
    if (trialStatus(trial.id) === 'confirmed') await collectAndEvaluate(trial);
  } finally {
    isWorking.value = false;
    authorizedPlanSignature.value = null;
  }
}

function detectedAcknowledgement(trial: TuningTrial): LogLine | undefined {
  const configured = plan.value.confirmation.acknowledgementText.trim();
  if (!configured.includes('{request_id}') || !trial.protocolRequestId || trial.writeCompletedAt === undefined) return undefined;
  const expected = configured.split('{request_id}').join(trial.protocolRequestId);
  return props.logs.find((log) => isAcknowledgementForWrite(log, expected, {
    startLogId: trial.writeStartLogId ?? 0,
    completedAt: trial.writeCompletedAt,
  }));
}

async function waitForWriteConfirmation(trial: TuningTrial): Promise<boolean> {
  if (props.executionEnabled !== true || trial.status !== 'sent') return false;
  const mode = plan.value.confirmation.mode;
  if (mode === 'manual') return false;
  const timeoutMs = (plan.value.confirmation.timeoutSeconds ?? 0) * 1000;
  if (!timeoutMs) return false;
  const confirmed = await waitFor(() => {
    if (mode === 'acknowledgement') return Boolean(detectedAcknowledgement(trial));
    const values = currentReadback(trial);
    return matchesParameterReadback(trial.candidate, values, plan.value.confirmation.parameterTolerance ?? 0, plan.value.structure);
  }, timeoutMs);
  if (!confirmed) return false;
  const ackLog = mode === 'acknowledgement' ? detectedAcknowledgement(trial) : undefined;
  const ack = ackLog?.text ?? (mode === 'parameter-channels' ? '设备参数通道在本次驱动写入后回传了候选值。' : undefined);
  if (ackLog) trial.acknowledgementLogId = ackLog.id;
  if (!ack) return false;
  acceptWrite(trial, mode, ack || '收到配置的设备应答。');
  return trialStatus(trial.id) === 'confirmed';
}

function acceptWrite(trial: TuningTrial, mode: WriteConfirmationMode, evidence: string) {
  if (trial.sourceChannelGeneration !== globalChannelStore.getGeneration() || trial.writeChannelGeneration !== globalChannelStore.getGeneration()) {
    requestSafetyStop('设备或解析会话变化，旧轮次不能升级为设备确认。');
    return;
  }
  if (stopRequested.value || !isWorking.value || !authorizedPlanSignature.value || executionPlanSignature() !== authorizedPlanSignature.value || props.executionEnabled !== true || trial.status !== 'sent' || !trial.writeRequestId || trial.writeCompletedAt === undefined) return;
  trial.status = 'confirmed';
  trial.confirmationMode = mode;
  trial.confirmation = evidence;
  trial.sampleWindowStart = latestTelemetryTimestamp();
  session.value.status = 'collecting';
  session.value.lastConfirmed = {
    params: { ...trial.candidate },
    mode,
    at: Date.now(),
  };
  session.value.plan.baseline = {
    ...session.value.plan.baseline,
    params: { ...trial.candidate },
    source: mode === 'parameter-channels' ? 'parameter-channels' : 'manual',
    confirmed: true,
  };
  const loop = globalProjectModel.getLoop(plan.value.loopId);
  if (loop) globalProjectModel.updateLoopParams(plan.value.loopId, trial.candidate);
}

async function collectAndEvaluate(trial: TuningTrial, automatic = false): Promise<boolean> {
  if (props.executionEnabled !== true || trial.status !== 'confirmed') {
    session.value.status = 'paused';
    session.value.stopReason = '没有当前会话的写入回执与设备确认，不能开始试验评价。';
    return false;
  }
  session.value.status = 'collecting';
  autoProgress.value = `等待 ${plan.value.evaluationWindowSeconds} 秒遥测窗口`;
  const windowMs = (plan.value.evaluationWindowSeconds ?? 0) * 1000;
  const collectionStart = performance.now();
  while (performance.now() - collectionStart < windowMs) {
    if (isWorking.value && (!authorizedPlanSignature.value || executionPlanSignature() !== authorizedPlanSignature.value)) {
      requestStop('实验配置在执行期间发生变化；本轮采集结束后不会继续试参。');
    }
    if (stopRequested.value || !props.connected) break;
    if (!telemetryFresh()) {
      trial.status = 'failed';
      requestSafetyStop('采集中遥测超时，未完成当前评价窗口。');
      return false;
    }
    const output = channelValues.value[plan.value.channels.output]?.value;
    if (Number.isFinite(output) && Math.abs(output as number) > (plan.value.maximumOutputMagnitude ?? 0)) {
      trial.status = 'failed';
      requestSafetyStop('采集中控制输出超过用户设置上限。');
      return false;
    }
    await sleep(Math.min(150, Math.max(1, windowMs - (performance.now() - collectionStart))));
  }
  if (stopRequested.value || !props.connected) {
    trial.status = 'failed';
    if ((session.value.status as TuningSession['status']) !== 'stopped') {
      session.value.status = 'paused';
      session.value.stopReason = stopRequested.value ? '收到停止请求；本轮未完成评价。' : '串口断开，本轮未完成评价。';
    }
    return false;
  }
  if (!telemetryFresh()) {
    trial.status = 'failed';
    session.value.status = 'paused';
    session.value.stopReason = '观察窗口结束时遥测已过期。';
    return false;
  }
  trial.sampleWindowEnd = latestTelemetryTimestamp();
  const measured = readMetrics(trial.sampleWindowStart ?? 0);
  if (!measured.metrics) {
    trial.status = 'failed';
    session.value.status = 'paused';
    session.value.stopReason = measured.message;
    setNotice('warning', '试验数据无法评价', measured.message);
    return false;
  }
  trial.metrics = measured.metrics;
  trial.status = 'evaluated';
  trial.note = `${trial.note} ${measured.message}`.trim();
  if (measured.metrics.maximumOutputMagnitude > (plan.value.maximumOutputMagnitude ?? 0)) {
    trial.status = 'failed';
    requestSafetyStop('评价窗口的控制输出超过设置上限。');
    return false;
  }
  if (measured.passed) {
    session.value.bestVerified = { ...trial.candidate };
    session.value.status = 'completed';
    session.value.stopReason = '当前候选通过用户配置的遥测评价窗口。';
    trial.note = `${trial.note} 本轮遥测达到用户设定目标。`;
    setNotice('success', '目标条件已满足', '最佳参数基于设备回传和本轮设定指标标记，永久保存仍需你在固件侧处理。');
    return true;
  }
  if (!automatic) {
    session.value.status = 'paused';
    session.value.stopReason = '本轮数据已记录。检查响应和停止条件后，再提出下一轮候选。';
    setNotice('info', '试验数据已记录', '本轮未达到全部目标。请查看记录，决定是否再生成下一轮候选。');
  }
  return false;
}

async function generateManualCandidate() {
  const eligibility = manualCandidateEligibility({
    planErrorCount: candidateErrors.value.length,
    isWorking: isWorking.value,
    sessionStatus: session.value.status,
    route: plan.value.route,
    connected: props.connected,
    telemetryFresh: telemetryFresh(),
  });
  if (!eligibility.allowed) {
    setNotice('warning', '暂时不能生成候选', eligibility.reason || '当前状态不允许生成候选。');
    return;
  }
  await proposeCandidate();
}

async function sendManualTrial(chosen: TuningTrial) {
  authorizedPlanSignature.value = executionPlanSignature();
  isWorking.value = true;
  stopRequested.value = false;
  try {
    if (!await waitFor(() => props.writeAccessReady, 5000, 20)) {
      setNotice('warning', '尚未取得写入权', '等待普通发送队列结束后再重试；本轮没有发送命令。');
      return;
    }
    const sent = await sendTrial(chosen);
    if (!sent) return;
    if (plan.value.confirmation.mode !== 'manual' && chosen.status === 'sent') {
      const confirmed = await waitForWriteConfirmation(chosen);
      if (!confirmed) {
        if (stopRequested.value) return;
        chosen.status = 'failed';
        requestSafetyStop('已发送，但未收到参数回传或设备应答。');
        return;
      }
      await collectAndEvaluate(chosen);
    } else if (chosen.status === 'sent') {
      awaitingManualConfirmation.value = true;
      setNotice('warning', '等待人工核对设备', '命令已发送但没有生效确认。请核对设备后勾选确认，或停止本次实验。');
    }
  } finally {
    if (!awaitingManualConfirmation.value) {
      isWorking.value = false;
      authorizedPlanSignature.value = null;
    }
  }
}

async function runBoundedExperiment() {
  if (props.executionEnabled !== true) {
    setNotice('warning', '自动调参执行暂不可用', '请等待驱动写入回执、会话绑定和设备确认全部接通并通过验收。');
    return;
  }
  const missing = validatePlan(plan.value);
  if (missing.length) {
    setNotice('warning', '暂时不能授权自动实验', missing[0]);
    return;
  }
  if (plan.value.mode !== 'bounded-auto' || plan.value.confirmation.mode === 'manual') {
    setNotice('warning', '授权条件不完整', '先选择范围内自动模式，并配置设备应答或参数回传。');
    return;
  }
  if (!plan.value.baseline.stableBaseConfirmed) {
    setNotice('warning', '需要确认现有控制器可稳定运行', '自动反馈试验从已运行的控制器微调参数。请先确认当前基线正在控制设备，并已准备独立设备保护。');
    return;
  }
  const roundLimit = plan.value.route === 'model' ? 1 : plan.value.maximumTrials;
  const activeBoundSummary = activeParameters.value.map((key) => `${key.toUpperCase()} (${plan.value.units.parameters[key]}) ${plan.value.bounds[key]?.min}–${plan.value.bounds[key]?.max}`).join(' · ');
  const routeSummary = plan.value.route === 'model' ? '本机 PID 数学工具计算一个候选' : '每轮将参数和遥测指标摘要发送到已配置的 AI 服务';
  const confirmationSummary = plan.value.confirmation.mode === 'acknowledgement' ? `应答包含“${plan.value.confirmation.acknowledgementText}”` : '活动参数通道回传与候选在容差内一致';
  const goalSummary = plan.value.goal.mode === 'track'
    ? `轨迹跟踪 RMS ≤ ${plan.value.goal.maximumTrackingError} ${plan.value.units.feedback}`
    : plan.value.goal.mode === 'step-response'
      ? `稳态误差 ≤ ${plan.value.goal.maximumSteadyError} ${plan.value.units.feedback}，超调 ≤ ${plan.value.goal.maximumOvershootPct}%`
      : `稳态误差 ≤ ${plan.value.goal.maximumSteadyError} ${plan.value.units.feedback}`;
  const modelTarget = plan.value.route === 'model'
    ? `\n模型目标：ωc ${plan.value.goal.targetCrossoverRadPerSec} rad/s · 相位裕度 ${plan.value.goal.targetPhaseMarginDeg}°`
    : '';
  const consent = await requestApproval(`请检查自动试验授权范围\n\n项目 / 环路：${plan.value.project} / ${activeLoop.value?.name || plan.value.loopId}\n路线：${routeSummary}\n控制结构 / 方向：${plan.value.structure} / ${plan.value.controlDirection}\n基线：Kp ${currentParams.value?.kp} · Ki ${currentParams.value?.ki} · Kd ${currentParams.value?.kd}\n参数边界：${activeBoundSummary}\n目标：${goalSummary}${modelTarget}\n采样周期：${plan.value.sampleTimeSeconds} 秒 · 最大遥测延迟：${plan.value.maximumTelemetryAgeSeconds} 秒\n输出绝对上限：${plan.value.maximumOutputMagnitude} ${plan.value.units.output}\n每轮最大变化：${plan.value.maxParameterChangePercent}%\n观察窗口：${plan.value.evaluationWindowSeconds} 秒 · 最多 ${roundLimit} 轮\n停止条件：遥测过期、串口断开、输出越界、目标达成或用户停止\n设备确认：${confirmationSummary}\n命令模板：\n${plan.value.commandTemplate}\n\n程序会逐轮检查候选值。是否授权此范围？`);
  if (!consent) return;
  authorizedPlanSignature.value = executionPlanSignature();
  isWorking.value = true;
  stopRequested.value = false;
  session.value.status = 'collecting';
  session.value.startedAt = Date.now();
  session.value.stopReason = null;
  try {
    const lockReady = await waitFor(() => props.writeAccessReady, 5000, 20);
    if (!lockReady) throw new Error('没有取得独占串口写入权，自动实验没有发送参数。');
    for (let round = trialBudgetUsed(session.value.trials); round < (roundLimit ?? 0); round += 1) {
      if (stopRequested.value || !props.connected || !telemetryFresh()) break;
      autoProgress.value = `第 ${round + 1} / ${roundLimit} 轮 · 读取遥测`;
      const trial = await proposeCandidate(true);
      if (!trial || stopRequested.value) break;
      const sent = await sendTrial(trial, true);
      if (!sent || trial.status !== 'sent') break;
      const confirmed = await waitForWriteConfirmation(trial);
      if (!confirmed) {
        trial.status = 'failed';
        if (stopRequested.value) break;
        requestSafetyStop('已发送，但在超时时间内没有确认写入生效。');
        break;
      }
      const reachedGoal = await collectAndEvaluate(trial, true);
      if (reachedGoal || trialStatus(trial.id) === 'failed' || stopRequested.value) break;
    }
    if (!['completed', 'stopped', 'paused'].includes(session.value.status)) {
      session.value.status = 'paused';
      session.value.stopReason = stopRequested.value
        ? '用户请求停止。'
        : plan.value.route === 'model'
          ? '模型路线的自动授权只执行一个本机计算候选；未达目标时请检查模型与目标后再创建新试验。'
          : `已达到最大试验轮数 ${roundLimit}。`;
    }
    if (session.value.status === 'paused' && !notice.value) setNotice('info', '实验已暂停', session.value.stopReason || '检查试验记录后再继续。');
  } catch (error) {
    if (stopRequested.value) return;
    session.value.status = 'paused';
    session.value.stopReason = error instanceof Error ? error.message : String(error);
    setNotice('error', '自动实验已暂停', session.value.stopReason);
  } finally {
    isWorking.value = false;
    authorizedPlanSignature.value = null;
    autoProgress.value = '';
    session.value.updatedAt = Date.now();
    saveTuningSession(session.value);
  }
}

function requestStop(reason = '用户请求停止。') {
  stopRequested.value = true;
  if (session.value.status !== 'stopped' && (isWorking.value || ['awaiting-confirmation', 'collecting'].includes(session.value.status))) {
    session.value.status = 'paused';
    session.value.stopReason = reason;
  }
  if (awaitingManualConfirmation.value) {
    plan.value.baseline.confirmed = false;
    plan.value.baseline.stableBaseConfirmed = false;
    session.value.lastConfirmed = null;
    const trial = currentProposal.value;
    if (trial?.status === 'sent') { trial.status = 'failed'; trial.confirmation = '人工确认前流程停止，当前设备参数需重新核对。'; }
    awaitingManualConfirmation.value = false;
    isWorking.value = false;
    authorizedPlanSignature.value = null;
  }
  if (session.value.status !== 'stopped') setNotice('warning', '停止信号已记录', '实验执行器会在本次未完成的请求或设备等待结束后停止，并保留已发送命令。');
}

function checkExecutionSafety() {
  if (!isWorking.value || stopRequested.value) return;
  if (observedChannelGeneration !== globalChannelStore.getGeneration()) {
    invalidateDeviceContext();
    return;
  }
  const reason = executionSafetyStopReason({ connected: props.connected, telemetryFresh: telemetryFresh(), output: channelValues.value[plan.value.channels.output]?.value, maximumOutputMagnitude: plan.value.maximumOutputMagnitude });
  if (!reason) return;
  requestSafetyStop(reason);
}

function invalidateDeviceContext() {
  observedChannelGeneration = globalChannelStore.getGeneration();
  session.value.lastConfirmed = null;
  plan.value.baseline.confirmed = false;
  plan.value.baseline.stableBaseConfirmed = false;
  if (plan.value.suite) plan.value.suite.modelConfirmed = false;
  const trial = currentProposal.value;
  if (trial?.status === 'proposed') { trial.status = 'rejected'; trial.note += ' 设备会话变化，候选已作废。'; }
  if (isWorking.value) requestSafetyStop('设备或解析会话发生变化，当前轮次不能继续。');
}

function requestSafetyStop(reason: string) {
  if (stopRequested.value) return;
  stopRequested.value = true;
  plan.value.baseline.confirmed = false;
  plan.value.baseline.stableBaseConfirmed = false;
  session.value.lastConfirmed = null;
  session.value.status = 'stopped';
  session.value.stopReason = `${reason} 已请求本机发送屏障和配置的设备停止命令；设备是否停机仍需确认。`;
  setNotice('error', '调参安全停止', session.value.stopReason);
  emit('safety-stop', reason);
  if (awaitingManualConfirmation.value) {
    awaitingManualConfirmation.value = false;
    isWorking.value = false;
    authorizedPlanSignature.value = null;
  }
}

function readMetrics(afterTimestamp = 0): { metrics: TuningMetrics | null; passed: boolean; message: string } {
  const bindings = plan.value.channels;
  const selected = [bindings.setpoint, bindings.feedback, bindings.output];
  if (selected.some((channel) => !channel)) return { metrics: null, passed: false, message: '请先绑定目标值、实际反馈和控制输出。' };
  for (const channel of selected) {
    const latest = channelValues.value[channel];
    if (!latest) return { metrics: null, passed: false, message: `通道 ${channel} 尚未收到数据。` };
    if ((Date.now() - latest.receivedAt) / 1000 > (plan.value.maximumTelemetryAgeSeconds ?? 0)) {
      return { metrics: null, passed: false, message: `通道 ${channel} 的数据已超过最大延迟。` };
    }
  }
  const snapshots = selected.map((channel) => globalChannelStore.snapshot(channel, afterTimestamp));
  const aligned = alignSnapshots(snapshots[0], snapshots[1], snapshots[2], afterTimestamp);
  if (aligned.setpoints.length < 10) return { metrics: null, passed: false, message: '等待至少 10 组对齐的目标值、反馈和输出采样。' };
  return evaluateResponse(aligned.setpoints, aligned.responses, aligned.outputs, plan.value.goal, plan.value.maximumOutputMagnitude ?? 0);
}

function alignSnapshots(setpoint: { timestamps: Float64Array; values: Float64Array; count: number }, feedback: { timestamps: Float64Array; values: Float64Array; count: number }, output: { timestamps: Float64Array; values: Float64Array; count: number }, afterTimestamp = 0) {
  const result = { setpoints: [] as number[], responses: [] as number[], outputs: [] as number[] };
  const map = (source: typeof setpoint, time: number) => {
    let best = -1;
    let gap = Infinity;
    for (let i = 0; i < source.count; i += 1) {
      const distance = Math.abs(source.timestamps[i] - time);
      if (distance < gap) { gap = distance; best = i; }
    }
    return best >= 0 && gap <= (plan.value.sampleTimeSeconds ?? 0) * 3 ? source.values[best] : NaN;
  };
  for (let i = 0; i < feedback.count; i += 1) {
    const time = feedback.timestamps[i];
    if (time <= afterTimestamp) continue;
    const sp = map(setpoint, time);
    const out = map(output, time);
    if (Number.isFinite(sp) && Number.isFinite(out) && Number.isFinite(feedback.values[i])) {
      result.setpoints.push(sp);
      result.responses.push(feedback.values[i]);
      result.outputs.push(out);
    }
  }
  return result;
}

function latestTelemetryTimestamp(): number {
  return Math.max(0, ...[plan.value.channels.setpoint, plan.value.channels.feedback, plan.value.channels.output]
    .filter(Boolean)
    .map((channel) => globalChannelStore.latest(channel)?.t ?? 0));
}

function telemetryFresh(): boolean {
  // Keep freshness labels and eligibility reactive when the stream goes quiet.
  void clockNow.value;
  const p = plan.value;
  if (!p.channels.setpoint || !p.channels.feedback || !p.channels.output || !p.maximumTelemetryAgeSeconds) return false;
  return [p.channels.setpoint, p.channels.feedback, p.channels.output].every((channel) => {
    const value = channelValues.value[channel];
    return value && value.generation === globalChannelStore.getGeneration() && (Date.now() - value.receivedAt) / 1000 <= p.maximumTelemetryAgeSeconds!;
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, interval = 120, respectStop = false): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if ((respectStop || isWorking.value) && (stopRequested.value || !props.connected)) return false;
    checkExecutionSafety();
    if ((respectStop || isWorking.value) && stopRequested.value) return false;
    if (predicate()) return true;
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  return !((respectStop || isWorking.value) && stopRequested.value) && predicate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function findTrial(trialId: string): TuningTrial | undefined {
  return session.value.trials.find((trial) => trial.id === trialId);
}

function trialStatus(trialId: string): TuningTrial['status'] | undefined {
  return findTrial(trialId)?.status;
}

function useLastVerified() {
  if (!session.value.bestVerified) return;
  parameterForm.kp = String(session.value.bestVerified.kp);
  parameterForm.ki = String(session.value.bestVerified.ki);
  parameterForm.kd = String(session.value.bestVerified.kd);
  syncManualParams();
  setNotice('info', '已载入最佳验证参数', '这只更新当前实验基线字段，不会发送或改变设备参数。');
}

function importPackage() {
  if (isWorking.value) return;
  const file = importInput.value?.files?.[0];
  if (!file) return;
  if (file.size > 512 * 1024) {
    setNotice('error', '套件文件过大', '首版只接受小于 512 KiB 的 JSON 配置套件。');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const value = JSON.parse(String(reader.result));
      const errors = validateCapabilityPackage(value);
      if (errors.length) throw new Error(errors.join(' '));
      const pkg = value as TuningCapabilityPackage;
      const importedPlan = hydratePlan(importCapabilityPlan(pkg));
      plan.value = { ...importedPlan, id: id() };
      session.value = { id: id(), plan: plan.value, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null };
      parameterForm.kp = parameterForm.ki = parameterForm.kd = '';
      loadModelFormFromPlan();
      sessionPersistTimer && window.clearTimeout(sessionPersistTimer);
      sessionPersistTimer = null;
      saveTuningSession(session.value);
      setNotice('success', `已导入「${pkg.title}」`, `作者：${pkg.author} · 套件兼容要求已检查。请逐项核对项目知识、命令模板、控制环、通道、模型与边界；套件不会执行任何动作。`);
      assistantPane.value = 'setup';
      if (plan.value.suite?.customStages?.length) customStages.value = plan.value.suite.customStages.map((stage) => ({ ...stage, supportedStructures: [...stage.supportedStructures] }));
      modelDraft.value = plan.value.suite?.modelDraft ?? null;
      modelSource.value = plan.value.suite?.modelOrigin === 'ai-proposal' ? 'ai' : plan.value.suite?.modelOrigin === 'user-transfer-function' || plan.value.suite?.id === 'custom' ? 'transfer' : 'physical';
    } catch (error) {
      setNotice('error', '套件导入失败', error instanceof Error ? error.message : String(error));
    }
  };
  reader.onerror = () => setNotice('error', '文件读取失败', '请检查 JSON 文件后重试。');
  reader.readAsText(file);
  if (importInput.value) importInput.value.value = '';
}

function exportPackage() {
  const value = JSON.stringify(packagePlan(plan.value, plan.value.name || 'LLM 串口调参套件'), null, 2);
  const blob = new Blob([value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFileName(plan.value.name || 'tuning-package')}.llm-tuning.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  setNotice('success', '套件已导出', '文件包含提示词与配置，不包含设备数据、API Key 或试验历史。');
}

function newExperiment() {
  if (isWorking.value) return;
  archiveCurrentStage();
  const next = newPlan();
  plan.value = next;
  session.value = { id: id(), plan: next, status: 'draft', trials: [], bestVerified: null, lastConfirmed: null, startedAt: null, updatedAt: Date.now(), stopReason: null };
  session.value.scenarioGroupId = session.value.id;
  parameterForm.kp = parameterForm.ki = parameterForm.kd = '';
  loadModelFormFromPlan();
  assistantPane.value = 'setup';
  modelDraft.value = null;
  modelSource.value = 'physical';
  modelInputErrors.value = [];
  notice.value = null;
  pendingTrialId.value = null;
}

function loadModelFormFromPlan() {
  const model = plan.value.model;
  if (!model) {
    transferForm.numerator = transferForm.denominator = transferForm.delay = '';
    return;
  }
  const coefficients = model.family === 'transfer_function'
    ? { numerator: model.numerator, denominator: model.denominator }
    : model.family === 'sopdt'
      ? { numerator: [model.k * model.wn * model.wn], denominator: [1, 2 * model.zeta * model.wn, model.wn * model.wn] }
      : model.family === 'integral_lag'
        ? { numerator: [model.k], denominator: [model.t, 1, 0] }
        : { numerator: [model.k], denominator: [model.t, 1] };
  transferForm.numerator = coefficients.numerator.join(', ');
  transferForm.denominator = coefficients.denominator.join(', ');
  transferForm.delay = String(model.tau);
}
function parameterChannelValue(key: PidParameter): number | null {
  const channel = plan.value.channels.parameters[key];
  const value = channel ? channelValues.value[channel] : undefined;
  return value ? value.value : null;
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function format(value: number | undefined | null, digits = 3): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
}

function confirmationLabel(mode: WriteConfirmationMode): string {
  if (mode === 'parameter-channels') return '设备参数通道回传';
  if (mode === 'acknowledgement') return '匹配到设备应答';
  return '用户人工核对';
}

function safeFileName(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 50) || 'tuning-package';
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tuning-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
</script>

<template>
  <section class="scene-assistant" aria-label="场景 AI 调参辅助">
    <dialog ref="approvalDialog" class="approval-dialog" aria-labelledby="approval-title" @cancel.prevent="finishApproval(false)">
      <h2 id="approval-title">核对本次操作</h2>
      <p class="approval-copy">{{ approvalText }}</p>
      <div class="approval-actions"><button type="button" class="secondary-button" autofocus @click="finishApproval(false)">取消</button><button type="button" class="primary-button" @click="finishApproval(true)">确认此范围并继续</button></div>
    </dialog>
    <header class="scene-heading"><div><h2>{{ selectedSuite ? `${selectedSuite.title} · ${selectedStage?.title || '选择环节'}` : '场景调参' }}</h2><p v-if="!selectedSuite">将 AI 接到你正在观察的变量上</p></div><span class="session-state">{{ statusName(session.status) }}</span></header>
    <nav v-if="selectedSuite" class="assistant-tabs" aria-label="场景调参内容"><button type="button" :class="{ selected: assistantPane === 'setup' }" :aria-pressed="assistantPane === 'setup'" @click="assistantPane = 'setup'">场景与设置</button><button type="button" :class="{ selected: assistantPane === 'result' }" :aria-pressed="assistantPane === 'result'" @click="assistantPane = 'result'">候选与记录 {{ session.trials.length || '' }}</button></nav>
    <div class="scene-scroll">
      <div v-if="notice" class="notice" :class="[`notice-${notice.type}`, { 'notice-compact': assistantPane === 'result' && notice.type === 'success' }]" role="status"><div><strong>{{ notice.title }}</strong><p v-if="assistantPane !== 'result' || notice.type !== 'success'">{{ notice.body }}</p></div><button type="button" class="icon-button" aria-label="关闭提示" @click="notice = null"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></div>
      <div v-if="!selectedSuite" class="scene-start"><p>选择对象与控制环节，绑定串口解析出的变量。AI 反馈与模型计算共用当前串口会话。</p><div class="suite-options" role="group" aria-label="调参场景"><button v-for="suite in SCENARIO_SUITES" :key="suite.id" type="button" @click="selectScenario(suite.id)"><span><strong>{{ suite.title }}</strong><small>{{ suite.description }}</small></span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></button></div><p class="field-note">套组包含控制结构、物理模型与场景约束。自定义套组由你构建环路、模型和提示词。</p><p class="field-note">{{ liveStatus }}</p></div>
      <template v-else>
        <fieldset v-if="assistantPane === 'setup'" class="scene-form" :disabled="isWorking || aiBusy || modelBusy">
          <div class="form-row"><label class="field"><span>场景套组</span><select :value="plan.suite?.id" @change="selectScenario(($event.target as HTMLSelectElement).value as TuningScenarioId)"><option v-for="suite in SCENARIO_SUITES" :key="suite.id" :value="suite.id">{{ suite.title }}</option></select></label><label v-if="plan.suite?.id !== 'custom'" class="field"><span>控制方案</span><select :value="plan.suite?.topologyId" @change="selectTopology(($event.target as HTMLSelectElement).value)"><option v-for="topology in selectedSuite.topologies" :key="topology.id" :value="topology.id">{{ topology.title }}</option></select></label></div>
          <p v-if="plan.suite?.id !== 'custom'" class="field-note">{{ selectedTopology?.description }}</p>
          <details v-else class="settings-section" open><summary>构建控制环路 <span>{{ customStages.length === 1 ? '单环' : `${customStages.length} 级串级` }}</span></summary><div class="details-body"><p class="field-note">按从内到外的顺序添加，每次整定当前选中的环节。</p><div v-for="(stage,index) in customStages" :key="stage.id" class="custom-stage-row"><label class="field"><span>{{ index === 0 ? '内环 / 单环名称' : `外环 ${index} 名称` }}</span><input :value="stage.title" @input="updateCustomStage(stage.id,'title',($event.target as HTMLInputElement).value)" placeholder="例如：角速度环"></label><label class="field"><span>结构</span><select :value="stage.structure" @change="updateCustomStage(stage.id,'structure',($event.target as HTMLSelectElement).value)"><option v-for="structure in stage.supportedStructures" :key="structure">{{ structure }}</option></select></label><button v-if="customStages.length > 1" type="button" class="icon-button remove-stage" :aria-label="`删除${stage.title}`" @click="removeCustomStage(stage.id)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4"/></svg></button></div><button type="button" class="text-button" :disabled="customStages.length >= 4" @click="addCustomStage">添加外环</button><p v-for="error in stageErrors" :key="error" class="field-error">{{ error }}</p></div></details>
          <div class="form-row"><label class="field"><span>当前控制环节</span><select :value="plan.suite?.stageId" @change="selectStage(($event.target as HTMLSelectElement).value)"><option v-for="stage in sceneStages" :key="stage.id" :value="stage.id">{{ stage.title }}</option></select></label><label class="field"><span>控制器</span><select :value="plan.structure" @change="handleStructureChange(($event.target as HTMLSelectElement).value as LoopStructure)"><option v-for="structure in selectedStage?.supportedStructures || ['P','PI','PD','PID']" :key="structure">{{ structure }}</option></select></label></div>
          <div class="route-choice" role="group" aria-label="调参方式"><button type="button" :class="{ selected: plan.route === 'feedback' }" :aria-pressed="plan.route === 'feedback'" @click="setRoute('feedback')"><strong>AI 自动反馈</strong><small>遥测 → 候选 → 确认 → 评价</small></button><button type="button" :class="{ selected: plan.route === 'model' }" :aria-pressed="plan.route === 'model'" @click="setRoute('model')"><strong>物理模型计算</strong><small>物理数据 / G(s) → PID 候选</small></button></div>
          <p class="field-note">{{ plan.route === 'feedback' ? '从稳定的当前参数开始。本地执行器限制每轮变化，设备确认后才继续。' : '可以离线计算。模型和工况由你确认，候选仍须设备验证。' }}</p>
          <div class="provider-row"><span>{{ aiConfigured ? `AI 服务 · ${aiConfig.model}` : 'AI 服务尚未配置' }}</span><button type="button" class="text-button" @click="emit('open-ai-settings')">模型设置</button></div>
          <section v-if="plan.route === 'model'" class="model-section" aria-labelledby="scene-model-title"><h3 id="scene-model-title">对象模型</h3><label class="field"><span>模型来源</span><select :value="modelSource" @change="setModelSource(($event.target as HTMLSelectElement).value as 'physical' | 'transfer' | 'ai')"><option v-if="plan.suite?.id !== 'custom'" value="physical">填写场景物理数据</option><option value="transfer">输入 s 域传递函数</option><option value="ai">描述对象，让 AI 草拟模型</option></select></label><p v-if="modelSource === 'physical'" class="field-note">{{ selectedSuite.physicalModel }}</p>
            <template v-if="modelSource === 'transfer'"><p class="field-note">按 s 的降幂顺序填写系数，以逗号或空格分隔。</p><label class="field"><span>G(s) 分子系数</span><input v-model="transferForm.numerator" placeholder="例如：2（格式说明）" @input="updateTransferModel('numerator',($event.target as HTMLInputElement).value)"></label><label class="field"><span>G(s) 分母系数</span><input v-model="transferForm.denominator" placeholder="例如：0.5, 1（0.5s + 1）" @input="updateTransferModel('denominator',($event.target as HTMLInputElement).value)"></label><label class="field"><span>纯延迟 τ · 秒</span><input v-model="transferForm.delay" type="number" min="0" step="any" placeholder="无延迟时明确填写 0" @input="updateTransferModel('delay',($event.target as HTMLInputElement).value)"></label></template>
            <template v-else-if="modelSource === 'ai'"><label class="field"><span>对象与工作点</span><textarea v-model="plan.description" rows="3" placeholder="说明输入、输出、执行器、传感器与工况。AI 会列出待测量的物理数据。"></textarea></label><button type="button" class="secondary-button" :disabled="!plan.description.trim() || !aiConfigured" @click="deriveWithAi">{{ modelBusy ? '正在推导模型…' : modelDraft ? '重新草拟模型与数据表' : '草拟模型与数据表' }}</button><div v-if="modelDraft" class="model-draft"><p>{{ modelDraft.explanation }}</p><code>分子 [{{ modelDraft.numerator.join(', ') }}]<br>分母 [{{ modelDraft.denominator.join(', ') }}]<br>延迟 {{ modelDraft.tau }} s</code></div></template>
            <div v-if="modelSource !== 'transfer' && modelFieldInputs.length" class="physical-inputs"><label v-for="field in modelFieldInputs" :key="field.id" class="field"><span>{{ field.label }} <small>{{ field.unit }}</small></span><input :value="plan.suite?.physicalInputs[field.id] ?? ''" type="number" step="any" placeholder="待测量 / 提供" @input="setPhysicalInput(field.id,($event.target as HTMLInputElement).value)"><small v-if="field.description">{{ field.description }}</small></label></div>
            <div v-if="modelInputErrors.length" class="model-notes"><p v-for="error in modelInputErrors" :key="error">{{ error }}</p></div><p v-if="modelSource === 'physical' && physicalModelResult?.pendingInputs.length" class="field-note">待提供：{{ physicalModelResult.pendingInputs.join('、') }}</p><details v-if="plan.suite?.assumptions.length" class="model-assumptions"><summary>模型假设与适用条件</summary><ul><li v-for="assumption in plan.suite.assumptions" :key="assumption">{{ assumption }}</li></ul></details><label v-if="plan.suite" class="check-field"><input v-model="plan.suite.modelConfirmed" type="checkbox" :disabled="!plan.model"><span>我已核对输入输出、单位、物理数据和假设，确认模型用于当前工况。</span></label>
            <div class="form-row"><label class="field"><span>剪切频率 · rad/s</span><input v-model.number="plan.goal.targetCrossoverRadPerSec" type="number" min="0" step="any" placeholder="按目标带宽提供"></label><label class="field"><span>相位裕度 · °</span><input v-model.number="plan.goal.targetPhaseMarginDeg" type="number" min="0" max="180" step="any" placeholder="按响应目标提供"></label></div>
          </section>
          <div class="form-row execution-context"><label class="field"><span>控制方向</span><select v-model="plan.controlDirection"><option :value="null">核对反馈方向</option><option value="direct">输出增加 → 反馈增加</option><option value="reverse">输出增加 → 反馈减少</option></select></label><label class="field"><span>固件采样周期 · 秒</span><input v-model.number="plan.sampleTimeSeconds" type="number" min="0" step="any" placeholder="需从固件确认"></label></div>
          <details class="settings-section" :open="channelSettingsOpen" @toggle="channelSettingsOpen = ($event.target as HTMLDetailsElement).open"><summary>绑定串口变量 <span>{{ plan.channels.feedback || '待绑定' }}</span></summary><div class="details-body"><p class="field-note">顶部选择解析协议，收到变量后绑定。设定值与反馈使用相同单位。</p><div v-for="item in latestSummary" :key="item.key" class="channel-binding"><label class="field"><span>{{ item.key }} <output>{{ format(item.reading?.value,4) }}</output></span><select :value="item.channel" :aria-label="`${item.key}通道`" @change="plan.channels[item.key === '目标' ? 'setpoint' : item.key === '实际反馈' ? 'feedback' : 'output'] = ($event.target as HTMLSelectElement).value"><option value="">选择已解析变量</option><option v-for="channel in liveChannelOptions" :key="channel" :value="channel">{{ channel }}</option></select></label><label class="field"><span>单位</span><input :value="plan.units[item.key === '目标' ? 'setpoint' : item.key === '实际反馈' ? 'feedback' : 'output']" :aria-label="`${item.key}单位`" @input="plan.units[item.key === '目标' ? 'setpoint' : item.key === '实际反馈' ? 'feedback' : 'output'] = ($event.target as HTMLInputElement).value" placeholder="需确认"></label></div><label class="field"><span>最大遥测延迟 · 秒</span><input v-model.number="plan.maximumTelemetryAgeSeconds" type="number" min="0" step="any" placeholder="按设备上报周期提供"></label><p class="field-note">{{ telemetryAge === null ? '当前绑定通道还没有数据' : `最近遥测 ${format(telemetryAge,1)} 秒前` }}</p></div></details>
          <details class="settings-section" :open="parameterSettingsOpen" @toggle="parameterSettingsOpen = ($event.target as HTMLDetailsElement).open"><summary>当前参数与写入边界 <span>{{ plan.baseline.confirmed ? '用户已核对' : '执行前必填' }}</span></summary><div class="details-body"><p class="field-note">按固件实际公式填写参数单位；非活动项固定为 0。模型离线计算可先跳过。</p><div v-for="key in activeParameters" :key="key" class="parameter-setting"><h4>{{ key.toUpperCase() }}</h4><div class="parameter-values"><label class="field"><span>设备当前值</span><input v-model="parameterForm[key]" type="number" step="any" placeholder="待核对" @input="syncManualParams(key,($event.target as HTMLInputElement).value)"></label><label class="field"><span>下限</span><input :value="plan.bounds[key]?.min ?? ''" type="number" step="any" placeholder="待确认" @input="setBound(key,'min',($event.target as HTMLInputElement).value)"></label><label class="field"><span>上限</span><input :value="plan.bounds[key]?.max ?? ''" type="number" step="any" placeholder="待确认" @input="setBound(key,'max',($event.target as HTMLInputElement).value)"></label></div><div class="form-row"><label class="field"><span>参数单位 / 固件定义</span><input v-model.trim="plan.units.parameters[key]" :aria-label="`${key.toUpperCase()}单位`" placeholder="按固件公式填写"></label><label class="field"><span>设备回传变量</span><select v-model="plan.channels.parameters[key]"><option value="">未绑定</option><option v-for="channel in liveChannelOptions" :key="channel" :value="channel">{{ channel }}</option></select><small v-if="plan.channels.parameters[key]">当前 {{ format(parameterChannelValue(key)) }}</small></label></div></div><button type="button" class="text-button" :disabled="!activeParameters.every((key) => plan.channels.parameters[key])" @click="readParametersFromChannels">从本次遥测读取当前参数</button><label class="check-field"><input v-model="plan.baseline.confirmed" type="checkbox" :disabled="!plan.baseline.params"><span>我已核对设备当前值与边界。</span></label><label v-if="plan.mode === 'bounded-auto'" class="check-field"><input v-model="plan.baseline.stableBaseConfirmed" type="checkbox"><span>当前控制器在稳定的保守基线下运行，设备已有独立保护。</span></label></div></details>
          <details class="settings-section" :open="goalSettingsOpen" @toggle="goalSettingsOpen = ($event.target as HTMLDetailsElement).open"><summary>目标、预算与设备确认 <span>{{ plan.confirmation.mode === 'manual' ? '人工确认' : '设备确认' }}</span></summary><div class="details-body"><label class="field"><span>成功目标</span><select v-model="plan.goal.mode"><option value="settle">保持在目标误差内</option><option value="step-response">阶跃响应</option><option value="track">轨迹跟踪</option></select></label><div class="form-row"><label v-if="plan.goal.mode !== 'track'" class="field"><span>最大稳态误差</span><input v-model.number="plan.goal.maximumSteadyError" type="number" min="0" step="any" :placeholder="plan.units.feedback || '反馈变量单位'"></label><label v-if="plan.goal.mode === 'step-response'" class="field"><span>最大超调 · %</span><input v-model.number="plan.goal.maximumOvershootPct" type="number" min="0" step="any" placeholder="由目标设定"></label><label v-if="plan.goal.mode === 'track'" class="field"><span>最大 RMS 跟踪误差</span><input v-model.number="plan.goal.maximumTrackingError" type="number" min="0" step="any" :placeholder="plan.units.feedback || '反馈变量单位'"></label><label class="field"><span>最大输出绝对值</span><input v-model.number="plan.maximumOutputMagnitude" type="number" min="0" step="any" :placeholder="plan.units.output || '执行器单位'"></label><label class="field"><span>单轮最大变化 · %</span><input v-model.number="plan.maxParameterChangePercent" type="number" min="0" max="100" step="any" placeholder="自行确认幅度"></label><label class="field"><span>观察时长 · 秒</span><input v-model.number="plan.evaluationWindowSeconds" type="number" min="0" step="any" placeholder="覆盖对象响应"></label><label class="field"><span>最多试验轮数</span><input v-model.number="plan.maximumTrials" type="number" min="1" max="100" step="1" placeholder="有限试验预算"></label></div><label class="field"><span>参数生效确认</span><select :value="plan.confirmation.mode" @change="toggleConfirmationMode(($event.target as HTMLSelectElement).value as WriteConfirmationMode)"><option value="parameter-channels">参数变量回传</option><option value="acknowledgement">带本轮 ID 的设备应答</option><option value="manual">逐轮人工核对</option></select></label><label v-if="plan.confirmation.mode === 'acknowledgement'" class="field"><span>设备成功应答模板</span><input v-model="plan.confirmation.acknowledgementText" placeholder="例如：PID_APPLIED {request_id}"></label><div v-if="plan.confirmation.mode !== 'manual'" class="form-row"><label class="field"><span>确认超时 · 秒</span><input v-model.number="plan.confirmation.timeoutSeconds" type="number" min="0" step="any" placeholder="按设备响应提供"></label><label v-if="plan.confirmation.mode === 'parameter-channels'" class="field"><span>回传容差 · %</span><input v-model.number="plan.confirmation.parameterTolerance" type="number" min="0" step="any" placeholder="按数值精度提供"></label></div><label class="field"><span>参数写入命令模板</span><textarea v-model="plan.commandTemplate" rows="2" placeholder="按固件协议填写，例如 PID,{request_id},{id},{kp},{ki},{kd}"></textarea><small>变量：{id}、{order}、{kp}、{ki}、{kd}、{request_id}。应答确认需携带本轮 ID。</small></label><label v-if="plan.route === 'feedback'" class="field"><span>反馈执行方式</span><select v-model="plan.mode"><option value="bounded-auto" :disabled="plan.confirmation.mode === 'manual'">授权范围内自动迭代</option><option value="manual">只生成建议，逐轮人工执行</option></select></label></div></details>
          <details class="settings-section" :open="suiteSettingsOpen" @toggle="suiteSettingsOpen = ($event.target as HTMLDetailsElement).open"><summary>套组提示词与能力 <span>{{ selectedSuite.skills.length }} 项约束</span></summary><div class="details-body"><label class="field"><span>实验名称</span><input v-model="plan.name" placeholder="为本次实验命名"></label><label v-if="modelSource !== 'ai' || plan.route !== 'model'" class="field"><span>对象与工作点</span><textarea v-model="plan.description" rows="3" placeholder="说明执行器、传感器、单位、工况与已知限制。"></textarea></label><label class="field"><span>补充提示词约束</span><textarea v-model="plan.prompt" rows="3" placeholder="补充调参经验、任务要求与约束；提示词不会扩大写入权限。"></textarea></label><p class="field-note">基础约束与 skills 随请求发送；本地参数边界和停止规则始终生效。</p><ul class="capability-list"><li v-for="skill in plan.suite?.skills" :key="skill.id"><strong>{{ skill.title }}</strong><p>{{ skill.instructions }}</p></li></ul><p class="field-note">工具：本机 PID 解算、AI 有界反馈建议。套组是可分享的结构化配置。</p><details class="base-prompt"><summary>查看场景基础提示词</summary><p>{{ plan.suite?.prompt }}</p></details></div></details>
        </fieldset>
        <div v-else class="result-pane">
          <p class="field-note">{{ connectionLabel }} · {{ !connected ? '离线计算' : props.demo ? '演示遥测' : '设备遥测' }}</p><p v-if="isWorking" class="working-message" role="status">{{ autoProgress || '正在处理当前轮次；配置暂时锁定' }}</p>
          <section v-if="currentProposal" class="proposal-review" aria-label="参数候选"><div class="result-heading"><h3>{{ currentProposal.evidence?.tool === 'pid-solver' ? '本机模型计算候选' : 'AI 反馈候选' }}</h3><span>{{ trialStateName(currentProposal.status) }}</span></div><p class="proposal-rationale">{{ proposalRationale }}</p><p class="field-note">{{ currentParams ? currentParamsLabel : '尚未配置设备基线；左列 0 仅为计算参考。' }}</p><div class="parameter-comparison"><div v-for="key in activeParameters" :key="key"><strong>{{ key.toUpperCase() }}</strong><code>{{ format(currentProposal.before[key]) }}</code><span>→</span><code>{{ format(currentProposal.candidate[key]) }}</code></div></div><pre v-if="currentProposal.command" class="command-preview"><code>{{ currentProposal.command }}</code></pre><p v-if="!isTrialForPlan(currentProposal,plan,globalChannelStore.getGeneration())" class="field-error">配置已变化，重新生成候选后才能发送。</p><div v-if="currentProposal.status === 'proposed' && !isWorking" class="proposal-actions"><button type="button" class="secondary-button" :disabled="!executionEnabled || planErrors.length > 0 || !isTrialForPlan(currentProposal,plan,globalChannelStore.getGeneration())" @click="sendManualTrial(currentProposal)">核对命令并发送</button><button type="button" class="text-button" @click="currentProposal.status = 'rejected'; pendingTrialId = null">忽略候选</button></div><p v-if="currentProposal.status === 'queued'" class="field-note">仅已排队，驱动写入与设备生效尚未确认。</p><template v-if="executionEnabled && currentProposal.status === 'sent' && plan.confirmation.mode === 'manual'"><label class="check-field"><input v-model="manualConfirmation" type="checkbox"><span>我已在设备上核对，这组参数已生效。</span></label><button type="button" class="secondary-button" :disabled="!manualConfirmation || !awaitingManualConfirmation || stopRequested" @click="confirmManualTrial">确认并观察遥测</button></template><p v-else-if="currentProposal.status === 'sent'" class="field-note">等待{{ confirmationLabel(plan.confirmation.mode) }}，超时暂停。</p><dl v-if="currentProposal.metrics" class="trial-metrics"><div><dt>{{ plan.goal.mode === 'track' ? 'RMS 跟踪误差' : '稳态误差' }}</dt><dd>{{ format(plan.goal.mode === 'track' ? currentProposal.metrics.rmsTrackingError : currentProposal.metrics.steadyError,4) }} {{ plan.units.feedback }}</dd></div><div><dt>最大输出</dt><dd>{{ format(currentProposal.metrics.maximumOutputMagnitude) }} {{ plan.units.output }}</dd></div><div v-if="currentProposal.metrics.overshootPercent !== null"><dt>实测超调</dt><dd>{{ format(currentProposal.metrics.overshootPercent,2) }}%</dd></div></dl></section>
          <div v-else class="result-empty"><h3>在波形旁审阅参数候选</h3><p>每轮记录计算依据、命令写入、设备确认和遥测评价。候选与设备结果分别标记。</p><button type="button" class="text-button" @click="assistantPane = 'setup'">返回场景与设置</button></div>
          <details class="settings-section" :open="session.trials.length > 0"><summary>试验记录 <span>{{ session.trials.length }} 轮</span></summary><div class="details-body"><ol v-if="session.trials.length" class="trial-list"><li v-for="trial in session.trials.slice(0,30)" :key="trial.id"><div><time>{{ formatTimestamp(trial.createdAt) }}</time><span>{{ trialStateName(trial.status) }}</span></div><code>Kp {{ format(trial.candidate.kp) }} · Ki {{ format(trial.candidate.ki) }} · Kd {{ format(trial.candidate.kd) }}</code><p>{{ trial.metrics ? `${trial.metrics.sampleCount} 点设备遥测 · 误差 ${format(trial.metrics.steadyError,4)}` : trial.confirmation || '尚未设备确认 / 评价' }}</p></li></ol><p v-else class="field-note">还没有候选。配置后可先审阅一轮。</p><button v-if="session.bestVerified" type="button" class="text-button" @click="useLastVerified">载入最佳实测验证参数</button></div></details>
          <p v-if="session.stopReason" class="notice notice-warning">{{ session.stopReason }}</p><div v-if="planErrors.length" class="execution-check"><strong>发送与试验前待完成</strong><ul><li v-for="issue in openIssues" :key="issue">{{ issue }}</li></ul><button type="button" class="text-button" @click="assistantPane = 'setup'; channelSettingsOpen = parameterSettingsOpen = goalSettingsOpen = true">完善执行设置</button></div>
        </div>
      </template>
      <details class="suite-management"><summary>套组管理</summary><div class="suite-tools"><button type="button" :disabled="isWorking || aiBusy || modelBusy" @click="importInput?.click()">导入套组</button><button type="button" :disabled="!selectedSuite || isWorking" @click="exportPackage">导出套组</button><button type="button" :disabled="isWorking || aiBusy || modelBusy" @click="newExperiment">新建</button></div></details>
    </div>
    <footer v-if="selectedSuite && (assistantPane === 'setup' || isWorking)" class="scene-footer"><details v-if="candidateErrors.length || stageErrors.length" class="preflight-summary"><summary>还需完成 {{ candidateErrors.length + stageErrors.length }} 项信息</summary><ul><li v-for="issue in [...candidateErrors,...stageErrors]" :key="issue">{{ issue }}</li></ul><button type="button" class="text-button" @click="assistantPane = 'setup'; channelSettingsOpen = parameterSettingsOpen = goalSettingsOpen = true">展开配置项</button></details><p v-else-if="!executionEnabled" class="field-note">可审阅候选。实机执行需开启采集、设备保护与本次授权。</p><div class="main-actions"><button v-if="isWorking" type="button" class="stop-button" @click="requestStop()">停止调参流程</button><template v-else-if="plan.route === 'feedback' && plan.mode === 'bounded-auto'"><button type="button" class="primary-button" :disabled="!experimentCanStart || aiBusy || modelBusy || stageErrors.length > 0" @click="assistantPane = 'result'; runBoundedExperiment()">{{ aiBusy ? '正在请求候选…' : '检查并启动自动反馈' }}</button><button type="button" class="text-button" :disabled="!canProposeCandidate || aiBusy || modelBusy || stageErrors.length > 0" @click="generateManualCandidate">先审阅一轮</button></template><button v-else type="button" class="primary-button" :disabled="!canProposeCandidate || aiBusy || modelBusy || stageErrors.length > 0" @click="generateManualCandidate">{{ aiBusy ? '正在请求候选…' : plan.route === 'model' ? '计算 PID 候选' : '生成本轮 AI 候选' }}</button></div></footer>
    <input ref="importInput" class="visually-hidden" type="file" accept="application/json,.json" @change="importPackage">
  </section>
</template>
<script lang="ts">
function statusName(status: string): string {
  const labels: Record<string,string> = { draft:'配置草稿',ready:'候选待核对','awaiting-confirmation':'等待设备确认',collecting:'观察遥测',paused:'已暂停',completed:'当前目标达到',stopped:'已停止' };
  return labels[status] || status;
}
function trialStateName(status: string): string {
  const labels: Record<string,string> = { proposed:'待核对',queued:'仅已排队',sent:'驱动已写入 · 待确认',confirmed:'设备已确认',evaluated:'遥测已评价',rejected:'已忽略',failed:'未完成' };
  return labels[status] || status;
}
</script>
<style scoped>
.scene-assistant{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;width:100%;background:var(--bg-surface);color:var(--text-main);font-size:13px;user-select:text;container-type:inline-size}
.notice.notice-compact{align-items:center;padding:6px 10px;margin-bottom:12px}
.suite-management{border-top:1px solid var(--border-subtle);font-size:12px;color:var(--text-muted);margin-top:16px}
.suite-management summary{min-height:32px;padding:8px 0;cursor:pointer}
.suite-management .suite-tools{padding:0 0 8px}
@media (max-height:700px){.scene-assistant .scene-heading{padding-top:8px;padding-bottom:8px}.scene-assistant .scene-heading h2{font-size:14px}.scene-assistant .scene-scroll{padding-top:12px}.scene-assistant .result-heading{margin-top:8px}.scene-assistant .parameter-comparison>div{padding:8px 0}}
.scene-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:16px 16px 8px;flex-shrink:0}.scene-heading h2{font-size:16px;font-weight:600;line-height:1.4}.scene-heading p{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.5}.session-state{font-size:11px;white-space:nowrap;color:var(--text-muted);padding-top:3px}
.suite-tools{display:flex;gap:12px;padding:0 16px 12px;flex-shrink:0}.suite-tools button,.text-button{border:0;background:none;color:var(--text-muted);font:inherit;font-size:12px;cursor:pointer;min-height:32px;padding:4px 0;text-underline-offset:3px}.suite-tools button:hover:not(:disabled),.text-button:hover:not(:disabled){color:var(--accent-terracotta);text-decoration:underline}.text-button{color:var(--accent-terracotta)}
.assistant-tabs{display:flex;padding:0 16px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;gap:16px}.assistant-tabs button{border:0;border-bottom:2px solid transparent;background:none;padding:8px 0;color:var(--text-muted);font:inherit;min-height:36px;cursor:pointer}.assistant-tabs button.selected{color:var(--text-main);border-bottom-color:var(--accent-terracotta)}.assistant-tabs button:hover{color:var(--text-main)}
.scene-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--border-strong) var(--bg-surface);padding:16px}.scene-scroll::-webkit-scrollbar{width:8px}.scene-scroll::-webkit-scrollbar-thumb{background:var(--border-strong);border:2px solid var(--bg-surface);border-radius:8px}.scene-assistant ::selection{background:var(--accent-terracotta-soft);color:var(--text-main)}
.scene-form{border:0;padding:0;min-width:0}.scene-form:disabled{opacity:.72}.field{display:flex;flex-direction:column;gap:6px;min-width:0;margin-bottom:12px}.field>span{font-size:12px;line-height:1.45;display:flex;align-items:baseline;justify-content:space-between;gap:4px}.field small{font-size:12px;color:var(--text-muted);line-height:1.5}.field input,.field select,.field textarea{width:100%;min-width:0;min-height:32px;padding:6px 8px;font:inherit;font-size:13px;border:1px solid var(--border-strong);border-radius:5px;color:var(--text-main);background:var(--bg-base);caret-color:var(--accent-terracotta)}.field textarea{resize:vertical;line-height:1.6;min-height:64px}.field input::placeholder,.field textarea::placeholder{color:var(--text-muted);opacity:1}.field select{padding-right:20px}.field input:disabled,.field select:disabled,.field textarea:disabled{cursor:not-allowed}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field-note{font-size:12px;color:var(--text-muted);line-height:1.65;margin:0 0 12px;overflow-wrap:anywhere}.field-error{font-size:12px;line-height:1.6;color:var(--accent-rose);margin:8px 0;overflow-wrap:anywhere}
.scene-start>p{line-height:1.7;color:var(--text-muted);margin-bottom:16px}.suite-options{display:flex;flex-direction:column;border-top:1px solid var(--border-subtle);margin-bottom:20px}.suite-options button{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;border:0;border-bottom:1px solid var(--border-subtle);background:transparent;color:var(--text-main);padding:16px 0;font:inherit;cursor:pointer}.suite-options button:hover{background:var(--bg-elevated)}.suite-options strong{display:block;font-weight:600;font-size:14px;margin-bottom:6px}.suite-options small{display:block;font-size:12px;color:var(--text-muted);line-height:1.6}.suite-options svg{width:18px;height:18px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.route-choice{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0 12px}.route-choice button{display:flex;flex-direction:column;gap:6px;align-items:flex-start;text-align:left;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg-base);color:var(--text-main);padding:10px 12px;min-height:68px;font:inherit;cursor:pointer}.route-choice button:hover{background:var(--bg-elevated)}.route-choice button.selected{border-color:var(--accent-terracotta);background:var(--accent-terracotta-soft)}.route-choice strong{font-size:13px;font-weight:600}.route-choice small{font-size:12px;line-height:1.5;color:var(--text-muted)}.provider-row{display:flex;justify-content:space-between;gap:8px;align-items:center;border-top:1px solid var(--border-subtle);padding-top:4px;margin-bottom:12px}.provider-row>span{font-size:12px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-section{margin:16px 0;padding-top:16px;border-top:1px solid var(--border-subtle)}.model-section h3,.result-pane h3{font-size:14px;line-height:1.5;font-weight:600;margin:0 0 12px}.physical-inputs{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.model-notes{font-size:12px;color:var(--accent-amber);line-height:1.6;margin:8px 0 12px}.model-notes p+p{margin-top:4px}.model-assumptions,.base-prompt{margin:12px 0;font-size:12px;color:var(--text-muted);line-height:1.65}.model-assumptions summary,.base-prompt summary{cursor:pointer;min-height:32px}.model-assumptions ul{padding-left:18px}.model-draft{padding:12px 0;font-size:12px;line-height:1.6}.model-draft p{color:var(--text-muted);margin-bottom:8px}.model-draft code{font:12px/1.7 var(--font-mono);overflow-wrap:anywhere}.execution-context{padding-top:12px;border-top:1px solid var(--border-subtle)}
.settings-section{border-top:1px solid var(--border-subtle)}.settings-section>summary{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;padding:12px 0;min-height:44px;font-weight:500;list-style:none}.settings-section>summary::before{content:'';border:solid var(--text-muted);border-width:0 1.5px 1.5px 0;display:inline-block;padding:3px;transform:rotate(-45deg);margin-right:2px;flex-shrink:0}.settings-section[open]>summary::before{transform:rotate(45deg)}.settings-section>summary>span{margin-left:auto;font-size:12px;color:var(--text-muted);font-weight:400;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.details-body{padding:0 0 16px}.custom-stage-row{display:grid;grid-template-columns:minmax(0,1fr) 68px 28px;gap:8px;align-items:start}.custom-stage-row .field{margin-bottom:8px}.remove-stage{margin-top:26px}.channel-binding{display:grid;grid-template-columns:minmax(0,1fr) 88px;gap:12px}.channel-binding output{font:12px var(--font-mono);font-variant-numeric:tabular-nums;color:var(--text-muted)}.parameter-setting{padding:8px 0;border-bottom:1px solid var(--border-subtle);margin-bottom:8px}.parameter-setting h4{font-size:13px;font-weight:600;margin-bottom:8px}.parameter-values{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:8px}.parameter-values .field{margin-bottom:8px}.check-field{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.65;margin:12px 0}.check-field input{width:16px;height:16px;flex-shrink:0;margin-top:2px;accent-color:var(--accent-terracotta)}.capability-list{list-style:none}.capability-list li{padding:8px 0}.capability-list strong{font-size:12px;font-weight:500}.capability-list p{font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:4px}
.notice{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;border:1px solid var(--border-strong);border-radius:6px;padding:12px;margin:0 0 16px;background:var(--bg-elevated);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.notice strong{font-weight:600}.notice p{color:var(--text-muted);margin-top:4px}.notice-warning{border-color:color-mix(in srgb,var(--accent-amber) 50%,var(--border-strong))}.notice-error{border-color:var(--accent-rose)}.notice-success{border-color:var(--accent-emerald)}.icon-button{display:grid;place-items:center;border:0;border-radius:5px;background:transparent;color:var(--text-muted);min-width:28px;min-height:32px;cursor:pointer;flex-shrink:0}.icon-button:hover{background:var(--bg-elevated);color:var(--text-main)}.icon-button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.primary-button,.secondary-button,.stop-button{min-height:34px;padding:7px 12px;border:1px solid var(--border-strong);border-radius:5px;background:var(--bg-elevated);color:var(--text-main);font:inherit;font-size:13px;font-weight:500;cursor:pointer;line-height:1.5}.primary-button{background:var(--accent-action);border-color:var(--accent-action);color:#fff}.primary-button:hover:not(:disabled){background:color-mix(in srgb,var(--accent-action) 90%,#fff)}.secondary-button:hover:not(:disabled){background:var(--bg-base);border-color:var(--accent-terracotta)}.stop-button{background:var(--bg-base);border-color:var(--accent-rose);color:var(--accent-rose)}.stop-button:hover{background:color-mix(in srgb,var(--accent-rose) 12%,var(--bg-base))}.scene-assistant button:disabled{opacity:.48;cursor:not-allowed}.scene-assistant :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--accent-terracotta);outline-offset:2px}
.scene-footer{padding:12px 16px;border-top:1px solid var(--border-subtle);background:var(--bg-surface);flex-shrink:0}.scene-footer .field-note{margin-bottom:8px}.main-actions{display:flex;align-items:center;gap:12px}.main-actions>.primary-button,.main-actions>.stop-button{flex:1}.main-actions>.text-button{flex-shrink:0}.preflight-summary{font-size:12px;color:var(--text-muted);margin-bottom:8px}.preflight-summary summary{cursor:pointer;min-height:28px;line-height:1.5}.preflight-summary ul{max-height:144px;overflow:auto;padding:8px 0 8px 18px;line-height:1.6}.preflight-summary li+li{margin-top:4px}
.result-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin:20px 0 8px}.result-heading h3{margin:0}.result-heading>span{font-size:11px;color:var(--text-muted);line-height:1.6;text-align:right}.proposal-rationale{font-size:13px;line-height:1.65;margin-bottom:12px;overflow-wrap:anywhere}.parameter-comparison{border-top:1px solid var(--border-subtle);margin:12px 0}.parameter-comparison>div{display:grid;grid-template-columns:40px 1fr 16px 1fr;gap:8px;padding:10px 0;border-bottom:1px solid var(--border-subtle);align-items:center}.parameter-comparison strong{font-size:12px}.parameter-comparison code{font:13px var(--font-mono);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.parameter-comparison span{font-size:12px;color:var(--text-muted)}.parameter-comparison code:last-child{color:var(--accent-terracotta)}.command-preview{font:12px/1.7 var(--font-mono);padding:8px;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:5px;white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:12px}.proposal-actions{display:flex;align-items:center;gap:12px;margin:12px 0 20px}.trial-metrics{font-size:12px;margin:12px 0 20px}.trial-metrics div{display:flex;justify-content:space-between;gap:8px;padding:6px 0}.trial-metrics dt{color:var(--text-muted)}.trial-metrics dd{font-variant-numeric:tabular-nums}.trial-list{list-style:none}.trial-list li{padding:12px 0;border-bottom:1px solid var(--border-subtle)}.trial-list li>div{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text-muted);margin-bottom:8px}.trial-list code{font:12px/1.7 var(--font-mono);overflow-wrap:anywhere}.trial-list p{font-size:12px;line-height:1.6;color:var(--text-muted);margin-top:4px}.result-empty{padding:20px 0}.result-empty p,.working-message{line-height:1.65;font-size:12px;color:var(--text-muted);margin-bottom:12px}.execution-check{margin-top:16px;font-size:12px;line-height:1.6}.execution-check ul{padding:8px 0 8px 18px;color:var(--text-muted)}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
@container (max-width:360px){.scene-heading,.scene-scroll,.scene-footer{padding-left:12px;padding-right:12px}.suite-tools,.assistant-tabs{padding-left:12px;padding-right:12px}.form-row,.physical-inputs{gap:8px}.route-choice button{padding:10px 8px}.main-actions{gap:8px}.main-actions>.primary-button{font-size:12px;padding:7px 8px}.channel-binding{grid-template-columns:minmax(0,1fr) 72px;gap:8px}.settings-section>summary>span{max-width:38%}.parameter-values{gap:4px}}
@media(prefers-reduced-motion:no-preference){.primary-button,.secondary-button,.route-choice button{transition:background-color 160ms ease,border-color 160ms ease}.settings-section>summary::before{transition:transform 160ms ease}}
</style>

<style scoped>
.approval-dialog{position:fixed;inset:0;margin:auto;width:min(560px,calc(100vw - 40px));max-height:calc(100vh - 48px);overflow:auto;padding:24px;background:var(--bg-surface);color:var(--text-main);border:1px solid var(--border-subtle);border-radius:12px}
.approval-dialog::backdrop{background:rgb(0 0 0 / .45)}
.approval-dialog h2{font-size:18px;line-height:1.4;margin:0 0 16px;font-weight:600}
.approval-copy{font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.approval-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}
</style>
