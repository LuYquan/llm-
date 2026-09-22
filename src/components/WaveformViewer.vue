<script setup lang="ts">
import { ref, onMounted, onUnmounted, shallowRef } from 'vue';
import uPlot from 'uplot';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface WaveformBatch {
  timestamps: number[];
  series: number[][];
  channel_names: string[];
}

const chartContainer = ref<HTMLDivElement | null>(null);
const uplotInstance = shallowRef<uPlot | null>(null);

// 最新数值指示
const currentSetpoint = ref<number | null>(null);
const currentActual = ref<number | null>(null);
const currentOutput = ref<number | null>(null);
const currentError = ref<number | null>(null);
const channelNames = ref<string[]>(['setpoint', 'actual', 'output']);

// 环形缓冲容量 (保留最近 3000 点，对应 100Hz 下 30 秒)
const MAX_POINTS = 3000;
let xData: number[] = [];
let y0Data: number[] = []; // setpoint
let y1Data: number[] = []; // actual
let y2Data: number[] = []; // output

let unlisteners: UnlistenFn[] = [];
let resizeObserver: ResizeObserver | null = null;

function initChart() {
  if (!chartContainer.value) return;

  const width = chartContainer.value.clientWidth || 800;
  const height = chartContainer.value.clientHeight || 500;

  const opts: uPlot.Options = {
    width,
    height,
    scales: {
      x: {
        time: false,
      },
      y: {
        auto: true,
      },
    },
    series: [
      {
        label: '时间',
        value: (_u, v) => (v == null ? '-' : v.toFixed(2) + 's'),
      },
      {
        label: '目标值 (setpoint)',
        stroke: '#38bdf8', // 天蓝
        width: 2,
        dash: [6, 4],
        value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
      },
      {
        label: '实际响应 (actual)',
        stroke: '#34d399', // 翡翠绿
        width: 2,
        value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
      },
      {
        label: '控制输出 (output)',
        stroke: '#fbbf24', // 琥珀黄
        width: 1.5,
        value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
      },
    ],
    axes: [
      {
        stroke: '#94a3b8',
        grid: { stroke: 'rgba(51, 65, 85, 0.4)', width: 1 },
        ticks: { stroke: '#475569', width: 1 },
        font: '11px JetBrains Mono, monospace',
        values: (_u, vals) => vals.map((v) => v.toFixed(1) + 's'),
      },
      {
        stroke: '#94a3b8',
        grid: { stroke: 'rgba(51, 65, 85, 0.4)', width: 1 },
        ticks: { stroke: '#475569', width: 1 },
        font: '11px JetBrains Mono, monospace',
        values: (_u, vals) => vals.map((v) => v.toFixed(1)),
      },
    ],
    cursor: {
      drag: { x: true, y: false },
      sync: { key: 'waveform' },
    },
  };

  const initialData: uPlot.AlignedData = [[], [], [], []];
  uplotInstance.value = new uPlot(opts, initialData, chartContainer.value);

  // 自适应容器大小
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === chartContainer.value && uplotInstance.value) {
        const { width: newW, height: newH } = entry.contentRect;
        if (newW > 0 && newH > 0) {
          uplotInstance.value.setSize({ width: newW, height: newH });
        }
      }
    }
  });
  resizeObserver.observe(chartContainer.value);
}

function handleBatch(batch: WaveformBatch) {
  if (!batch.timestamps || batch.timestamps.length === 0) return;

  if (batch.channel_names && batch.channel_names.length > 0) {
    channelNames.value = batch.channel_names;
  }

  const count = batch.timestamps.length;
  for (let i = 0; i < count; i++) {
    xData.push(batch.timestamps[i]);
    y0Data.push(batch.series[0]?.[i] ?? 0);
    y1Data.push(batch.series[1]?.[i] ?? 0);
    y2Data.push(batch.series[2]?.[i] ?? 0);
  }

  // 超过最大容量时丢弃最旧数据点
  if (xData.length > MAX_POINTS) {
    const overflow = xData.length - MAX_POINTS;
    xData.splice(0, overflow);
    y0Data.splice(0, overflow);
    y1Data.splice(0, overflow);
    y2Data.splice(0, overflow);
  }

  // 更新指示读数
  const lastIdx = xData.length - 1;
  if (lastIdx >= 0) {
    currentSetpoint.value = y0Data[lastIdx];
    currentActual.value = y1Data[lastIdx];
    currentOutput.value = y2Data[lastIdx];
    currentError.value = Number((y0Data[lastIdx] - y1Data[lastIdx]).toFixed(2));
  }

  // 刷新 uPlot 图表 (60FPS 高效绘制，开启动态尺度自适应以支持时间轴滚动)
  if (uplotInstance.value) {
    uplotInstance.value.setData([xData, y0Data, y1Data, y2Data], true);
  }
}

