<script setup lang="ts">
import { ref, computed } from 'vue';
import { useSerialSession } from '../services/transport/session';
import type { StepSnapshot } from './SnapshotStream.vue';
import {
  diagnoseStep,
  type PidParams,
  type AiDiagnosisResult,
  type AiConfig,
  fetchAvailableModels,
  PROVIDER_DEFAULTS,
} from '../services/ai';

const props = defineProps<{
  activeSnapshot: StepSnapshot | null;
  aiConfig: AiConfig;
  isRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'update-config', config: AiConfig): void;
  (e: 'pid-applied', newPid: PidParams): void;
}>();

// 当前设备生效的 PID
const currentPid = ref<PidParams>({
  kp: 1.8,
  ki: 0.6,
  kd: 0.25,
});

// AI 诊断结果
const diagnosisResult = ref<AiDiagnosisResult | null>(null);
const isDiagnosing = ref(false);
const isApplying = ref(false);

// 安全防线拦截提示
const safetyError = ref<string | null>(null);
const applySuccessMsg = ref<string | null>(null);

// AI 配置弹窗/抽屉
const showConfigModal = ref(false);
const editConfig = ref<AiConfig>({ ...props.aiConfig });

// 动态拉取模型状态
const isFetchingModels = ref(false);
const fetchedModels = ref<string[]>([]);
const fetchModelsError = ref<string | null>(null);

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
  if (def.model) {
    editConfig.value.model = def.model;
  }
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
    if (list.length > 0) {
      if (!editConfig.value.model || !list.includes(editConfig.value.model)) {
        editConfig.value.model = list[0];
      }
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
  emit('update-config', editConfig.value);
  showConfigModal.value = false;
}

// 触发 AI 诊断
async function requestDiagnosis() {
  if (!props.activeSnapshot) return;
  isDiagnosing.value = true;
  safetyError.value = null;
  applySuccessMsg.value = null;

  try {
    const res = await diagnoseStep(
      props.activeSnapshot.metrics,
      currentPid.value,
      props.aiConfig
    );
    diagnosisResult.value = res;
  } catch (err: any) {
    safetyError.value = `诊断请求异常: ${err?.message || err}`;
  } finally {
    isDiagnosing.value = false;
  }
}

// 用户手动核准下发
const lastStablePid = ref<PidParams | null>(null);

async function applyRecommendation() {
  if (!diagnosisResult.value) return;
  isApplying.value = true;
  safetyError.value = null;
  applySuccessMsg.value = null;

  const targetPid = diagnosisResult.value.recommendation;
  const session = useSerialSession();

  try {
    // 经由 SafetyGuard 校验并下发
    const cmd = await session.applyPidParams(currentPid.value, targetPid);

    // 记录上一代稳定参数，支持一键回滚
    lastStablePid.value = { ...currentPid.value };
    currentPid.value = { ...targetPid };
    applySuccessMsg.value = `参数已通过 SafetyGuard 核准下发: ${cmd.trim()}`;
    emit('pid-applied', targetPid);

    setTimeout(() => {
      applySuccessMsg.value = null;
    }, 4000);
  } catch (err: any) {
    safetyError.value = typeof err === 'string' ? err : err?.message || '安全防线拦截';
  } finally {
    isApplying.value = false;
  }
}

// 一键回滚至上一次稳定参数 (安全防线保护)
const isRollingBack = ref(false);
async function rollbackLastStable() {
  if (!lastStablePid.value) return;
  isRollingBack.value = true;
  safetyError.value = null;
  applySuccessMsg.value = null;

  const targetPid = lastStablePid.value;
  const session = useSerialSession();

  try {
    const cmd = await session.applyPidParams(currentPid.value, targetPid);
    const oldCurrent = { ...currentPid.value };
    currentPid.value = { ...targetPid };
    lastStablePid.value = oldCurrent;
    applySuccessMsg.value = `已回滚至历史稳定参数: ${cmd.trim()}`;
    emit('pid-applied', targetPid);

    setTimeout(() => {
      applySuccessMsg.value = null;
    }, 4000);
  } catch (err: any) {
    safetyError.value = `回滚拦截: ${typeof err === 'string' ? err : err?.message || err}`;
  } finally {
    isRollingBack.value = false;
  }
}

// 计算参数变动差值
const deltas = computed(() => {
  if (!diagnosisResult.value) return { kp: 0, ki: 0, kd: 0 };
  const rec = diagnosisResult.value.recommendation;
  const cur = currentPid.value;
  return {
    kp: Number((rec.kp - cur.kp).toFixed(3)),
    ki: Number((rec.ki - cur.ki).toFixed(3)),
    kd: Number((rec.kd - cur.kd).toFixed(3)),
  };
});

