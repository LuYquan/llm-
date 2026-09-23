<script setup lang="ts">
import { ref, computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { StepSnapshot } from './SnapshotStream.vue';
import {
  diagnoseStep,
  type PidParams,
  type AiDiagnosisResult,
  type AiConfig,
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

function openConfig() {
  editConfig.value = { ...props.aiConfig };
  showConfigModal.value = true;
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
async function applyRecommendation() {
  if (!diagnosisResult.value) return;
  isApplying.value = true;
  safetyError.value = null;
  applySuccessMsg.value = null;

  const targetPid = diagnosisResult.value.recommendation;

  try {
    // 经由 Rust 端 SafetyGuard 校验并下发
    const cmd = await invoke<string>('validate_and_apply_pid', {
      currentPid: currentPid.value,
      newPid: targetPid,
    });

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
        <span class="ai-sparkle">✨</span>
        <span class="card-title">AI 调参专家 (闭环核准)</span>
      </div>
      <div class="header-actions">
        <span class="provider-badge" :class="aiConfig.api_key ? 'badge-online' : 'badge-offline'">
          {{ aiConfig.api_key ? aiConfig.provider.toUpperCase() : '离线规则' }}
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
            <select class="form-select" v-model="editConfig.provider">
              <option value="deepseek">DeepSeek (推荐)</option>
              <option value="openai">OpenAI (ChatGPT)</option>
              <option value="ollama">Ollama (本地大模型)</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">API 基础地址</label>
            <input
              type="text"
              class="form-input font-mono"
              v-model="editConfig.api_url"
              placeholder="https://api.deepseek.com/v1"
            />
          </div>

          <div class="form-group">
            <label class="form-label">API Key (留空将自动回退离线规则)</label>
            <input
              type="password"
              class="form-input font-mono"
              v-model="editConfig.api_key"
              placeholder="sk-..."
            />
          </div>

          <div class="form-group">
            <label class="form-label">模型名称</label>
            <input
              type="text"
              class="form-input font-mono"
              v-model="editConfig.model"
              placeholder="deepseek-chat"
            />
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
  background-color: rgba(24, 34, 50, 0.6);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-sparkle {
  font-size: 14px;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
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
  background-color: rgba(11, 15, 23, 0.6);
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
  color: var(--accent-cyan);
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
  background-color: rgba(15, 23, 42, 0.5);
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
.btn-apply:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  width: 360px;
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

.form-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.form-input,
.form-select {
  background-color: rgba(11, 15, 23, 0.8);
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
  background-color: #0284c7;
  border: 1px solid #0ea5e9;
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
