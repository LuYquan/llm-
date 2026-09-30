<script setup lang="ts">
import { ref, onMounted, onUnmounted, shallowRef } from 'vue';
import uPlot from 'uplot';
import { useSerialSession } from '../services/transport/session';
import { globalChannelStore } from '../core/channel/ChannelStore';

import type { WaveformBatch, ChannelMapping } from '../types/ipc';

const emit = defineEmits<{
  (e: 'update-mapping', mapping: ChannelMapping): void;
}>();

const chartContainer = ref<HTMLDivElement | null>(null);
const uplotInstance = shallowRef<uPlot | null>(null);

// 通道语义绑定
const channelMapping = ref<ChannelMapping>({
  target: 'setpoint',
  actual: 'actual',
  output: 'output',
});

// 可选通道列表
const availableChannels = ref<string[]>(['setpoint', 'actual', 'output']);

// 最新数值指示
const currentSetpoint = ref<number | null>(null);
const currentActual = ref<number | null>(null);
const currentOutput = ref<number | null>(null);
const currentError = ref<number | null>(null);

// 历史窗口模式 (PR-001 get_waveform_window)
const isHistoryMode = ref(false);
const isLoadingHistory = ref(false);

// 环形缓冲容量 (保留最近 3000 点，对应 100Hz 下 30 秒)
const MAX_POINTS = 3000;
const currentPointCount = ref(0);
let xData: Float64Array | number[] = new Float64Array(0);
let y0Data: Float64Array | number[] = new Float64Array(0); // Target
let y1Data: Float64Array | number[] = new Float64Array(0); // Actual
let y2Data: Float64Array | number[] = new Float64Array(0); // Output

// 双缓冲与 requestAnimationFrame 60FPS 顺滑刷新
let pendingBatches: WaveformBatch[] = [];
let rafId: number | null = null;

const session = useSerialSession();
let unlisteners: (() => void)[] = [];
let resizeObserver: ResizeObserver | null = null;

function initChart() {
  // uPlot requires at least two samples to calculate axis ranges.
  if (!chartContainer.value || xData.length < 2 || uplotInstance.value) return;

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
        label: `目标 (${channelMapping.value.target})`,
        stroke: '#DA7756', // 陶土色
        width: 2,
        dash: [6, 4],
        value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
      },
      {
        label: `响应 (${channelMapping.value.actual})`,
        stroke: '#34d399', // 翡翠绿
        width: 2,
        value: (_u, v) => (v == null ? '-' : v.toFixed(2)),
      },
      {
        label: `输出 (${channelMapping.value.output})`,
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
      drag: { x: true, y: false, setScale: true },
      sync: { key: 'waveform' },
    },
  };

  const initialData: uPlot.AlignedData = [xData, y0Data, y1Data, y2Data];
  uplotInstance.value = new uPlot(opts, initialData, chartContainer.value);
}

function setupChartContainer() {
  if (!chartContainer.value || resizeObserver) return;
  // 自适应容器大小
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === chartContainer.value && uplotInstance.value) {
        const { width: newW, height: newH } = entry.contentRect;
        if (newW > 0 && newH > 0) {
          uplotInstance.value.setSize({ width: newW, height: newH });
        }
      } else if (entry.target === chartContainer.value && xData.length >= 2) {
        initChart();
      }
    }
  });
  resizeObserver.observe(chartContainer.value);

  // 滚轮缩放支持 (Mouse Wheel Zoom)
  chartContainer.value.addEventListener('wheel', handleWheel, { passive: false });
  // 双击重置缩放
  chartContainer.value.addEventListener('dblclick', handleDoubleClick);
}

function handleWheel(e: WheelEvent) {
  if (!uplotInstance.value || xData.length === 0) return;
  e.preventDefault();

  const factor = e.deltaY < 0 ? 0.8 : 1.25;
  const minX = uplotInstance.value.scales.x.min ?? xData[0];
  const maxX = uplotInstance.value.scales.x.max ?? xData[xData.length - 1];
  const range = maxX - minX;
  if (range <= 0.05 && factor < 1) return; // 最小限制

  const mid = (minX + maxX) / 2;
  const newRange = range * factor;
  uplotInstance.value.setScale('x', {
    min: mid - newRange / 2,
    max: mid + newRange / 2,
  });
}