function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta.toFixed(2)}`;
  if (delta < 0) return `${delta.toFixed(2)}`;
  return '0.00';
}
</script>

<template>
  <div class="ai-tuner-card">
    <div class="card-header">
      <div class="title-group">
        <div class="ai-avatar-badge">
          <img src="../assets/avatar.png" alt="AI 调参娘" class="ai-mascot-img" />
          <span class="online-dot" :class="{ 'is-diagnosing': isDiagnosing }"></span>
        </div>
        <div class="title-text-wrap">
          <span class="card-title">AI 调参娘</span>
          <span class="card-subtitle">PID 闭环智能专家</span>
        </div>
      </div>
      <div class="header-actions">
          <span class="provider-badge" :class="(aiConfig.api_key || aiConfig.api_key_configured || aiConfig.provider === 'ollama') ? 'badge-online' : 'badge-offline'">
          {{ (aiConfig.api_key || aiConfig.api_key_configured || aiConfig.provider === 'ollama') ? aiConfig.provider.toUpperCase() : '离线规则' }}
        </span>
        <button class="btn-config" @click="openConfig" title="配置 AI 模型与 API Key">
          ⚙️
        </button>
      </div>
    </div>

    <div class="card-body">
      <!-- 参数对比表 (Current vs Recommended) -->
      <div class="params-table font-mono">
        <div class="param-header-row">
          <span class="col-k">参数项</span>
          <span class="col-val">当前值</span>
          <span class="col-val">推荐值</span>
          <span class="col-diff">变动量</span>
        </div>

        <div class="param-row">
          <span class="col-k">Kp (比例)</span>
          <span class="col-val">{{ currentPid.kp.toFixed(2) }}</span>
          <span class="col-val col-rec">
            {{ diagnosisResult ? diagnosisResult.recommendation.kp.toFixed(2) : '--' }}
          </span>
          <span
            class="col-diff"
            :class="{
              'diff-up': deltas.kp > 0,
              'diff-down': deltas.kp < 0,
            }"
          >
            {{ diagnosisResult ? formatDelta(deltas.kp) : '--' }}
          </span>
        </div>

        <div class="param-row">
          <span class="col-k">Ki (积分)</span>
          <span class="col-val">{{ currentPid.ki.toFixed(2) }}</span>
          <span class="col-val col-rec">
            {{ diagnosisResult ? diagnosisResult.recommendation.ki.toFixed(2) : '--' }}
          </span>
          <span
            class="col-diff"
            :class="{
              'diff-up': deltas.ki > 0,
              'diff-down': deltas.ki < 0,
            }"
          >
            {{ diagnosisResult ? formatDelta(deltas.ki) : '--' }}
          </span>
        </div>

        <div class="param-row">
          <span class="col-k">Kd (微分)</span>
          <span class="col-val">{{ currentPid.kd.toFixed(2) }}</span>
          <span class="col-val col-rec">
            {{ diagnosisResult ? diagnosisResult.recommendation.kd.toFixed(2) : '--' }}
          </span>
          <span
            class="col-diff"
            :class="{
              'diff-up': deltas.kd > 0,
              'diff-down': deltas.kd < 0,
            }"
          >
            {{ diagnosisResult ? formatDelta(deltas.kd) : '--' }}
          </span>
        </div>
      </div>

      <!-- 诊断结论与理论依据 -->
      <div class="ai-report-box" v-if="diagnosisResult">
        <div class="report-section">
          <span class="section-title">💡 诊断结论</span>
          <p class="section-content">{{ diagnosisResult.diagnosis }}</p>
        </div>

        <div class="report-section">
          <span class="section-title">📐 控制工程原理</span>
          <p class="section-content">{{ diagnosisResult.rationale }}</p>
        </div>

        <div class="report-section section-warn">
          <span class="section-title">⚠️ 风险预警</span>
          <p class="section-content">{{ diagnosisResult.risk_warning }}</p>
        </div>
      </div>

      <div class="empty-hint" v-else>
        <span class="hint-icon">🔍</span>
        <span>
          {{ activeSnapshot ? '已选择阶跃切片，点击下方按钮开始 AI 诊断' : '请先触发阶跃并选择一组历史切片' }}
        </span>
      </div>

      <!-- 安全拦截与成功提示 -->
      <div class="alert alert-danger" v-if="safetyError">
        <span class="alert-icon">🛡️</span>
        <span class="alert-text">{{ safetyError }}</span>
      </div>

      <div class="alert alert-success" v-if="applySuccessMsg">
        <span class="alert-icon">✅</span>
        <span class="alert-text">{{ applySuccessMsg }}</span>
      </div>

      <!-- 底部操作按钮组 -->
      <div class="action-buttons">
        <button
          class="btn-diagnose"
          :disabled="!activeSnapshot || isDiagnosing"
          @click="requestDiagnosis"
        >
          <span v-if="isDiagnosing">分析中...</span>
          <span v-else>请求 AI 诊断</span>
        </button>

        <button
          class="btn-apply"
          :disabled="!diagnosisResult || isApplying || !isRunning"
          @click="applyRecommendation"
          title="经由 SafetyGuard 安全防线校验后向串口发送 SET 指令"
        >
          <span v-if="isApplying">校验下发中...</span>
          <span v-else>核准下发 (SafetyGuard)</span>
        </button>

        <button
          v-if="lastStablePid"
          class="btn-rollback"
          :disabled="isApplying || isRollingBack || !isRunning"
          @click="rollbackLastStable"
          title="一键回滚至上一次成功生效的稳定参数"
        >
          <span v-if="isRollingBack">回滚中...</span>
          <span v-else>⏪ 一键回滚</span>
        </button>
      </div>
    </div>

    <!-- AI 配置模态框 -->
    <div class="config-modal-backdrop" v-if="showConfigModal" @click.self="showConfigModal = false">
      <div class="config-modal">
        <div class="modal-header">
          <span class="modal-title">AI 服务接入配置</span>
          <button class="modal-close" @click="showConfigModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">服务商 (Provider)</label>
            <select class="form-select" v-model="editConfig.provider" @change="onProviderChange">
              <option value="deepseek">DeepSeek (推荐)</option>
              <option value="openai">OpenAI (ChatGPT)</option>
              <option value="ollama">Ollama (本地大模型)</option>
              <option value="custom">其他 / 自定义 (OpenAI 兼容)</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">API 基础地址 (Base URL)</label>
            <input
              type="text"
              class="form-input font-mono"
              v-model="editConfig.api_url"
              :placeholder="editConfig.provider === 'ollama' ? 'http://127.0.0.1:11434' : (editConfig.provider === 'custom' ? 'https://api.your-provider.com/v1' : 'https://api.deepseek.com/v1')"
            />
          </div>

          <div class="form-group">
            <label class="form-label">API Key {{ editConfig.provider === 'ollama' ? '(本地 Ollama 通常无需 Key)' : (editConfig.api_key_configured ? '(已安全保存，留空保持不变)' : '(留空将使用离线规则)') }}</label>
            <div class="key-input-row">
              <input
                type="password"
                class="form-input font-mono"
                v-model="editConfig.api_key"
                :placeholder="editConfig.provider === 'ollama' ? '本地服务无需 Key' : (editConfig.api_key_configured ? '已配置；输入新 Key 可替换' : 'sk-...')"
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
            <div class="form-label-row">
              <label class="form-label">模型名称 (Model)</label>
              <button
                type="button"
                class="btn-fetch-models"
                :disabled="isFetchingModels"
                @click="handleFetchModels"
                title="根据当前 API Key 与基础地址拉取可用模型列表"
              >
                <span v-if="isFetchingModels" class="spinning-icon">⏳</span>
                <span>{{ isFetchingModels ? '正在拉取...' : '📥 导入模型' }}</span>
              </button>
            </div>

            <!-- 若已成功导入模型列表，展示下拉菜单供挑选 -->
            <div v-if="fetchedModels.length > 0" class="model-select-wrapper">
              <select class="form-select font-mono" v-model="editConfig.model">
                <option value="" disabled>-- 请在导入的模型中选择 --</option>
                <option
                  v-if="editConfig.model && !fetchedModels.includes(editConfig.model)"
                  :value="editConfig.model"
                >
                  ✏️ 自定义: {{ editConfig.model }}
                </option>
                <option v-for="m in fetchedModels" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>

            <!-- 同时保留手动输入输入框 -->
            <input
              type="text"
              class="form-input font-mono"
              v-model="editConfig.model"
              :placeholder="fetchedModels.length > 0 ? '微调或手动输入模型名称' : (editConfig.provider === 'ollama' ? 'llama3' : (editConfig.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'))"
            />

            <span v-if="fetchModelsError" class="fetch-models-error">{{ fetchModelsError }}</span>
            <span v-else-if="fetchedModels.length > 0" class="fetch-models-success">已成功获取 {{ fetchedModels.length }} 个模型，可直接在上方下拉选取</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showConfigModal = false">取消</button>
          <button class="btn-save" @click="saveConfig">保存配置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-tuner-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.card-header {
  padding: 8px 12px;
  background-color: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-avatar-badge {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1.5px solid var(--accent-cyan, #0ea5e9);
  box-shadow: 0 0 8px rgba(14, 165, 233, 0.4);
  background-color: var(--bg-base);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ai-mascot-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.online-dot {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #10b981;
  border: 1.5px solid var(--bg-base);
}

.online-dot.is-diagnosing {
  background-color: #f59e0b;
  animation: pulse-dot 1s infinite alternate;
}

@keyframes pulse-dot {
  from { transform: scale(0.9); opacity: 0.6; }
  to { transform: scale(1.3); opacity: 1; box-shadow: 0 0 6px #f59e0b; }
}

.title-text-wrap {
  display: flex;
  flex-direction: column;
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.card-subtitle {
  font-size: 9px;
  color: var(--text-muted);
  letter-spacing: 0.3px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.provider-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
}

.badge-online {
  background-color: rgba(14, 165, 233, 0.15);
  color: var(--accent-cyan);
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.badge-offline {
  background-color: rgba(100, 116, 139, 0.2);
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
}

.btn-config {
  background: none;
  border: none;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.2s;
}

.btn-config:hover {
  opacity: 1;
}

.card-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.params-table {
  background-color: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}

.param-header-row,
.param-row {
  display: grid;
  grid-template-columns: 80px 1fr 1fr 1fr;
  align-items: center;
  text-align: right;
}

.param-header-row {
  color: var(--text-muted);
  font-size: 10px;
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 3px;
  margin-bottom: 2px;
}

.col-k {
  text-align: left;
  color: var(--text-secondary);
}

.col-val {
  color: var(--text-primary);
  font-weight: 500;
}

.col-rec {
  color: var(--accent-terracotta);
  font-weight: 600;
}

.col-diff {
  color: var(--text-muted);
  font-weight: 500;
}

.diff-up {
  color: var(--accent-emerald);
}

.diff-down {
  color: var(--accent-amber);
}

.ai-report-box {
  background-color: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 11px;
  max-height: 180px;
  overflow-y: auto;
}

.report-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.section-title {
  font-weight: 600;
  color: var(--accent-cyan);
  font-size: 11px;
}

.section-content {
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}

.section-warn .section-title {
  color: var(--accent-amber);
}

.empty-hint {
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
}

.hint-icon {
  font-size: 18px;
  opacity: 0.6;
}

.alert {
  padding: 6px 10px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.alert-danger {
  background-color: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--accent-rose);
}

.alert-success {
  background-color: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: var(--accent-emerald);
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.btn-diagnose {
  flex: 1;
  padding: 6px 12px;
  background-color: rgba(14, 165, 233, 0.15);
  border: 1px solid rgba(14, 165, 233, 0.4);
  color: var(--accent-cyan);
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-diagnose:hover:not(:disabled) {
  background-color: rgba(14, 165, 233, 0.25);
}

.btn-apply {
  flex: 1;
  padding: 6px 12px;
  background-color: #059669;
  border: 1px solid #10b981;
  color: #fff;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-apply:hover:not(:disabled) {
  background-color: #047857;
}

.btn-diagnose:disabled,
.btn-apply:disabled,
.btn-rollback:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-rollback {
  padding: 6px 10px;
  background-color: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: #f59e0b;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}

.btn-rollback:hover:not(:disabled) {
  background-color: rgba(245, 158, 11, 0.25);
}

/* 模态框 */
.config-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.config-modal {
  width: 400px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}

.modal-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}

.modal-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.btn-fetch-models {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background-color: rgba(14, 165, 233, 0.15);
  border: 1px solid rgba(14, 165, 233, 0.4);
  color: var(--accent-cyan);
  border-radius: 3px;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-fetch-models:hover:not(:disabled) {
  background-color: rgba(14, 165, 233, 0.25);
  border-color: var(--accent-cyan);
}

.btn-fetch-models:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinning-icon {
  display: inline-block;
  font-size: 10px;
}

.model-select-wrapper {
  margin-bottom: 2px;
}

.fetch-models-error {
  font-size: 10px;
  color: #f87171;
  line-height: 1.3;
}

.fetch-models-success {
  font-size: 10px;
  color: #34d399;
  line-height: 1.3;
}

.form-input,
.form-select {
  background-color: var(--bg-base);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-primary);
  outline: none;
}

.form-input:focus,
.form-select:focus {
  border-color: var(--accent-cyan);
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

.modal-footer {
  padding: 8px 14px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn-cancel {
  background: none;
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  border-radius: 3px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}

.btn-save {
  background-color: var(--accent-terracotta);
  border: 1px solid rgba(218, 119, 86, 0.6);
  color: #fff;
  border-radius: 3px;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
