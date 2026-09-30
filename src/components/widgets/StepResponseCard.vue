<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { StepCardConfig } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import type { StepResponseMetrics } from '../../core/analysis/types';
import { analysisWorker, type CancellableAnalysis, type StepAnalysisResult } from '../../services/analysis/analysis-worker-client';

import { globalRenderScheduler } from '../../core/widget/renderScheduler';

const props = defineProps<{
  config: StepCardConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const metrics = ref<StepResponseMetrics | null>(null);
const lastCaptureTime = ref<string>('--');
const analysisMessage = ref('等待有效阶跃数据…');
const isAnalyzing = ref(false);
let analysisJob: CancellableAnalysis<StepAnalysisResult> | null = null;
const stepCardId = `step_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

async function captureStep() {
  analysisJob?.cancel();
  analysisJob = null;
  isAnalyzing.value = false;
  metrics.value = null;

  const actualCh = props.config.actual_channel == null ? '' : String(props.config.actual_channel).trim();
  const targetCh = props.config.target_channel == null ? '' : String(props.config.target_channel).trim();
  if (!actualCh || !targetCh || actualCh === targetCh) {
    analysisMessage.value = '请绑定不同的实际响应通道和目标通道。';
    return;
  }

  const actualSnap = globalChannelStore.snapshot(actualCh);
  const targetSnap = globalChannelStore.snapshot(targetCh);
  if (actualSnap.count < 10 || targetSnap.count < 2) {
    analysisMessage.value = '等待至少 10 个响应样本和包含阶跃的目标数据。';
    return;
  }

  const baseline = targetSnap.values[0];
  let stepIndex = -1;
  for (let index = 1; index < targetSnap.count; index++) {
    if (!Number.isFinite(targetSnap.timestamps[index])
      || targetSnap.timestamps[index] <= targetSnap.timestamps[index - 1]
      || !Number.isFinite(targetSnap.values[index])) {
      analysisMessage.value = '目标通道含无效或非递增样本，无法定位阶跃。';
      return;
    }
    if (stepIndex < 0 && Math.abs(targetSnap.values[index] - baseline) > 1e-4) stepIndex = index;
  }
  if (stepIndex < 0) {
    analysisMessage.value = '目标通道没有可识别阶跃。';
    return;
  }

  const generation = globalChannelStore.getGeneration();
  const sessionContext = globalChannelStore.getSessionContext();
  const job = analysisWorker.runStep(
    actualSnap.timestamps,
    actualSnap.values,
    targetSnap.values[targetSnap.count - 1],
    { bandPercent: props.config.band_percent ?? 0.02, stepTime: targetSnap.timestamps[stepIndex] },
    {
      source: 'live',
      ...sessionContext,
      generation,
      channelIds: [actualCh, targetCh],
    },
  );
  analysisJob = job;
  isAnalyzing.value = true;
  analysisMessage.value = '正在后台计算阶跃指标…';
  try {
    const response = await job.promise;
    if (analysisJob?.id !== job.id || generation !== globalChannelStore.getGeneration()) return;
    metrics.value = response.result;
    analysisMessage.value = response.result ? '' : `未计算：${response.quality.reason || '数据质量不符合要求'}`;
    if (response.result) {
    const d = new Date();
    lastCaptureTime.value = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    }
  } catch (error) {
    if (analysisJob?.id !== job.id) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!/取消/.test(message)) analysisMessage.value = `阶跃分析失败：${message}`;
  } finally {
    if (analysisJob?.id === job.id) {
      analysisJob = null;
      isAnalyzing.value = false;
    }
  }
}

onMounted(() => {
  captureStep();
  if (props.config.auto_refresh) {
    globalRenderScheduler.register(stepCardId, captureStep, {
      tabId: props.tabId,
      fpsLimit: 1, // 1Hz 自动重测，非激活 Tab 自动静默保护性能
    });
  }
});

onUnmounted(() => {
  analysisJob?.cancel();
  analysisJob = null;
  globalRenderScheduler.unregister(stepCardId);
});
</script>

<template>
  <div class="step-card-container">
    <div class="step-card-header">
      <div class="header-left">
        <span class="icon">🎯</span>
        <span class="title">阶跃响应动力学指标</span>
      </div>
      <button class="btn-refresh" :disabled="isAnalyzing" @click="captureStep" title="立即重新提取阶跃特征">
        {{ isAnalyzing ? '计算中…' : '↻ 刷新' }}
      </button>
    </div>

    <!-- 核心指标网格 -->
    <div class="step-metrics-body">
      <template v-if="metrics">
        <div class="metric-row">
          <div class="metric-item">
            <span class="metric-label">超调量 Mp</span>
            <span
              class="metric-val font-mono"
              :class="{
                'val-good': metrics.overshoot_pct <= 15,
                'val-warn': metrics.overshoot_pct > 15 && metrics.overshoot_pct <= 30,
                'val-bad': metrics.overshoot_pct > 30,
              }"
            >
              {{ metrics.overshoot_pct }}%
            </span>
          </div>

          <div class="metric-item">
            <span class="metric-label">调节时间 ts</span>
            <span class="metric-val font-mono">
              {{ metrics.settling_time_s != null ? `${(metrics.settling_time_s * 1000).toFixed(0)} ms` : '--' }}
            </span>
          </div>
        </div>

        <div class="metric-row">
          <div class="metric-item">
            <span class="metric-label">上升时间 tr</span>
            <span class="metric-val font-mono">
              {{ metrics.rise_time_s != null ? `${(metrics.rise_time_s * 1000).toFixed(0)} ms` : '--' }}
            </span>
          </div>

          <div class="metric-item">
            <span class="metric-label">稳态误差 ess</span>
            <span class="metric-val font-mono text-cyan">
              {{ metrics.steady_state_error }}
            </span>
          </div>
        </div>

        <div class="metric-row">
          <div class="metric-item">
            <span class="metric-label">阻尼比 ζ</span>
            <span class="metric-val font-mono text-amber">
              {{ metrics.damping_ratio ?? '--' }}
            </span>
          </div>

          <div class="metric-item">
            <span class="metric-label">收敛判定</span>
            <span
              class="metric-badge"
              :class="metrics.is_stable ? 'badge-success' : 'badge-danger'"
            >
              {{ metrics.is_stable ? '✓ 稳定收敛' : '⚠ 振荡/未收敛' }}
            </span>
          </div>
        </div>
      </template>

      <div v-else class="step-empty">
        <span class="empty-icon">{{ isAnalyzing ? '⏳' : '—' }}</span>
        <span class="empty-text">{{ analysisMessage || '等待阶跃特征触发...' }}</span>
        <span class="empty-sub">绑定通道: [{{ config.actual_channel }}] 跟踪 [{{ config.target_channel }}]</span>
      </div>
    </div>

    <!-- 底部状态 -->
    <div class="step-footer">
      <span>最近捕获: {{ lastCaptureTime }}</span>
      <span class="band-tag">±{{ ((config.band_percent || 0.02) * 100).toFixed(0) }}% 误差带</span>
    </div>
  </div>
</template>

<style scoped>
.step-card-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px 12px;
  box-sizing: border-box;
  background: var(--bg-surface, #272623);
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
}

.step-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-subtle, #383633);
  padding-bottom: 6px;
  margin-bottom: 6px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 5px;
}

.title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.btn-refresh {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-refresh:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

.step-metrics-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  justify-content: center;
}

.metric-row {
  display: flex;
  gap: 6px;
}

.metric-item {
  flex: 1;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
}

.metric-label {
  font-size: 9px;
  color: var(--text-soft, #706E66);
  margin-bottom: 2px;
}

.metric-val {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-main, #ECEAE4);
}

.val-good {
  color: #7AA89B !important;
}

.val-warn {
  color: #E59E38 !important;
}

.val-bad {
  color: #E06D85 !important;
}

.text-cyan {
  color: var(--accent-terracotta, #DA7756) !important;
}

.text-amber {
  color: #fbbf24 !important;
}

.metric-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 4px;
  border-radius: 3px;
  text-align: center;
  margin-top: 2px;
}

.badge-success {
  background: rgba(52, 211, 153, 0.2);
  color: #34d399;
}

.badge-danger {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.step-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 0;
  color: var(--text-muted, #9E9C94);
}

.empty-icon {
  font-size: 20px;
}

.empty-text {
  font-size: 11px;
}

.empty-sub {
  font-size: 9px;
  color: var(--text-soft, #706E66);
  font-family: monospace;
}

.step-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-subtle, #383633);
  padding-top: 4px;
  font-size: 9px;
  color: var(--text-muted, #9E9C94);
  font-family: monospace;
}

.band-tag {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-muted, #9E9C94);
  padding: 1px 4px;
  border-radius: 2px;
}
</style>