function handleDoubleClick() {
  if (!uplotInstance.value || xData.length === 0) return;
  uplotInstance.value.setScale('x', {
    min: xData[0],
    max: xData[xData.length - 1],
  });
}

function queueBatch(batch: WaveformBatch) {
  pendingBatches.push(batch);
  if (!rafId) {
    rafId = requestAnimationFrame(flushPendingBatches);
  }
}

let currentSessionId = '';

function flushPendingBatches() {
  rafId = null;
  if (pendingBatches.length === 0) return;

  const batches = pendingBatches;
  pendingBatches = [];

  for (const batch of batches) {
    if (!batch.timestamps || batch.timestamps.length === 0) continue;

    if (batch.session_id && currentSessionId && batch.session_id !== currentSessionId) {
      // 会话变更，清空旧数据以防止时序图混乱跨界 (PR-001 W2)
      globalChannelStore.clear();
      xData = new Float64Array(0);
      y0Data = new Float64Array(0);
      y1Data = new Float64Array(0);
      y2Data = new Float64Array(0);
      currentPointCount.value = 0;
      uplotInstance.value?.destroy();
      uplotInstance.value = null;
    }
    if (batch.session_id) {
      currentSessionId = batch.session_id;
    }

    // 更新可用通道列表
    if (batch.channel_names && batch.channel_names.length > 0) {
      for (const ch of batch.channel_names) {
        if (!availableChannels.value.includes(ch)) {
          availableChannels.value.push(ch);
        }
      }
    }

    // 数据已由上层统一写入 globalChannelStore，此处无需重复 pushSeries 以免数据加倍
  }

  // 从 globalChannelStore 读取统一时序切片并刷新 uPlot (零内存拷贝)
  const targetCh = channelMapping.value.target;
  const actualCh = channelMapping.value.actual;
  const outputCh = channelMapping.value.output;

  const snapTarget = globalChannelStore.snapshot(targetCh);
  const snapActual = globalChannelStore.snapshot(actualCh);
  const snapOutput = globalChannelStore.snapshot(outputCh);

  const total = snapTarget.count;
  currentPointCount.value = total;

  if (total > 0) {
    const start = total > MAX_POINTS ? total - MAX_POINTS : 0;
    xData = snapTarget.timestamps.subarray(start);
    y0Data = snapTarget.values.subarray(start);
    y1Data = snapActual.count >= total ? snapActual.values.subarray(start) : snapActual.values;
    y2Data = snapOutput.count >= total ? snapOutput.values.subarray(start) : snapOutput.values;

    const lastIdx = xData.length - 1;
    currentSetpoint.value = y0Data[lastIdx];
    currentActual.value = y1Data[lastIdx] ?? null;
    currentOutput.value = y2Data[lastIdx] ?? null;
    if (currentSetpoint.value !== null && currentActual.value !== null) {
      currentError.value = Number((currentSetpoint.value - currentActual.value).toFixed(2));
    }

    // 刷新 uPlot 图表 (非历史模式下 60FPS 高效绘制)
    if (!isHistoryMode.value) {
      if (uplotInstance.value) {
        uplotInstance.value.setData([xData, y0Data, y1Data, y2Data], true);
      } else if (xData.length >= 2) {
        initChart();
      }
    }
  }
}

