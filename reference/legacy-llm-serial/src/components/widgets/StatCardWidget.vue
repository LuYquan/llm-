<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { StatCardConfig } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';
import { useWidgetStore } from '../../stores/widgetStore';

const props = defineProps<{
  config: StatCardConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const store = useWidgetStore();

const stats = ref<{
  mean: number;
  min: number;
  max: number;
  p2p: number;
  stdDev: number;
  count: number;
}>({
  mean: 0,
  min: 0,
  max: 0,
  p2p: 0,
  stdDev: 0,
  count: 0,
});

const statId = `stat_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function updateStats() {
  if (!props.config.channel) {
    stats.value = { mean: 0, min: 0, max: 0, p2p: 0, stdDev: 0, count: 0 };
    return;
  }

  const latestPt = globalChannelStore.latest(props.config.channel);
  if (!latestPt) {
    stats.value = { mean: 0, min: 0, max: 0, p2p: 0, stdDev: 0, count: 0 };
    return;
  }

  const windowSec = props.config.time_window || 5;
  const toT = latestPt.t;
  const fromT = toT - windowSec;

  const snap = globalChannelStore.snapshot(props.config.channel, fromT, toT);
  const n = snap.count;

  if (n === 0) {
    stats.value = { mean: 0, min: 0, max: 0, p2p: 0, stdDev: 0, count: 0 };
    return;
  }

  const arr = snap.values;
  const meta = store.getChannelMeta(props.config.channel);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i++) {
    const v = arr[i] * meta.scale + meta.yOffset;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const v = arr[i] * meta.scale + meta.yOffset;
    const diff = v - mean;
    varSum += diff * diff;
  }
  const stdDev = Math.sqrt(varSum / n);

  stats.value = {
    mean: Number(mean.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    p2p: Number((max - min).toFixed(2)),
    stdDev: Number(stdDev.toFixed(2)),
    count: n,
  };
}

onMounted(() => {
  globalRenderScheduler.register(statId, updateStats, {
    tabId: props.tabId,
    fpsLimit: 10, // 10Hz 统计计算
  });
});

onUnmounted(() => {
  globalRenderScheduler.unregister(statId);
});
</script>

<template>
  <div class="stat-card-container">
    <div class="stat-header">
      <span class="stat-title">实时信号统计 (最近 {{ config.time_window || 5 }}s)</span>
      <span class="stat-ch font-mono">{{ config.channel || '未绑定' }}</span>
    </div>

    <div class="stat-grid">
      <div class="stat-cell">
        <span class="cell-label">平均值 Mean</span>
        <span class="cell-val font-mono">{{ stats.count > 0 ? stats.mean : '--' }}</span>
      </div>
      <div class="stat-cell">
        <span class="cell-label">峰峰值 Pk-Pk</span>
        <span class="cell-val font-mono text-cyan">{{ stats.count > 0 ? stats.p2p : '--' }}</span>
      </div>
      <div class="stat-cell">
        <span class="cell-label">最小值 Min</span>
        <span class="cell-val font-mono">{{ stats.count > 0 ? stats.min : '--' }}</span>
      </div>
      <div class="stat-cell">
        <span class="cell-label">最大值 Max</span>
        <span class="cell-val font-mono">{{ stats.count > 0 ? stats.max : '--' }}</span>
      </div>
      <div class="stat-cell">
        <span class="cell-label">标准差 σ</span>
        <span class="cell-val font-mono">{{ stats.count > 0 ? stats.stdDev : '--' }}</span>
      </div>
      <div class="stat-cell">
        <span class="cell-label">采样点数 N</span>
        <span class="cell-val font-mono text-emerald">{{ stats.count }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stat-card-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 10px;
  box-sizing: border-box;
  background: var(--bg-surface, #272623);
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
}

.stat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-subtle, #383633);
  padding-bottom: 6px;
  margin-bottom: 8px;
}

.stat-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #9E9C94);
}

.stat-ch {
  font-size: 10px;
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  border: 1px solid var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25));
  padding: 1px 5px;
  border-radius: 3px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  flex: 1;
}

.stat-cell {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.cell-label {
  font-size: 9px;
  color: var(--text-soft, #706E66);
  margin-bottom: 2px;
}

.cell-val {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-main, #ECEAE4);
}

.text-cyan {
  color: var(--accent-terracotta, #DA7756) !important;
}

.text-emerald {
  color: #7AA89B !important;
}
</style>
