<script setup lang="ts">
import { computed } from 'vue';
import type { RecordingReplaySample } from '../services/recording/replay-decoder';
import { buildReplayChartSeries, type ReplayChartPoint } from '../services/recording/replay-chart';

const props = defineProps<{
  samples: RecordingReplaySample[];
}>();

const palette = ['#DA7756', '#7AA89B', '#759CB5', '#E59E38', '#9D6CF0', '#E06D85', '#5EA880', '#4F85A6'];
const width = 1000;
const height = 240;
const padding = { left: 48, right: 16, top: 14, bottom: 28 };
const plotWidth = width - padding.left - padding.right;
const plotHeight = height - padding.top - padding.bottom;

const series = computed(() => buildReplayChartSeries(props.samples));
const bounds = computed(() => {
  const points = series.value.flatMap((item) => item.points);
  if (points.length === 0) return null;
  const times = points.map((point) => point.timeSeconds);
  const values = points.map((point) => point.value);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueSpan = Math.max(1e-12, maxValue - minValue);
  return {
    minTime,
    maxTime: maxTime > minTime ? maxTime : minTime + 1,
    minValue: minValue - valueSpan * 0.05,
    maxValue: maxValue + valueSpan * 0.05,
  };
});

function xFor(timeSeconds: number): number {
  const range = bounds.value;
  if (!range) return padding.left;
  return padding.left + ((timeSeconds - range.minTime) / (range.maxTime - range.minTime)) * plotWidth;
}

function yFor(value: number): number {
  const range = bounds.value;
  if (!range) return padding.top + plotHeight / 2;
  return padding.top + (1 - (value - range.minValue) / (range.maxValue - range.minValue)) * plotHeight;
}

function pathFor(points: ReplayChartPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xFor(point.timeSeconds).toFixed(2)},${yFor(point.value).toFixed(2)}`).join(' ');
}

function formatValue(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : value.toPrecision(6);
}

function formatTime(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(3)} s`;
}
</script>

<template>
  <section class="replay-chart" aria-label="只读回放波形">
    <div class="replay-chart-heading">
      <strong>回放波形（只读）</strong>
      <span v-if="bounds">{{ formatTime(bounds.minTime) }} – {{ formatTime(bounds.maxTime) }} · {{ series.length }} 通道</span>
      <span v-else>等待可绘制样本</span>
    </div>
    <div v-if="bounds" class="replay-chart-frame">
      <svg :viewBox="`0 0 ${width} ${height}`" role="img" aria-label="记录样本波形图">
        <line :x1="padding.left" :x2="width - padding.right" :y1="padding.top + plotHeight" :y2="padding.top + plotHeight" class="replay-axis" />
        <line :x1="padding.left" :x2="padding.left" :y1="padding.top" :y2="padding.top + plotHeight" class="replay-axis" />
        <line :x1="padding.left" :x2="width - padding.right" :y1="padding.top + plotHeight / 2" :y2="padding.top + plotHeight / 2" class="replay-grid" />
        <path
          v-for="(item, index) in series"
          :key="item.channel"
          :d="pathFor(item.points)"
          class="replay-line"
          :style="{ stroke: palette[index % palette.length] }"
        />
        <text :x="padding.left" :y="height - 8" class="replay-label">{{ formatTime(bounds.minTime) }}</text>
        <text :x="width - padding.right" :y="height - 8" text-anchor="end" class="replay-label">{{ formatTime(bounds.maxTime) }}</text>
        <text :x="padding.left - 8" :y="padding.top + 4" text-anchor="end" class="replay-label">{{ formatValue(bounds.maxValue) }}</text>
        <text :x="padding.left - 8" :y="padding.top + plotHeight" text-anchor="end" class="replay-label">{{ formatValue(bounds.minValue) }}</text>
      </svg>
    </div>
    <div v-if="series.length" class="replay-chart-legend">
      <span v-for="(item, index) in series" :key="item.channel">
        <i :style="{ background: palette[index % palette.length] }"></i>{{ item.channel }} · {{ item.points.length.toLocaleString() }} 点
      </span>
    </div>
    <p v-else class="replay-chart-empty">当前页面还没有可绘制的已解析样本；原始 RX 字节仍可继续核对。</p>
  </section>
</template>

<style scoped>
.replay-chart { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-base); }
.replay-chart-heading { display: flex; justify-content: space-between; gap: 8px; color: var(--text-main); font-size: 11px; }
.replay-chart-heading span { color: var(--text-muted); }
.replay-chart-frame { overflow: hidden; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-base); }
.replay-chart-frame svg { display: block; width: 100%; height: auto; min-height: 140px; }
.replay-axis { stroke: var(--text-muted); stroke-width: 1; }
.replay-grid { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 4 5; }
.replay-line { fill: none; stroke-width: 1.8; vector-effect: non-scaling-stroke; }
.replay-label { fill: var(--text-muted); font: 11px ui-monospace, monospace; }
.replay-chart-legend { display: flex; flex-wrap: wrap; gap: 5px 11px; color: var(--text-muted); font-size: 11px; }
.replay-chart-legend span { display: inline-flex; align-items: center; gap: 4px; }
.replay-chart-legend i { width: 8px; height: 8px; border-radius: 50%; }
.replay-chart-empty { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
</style>