async function toggleHistoryMode() {
  if (isHistoryMode.value) {
    // 退出历史模式，恢复实时波形
    isHistoryMode.value = false;
    if (uplotInstance.value) {
      uplotInstance.value.setData([xData, y0Data, y1Data, y2Data], true);
    } else if (xData.length >= 2) {
      initChart();
    }
  } else {
    // 进入历史模式，从环形缓冲获取降采样历史切片 (PR-001 get_waveform_window)
    isLoadingHistory.value = true;
    try {
      const nowUs = Math.round(Date.now() * 1000);
      const batch = await session.getWaveformWindow(0, nowUs, 1000);

      if (batch && batch.timestamps && batch.timestamps.length > 0) {
        isHistoryMode.value = true;
        const channelNames = batch.channel_names || ['setpoint', 'actual', 'output'];
        const targetIdx = channelNames.indexOf(channelMapping.value.target);
        const actualIdx = channelNames.indexOf(channelMapping.value.actual);
        const outputIdx = channelNames.indexOf(channelMapping.value.output);

        const hX = batch.timestamps;
        const hY0 = batch.series[targetIdx >= 0 ? targetIdx : 0] || [];
        const hY1 = batch.series[actualIdx >= 0 ? actualIdx : 1] || [];
        const hY2 = batch.series[outputIdx >= 0 ? outputIdx : 2] || [];

        if (hX.length >= 2) {
          xData = hX;
          y0Data = hY0;
          y1Data = hY1;
          y2Data = hY2;
          currentPointCount.value = hX.length;
          if (uplotInstance.value) {
            uplotInstance.value.setData([xData, y0Data, y1Data, y2Data], true);
          } else {
            initChart();
          }
        }
      }
    } catch (err) {
      console.error('获取历史波形窗口失败:', err);
    } finally {
      isLoadingHistory.value = false;
    }
  }
}

async function updateMapping() {
  try {
    await session.setChannelMapping(channelMapping.value);
    emit('update-mapping', channelMapping.value);
  } catch (err) {
    console.warn('Failed to sync channel mapping:', err);
  }
}

function resetData() {
  pendingBatches = [];
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  globalChannelStore.clear();
  xData = new Float64Array(0);
  y0Data = new Float64Array(0);
  y1Data = new Float64Array(0);
  y2Data = new Float64Array(0);
  currentPointCount.value = 0;
  currentSetpoint.value = null;
  currentActual.value = null;
  currentOutput.value = null;
  currentError.value = null;
  uplotInstance.value?.destroy();
  uplotInstance.value = null;
}

onMounted(async () => {
  setupChartContainer();
  initChart();

  try {
    // 读取已持久化的通道映射
    const savedMapping = await session.getChannelMapping();
    if (savedMapping) {
      channelMapping.value = savedMapping;
      emit('update-mapping', savedMapping);
      for (const ch of [savedMapping.target, savedMapping.actual, savedMapping.output]) {
        if (ch && !availableChannels.value.includes(ch)) {
          availableChannels.value.push(ch);
        }
      }
    }
  } catch (err) {
    // 降级使用默认
  }

  // 监听波形批次
  unlisteners.push(
    session.onWaveformBatch((batch) => {
      queueBatch(batch);
    })
  );

  // 监听通道列表扩展
  unlisteners.push(
    globalChannelStore.onChannelsChanged((chList) => {
      for (const ch of chList) {
        if (!availableChannels.value.includes(ch)) {
          availableChannels.value.push(ch);
        }
      }
    })
  );
});

onUnmounted(() => {
  unlisteners.forEach((u) => u());
  unlisteners = [];
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (chartContainer.value) {
    chartContainer.value.removeEventListener('wheel', handleWheel);
    chartContainer.value.removeEventListener('dblclick', handleDoubleClick);
  }
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
  queueBatch,
});
</script>