function resetData() {
  xData = [];
  y0Data = [];
  y1Data = [];
  y2Data = [];
  currentSetpoint.value = null;
  currentActual.value = null;
  currentOutput.value = null;
  currentError.value = null;
  channelNames.value = ['setpoint', 'actual', 'output'];
  if (uplotInstance.value) {
    uplotInstance.value.setData([[], [], [], []], true);
  }
}

onMounted(async () => {
  initChart();

  try {
    // 监听统一 IPC 事件 waveform://batch (PRD 2.4.3)
    const u1 = await listen<WaveformBatch>('waveform://batch', (event) => {
      handleBatch(event.payload);
    });
    unlisteners.push(u1);

    const u2 = await listen('waveform://reset', () => {
      resetData();
    });
    unlisteners.push(u2);
  } catch (err) {
    console.warn('Tauri event listen not ready (or running outside Tauri):', err);
  }
});

onUnmounted(() => {
  unlisteners.forEach((u) => u());
  unlisteners = [];
  if (resizeObserver && chartContainer.value) {
    resizeObserver.unobserve(chartContainer.value);
    resizeObserver.disconnect();
  }
  if (uplotInstance.value) {
    uplotInstance.value.destroy();
    uplotInstance.value = null;
  }
});

defineExpose({
  resetData,
  handleBatch,
});
</script>

<template>
  <div class="waveform-wrapper">
    <!-- 图表顶部通道与当前值状态条 -->
    <div class="waveform-header">
      <div class="channel-indicators">
        <div class="channel-tag tag-setpoint">
          <span class="legend-line line-dashed"></span>
          <span class="channel-name">目标 ({{ channelNames[0] || 'setpoint' }}):</span>
          <span class="channel-val font-mono">{{ currentSetpoint != null ? currentSetpoint.toFixed(2) : '--' }}</span>
        </div>
        <div class="channel-tag tag-actual">
          <span class="legend-line line-solid"></span>
          <span class="channel-name">响应 ({{ channelNames[1] || 'actual' }}):</span>
          <span class="channel-val font-mono">{{ currentActual != null ? currentActual.toFixed(2) : '--' }}</span>
        </div>
        <div class="channel-tag tag-output">
          <span class="legend-line line-solid line-amber"></span>
          <span class="channel-name">输出 ({{ channelNames[2] || 'output' }}):</span>
          <span class="channel-val font-mono">{{ currentOutput != null ? currentOutput.toFixed(2) : '--' }}</span>
        </div>
      </div>

      <div class="stats-indicators">
        <div class="stat-item" :class="{ 'stat-warn': currentError != null && Math.abs(currentError) > 1.0 }">
          <span class="stat-label">实时误差 e(t):</span>
          <span class="stat-val font-mono">{{ currentError != null ? currentError.toFixed(2) : '--' }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">点数缓冲:</span>
          <span class="stat-val font-mono">{{ xData.length }} / {{ MAX_POINTS }}</span>
        </div>
      </div>
    </div>

    <!-- uPlot 渲染视窗 -->
    <div class="chart-box" ref="chartContainer"></div>
  </div>
</template>

<style scoped>
.waveform-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-main);
  position: relative;
  overflow: hidden;
}

.waveform-header {
  height: 36px;
  background-color: rgba(19, 27, 38, 0.7);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
  backdrop-filter: blur(8px);
}

.channel-indicators {
  display: flex;
  align-items: center;
  gap: 16px;
}

.channel-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.legend-line {
  width: 16px;
  height: 2px;
  border-radius: 1px;
}

.line-dashed {
  background: repeating-linear-gradient(90deg, #38bdf8 0, #38bdf8 4px, transparent 4px, transparent 7px);
}

.line-solid {
  background-color: #34d399;
}

.line-amber {
  background-color: #fbbf24;
}

.tag-setpoint {
  color: var(--accent-cyan);
}

.tag-actual {
  color: var(--accent-emerald);
}

.tag-output {
  color: var(--accent-amber);
}

.channel-name {
  opacity: 0.85;
}

.channel-val {
  font-weight: 600;
}

.stats-indicators {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 11px;
  color: var(--text-secondary);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.stat-label {
  color: var(--text-muted);
}

.stat-val {
  font-weight: 600;
  color: var(--text-primary);
}

.stat-warn .stat-val {
  color: var(--accent-rose);
}

.chart-box {
  flex: 1;
  width: 100%;
  height: calc(100% - 36px);
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.font-mono {
  font-family: var(--font-mono);
}

:deep(.u-legend) {
  display: none !important;
}

:deep(.uplot) {
  font-family: var(--font-mono) !important;
}
</style>