<template>
  <div class="waveform-wrapper">
    <!-- 图表顶部通道与当前值状态条 -->
    <div class="waveform-header">
      <div class="channel-indicators">
        <!-- Target 下拉绑定 -->
        <div class="channel-tag tag-setpoint">
          <span class="legend-line line-dashed"></span>
          <span class="binding-label">目标:</span>
          <select
            class="channel-select font-mono"
            v-model="channelMapping.target"
            @change="updateMapping"
          >
            <option v-for="ch in availableChannels" :key="ch" :value="ch">{{ ch }}</option>
          </select>
          <span class="channel-val font-mono">{{ currentSetpoint != null ? currentSetpoint.toFixed(2) : '--' }}</span>
        </div>

        <!-- Actual 下拉绑定 -->
        <div class="channel-tag tag-actual">
          <span class="legend-line line-solid"></span>
          <span class="binding-label">响应:</span>
          <select
            class="channel-select font-mono"
            v-model="channelMapping.actual"
            @change="updateMapping"
          >
            <option v-for="ch in availableChannels" :key="ch" :value="ch">{{ ch }}</option>
          </select>
          <span class="channel-val font-mono">{{ currentActual != null ? currentActual.toFixed(2) : '--' }}</span>
        </div>

        <!-- Output 下拉绑定 -->
        <div class="channel-tag tag-output">
          <span class="legend-line line-solid line-amber"></span>
          <span class="binding-label">输出:</span>
          <select
            class="channel-select font-mono"
            v-model="channelMapping.output"
            @change="updateMapping"
          >
            <option v-for="ch in availableChannels" :key="ch" :value="ch">{{ ch }}</option>
          </select>
          <span class="channel-val font-mono">{{ currentOutput != null ? currentOutput.toFixed(2) : '--' }}</span>
        </div>
      </div>

      <div class="stats-indicators">
        <button
          class="btn-history font-mono"
          :class="{ 'btn-history-active': isHistoryMode }"
          @click="toggleHistoryMode"
          :disabled="isLoadingHistory"
          title="从 Rust 环形缓冲查询并展示完整历史窗口 (LTTB 降采样)"
        >
          <span v-if="isLoadingHistory">⏳ 查询中...</span>
          <span v-else-if="isHistoryMode">🔴 恢复实时</span>
          <span v-else>📜 历史窗口</span>
        </button>
        <div class="stat-item" :class="{ 'stat-warn': currentError != null && Math.abs(currentError) > 1.0 }">
          <span class="stat-label">实时误差 e(t):</span>
          <span class="stat-val font-mono">{{ currentError != null ? currentError.toFixed(2) : '--' }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">点数缓冲:</span>
          <span class="stat-val font-mono">{{ isHistoryMode ? '历史降采样 (1000点)' : `${xData.length} / ${MAX_POINTS}` }}</span>
        </div>
      </div>
    </div>

    <!-- uPlot 渲染视窗 -->
    <div class="chart-box" ref="chartContainer">
      <div v-if="currentPointCount < 2" class="waveform-empty-state">等待设备遥测 · 至少需要 2 个采样点</div>
    </div>
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
  height: 38px;
  background-color: rgba(19, 27, 38, 0.85);
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

.binding-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.channel-select {
  background-color: rgba(15, 23, 42, 0.7);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 1px 4px;
  outline: none;
  cursor: pointer;
}

.channel-select:hover {
  border-color: var(--accent-cyan);
}

.legend-line {
  width: 14px;
  height: 2px;
  border-radius: 1px;
}

.line-dashed {
  background: repeating-linear-gradient(90deg, var(--accent-terracotta, #DA7756) 0, var(--accent-terracotta, #DA7756) 4px, transparent 4px, transparent 7px);
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

.channel-val {
  font-weight: 600;
  min-width: 42px;
}

.stats-indicators {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 11px;
  color: var(--text-secondary);
}

.btn-history {
  padding: 2px 8px;
  font-size: 10px;
  background-color: rgba(14, 165, 233, 0.1);
  border: 1px solid rgba(14, 165, 233, 0.3);
  color: var(--accent-cyan);
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-history:hover:not(:disabled) {
  background-color: rgba(14, 165, 233, 0.25);
  border-color: var(--accent-cyan);
}

.btn-history-active {
  background-color: rgba(239, 68, 68, 0.2);
  border-color: var(--accent-rose);
  color: var(--accent-rose);
}

.btn-history:disabled {
  opacity: 0.5;
  cursor: wait;
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
  height: calc(100% - 38px);
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.waveform-empty-state {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  background: rgba(9, 14, 23, .88);
  font-size: 12px;
  pointer-events: none;
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
