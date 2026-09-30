<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, shallowRef } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { ChartConfig } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';
import type { StepInputQuality } from '../../core/analysis/extractStepFeatures';
import type { StepResponseMetrics } from '../../core/analysis/types';
import type { FftInputQuality, FftResult } from '../../core/analysis/fft';
import { analysisWorker, type CancellableAnalysis } from '../../services/analysis/analysis-worker-client';
import { useWidgetStore, DEFAULT_CHANNEL_PALETTE } from '../../stores/widgetStore';
import { alignSnapshotsByTimestamp } from '../../core/channel/alignment';

const props = defineProps<{
  config: ChartConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const emit = defineEmits<{
  (e: 'step-captured', metrics: StepResponseMetrics): void;
}>();

const store = useWidgetStore();
const chartContainer = ref<HTMLDivElement | null>(null);
const uplotInstance = shallowRef<uPlot | null>(null);
const pointCount = ref(0);
let axisColor = '#9E9C94';
let gridColor = '#383633';
let themeObserver: MutationObserver | null = null;

function refreshChartTheme() {
  const theme = getComputedStyle(document.documentElement);
  axisColor = theme.getPropertyValue('--text-muted').trim() || '#9E9C94';
  gridColor = theme.getPropertyValue('--border-subtle').trim() || '#383633';
  uplotInstance.value?.redraw(true, true);
}

// 状态控制
const isPaused = ref(false);
const isLiveFollowing = ref(true);
const isFullscreen = ref(false);
const isStepModalOpen = ref(false);
const latestStepMetrics = ref<StepResponseMetrics | null>(null);
const stepAnalysisMessage = ref('选择目标通道边沿或输入已知阶跃时刻后运行分析。');
const stepTimeInput = ref('');
const isStepAnalyzing = ref(false);
let stepJob: CancellableAnalysis<{ quality: StepInputQuality; result: StepResponseMetrics | null }> | null = null;

// 视图模式：时域波形 vs 直方条形图 (VOFA+ 原生模式)
const viewMode = ref<'waveform' | 'bar'>('waveform');

// FFT 频谱分析状态
const isFftOpen = ref(false);
const isFftAnalyzing = ref(false);
const fftResult = ref<FftResult | null>(null);
const fftInputQuality = ref<FftInputQuality | null>(null);
let fftJob: CancellableAnalysis<{ quality: FftInputQuality; result: FftResult | null }> | null = null;

// 区间测距数据 (含周期占空比估算)
const selectionStats = ref<{
  dt: number;
  freq: number;
  yMin: number;
  yMax: number;
  dy: number;
  dutyCycle?: number;
} | null>(null);

// 曲线配置列表
const localSeries = ref([...props.config.series]);
let channelListUnsubscribe: (() => void) | null = null;
function bindReceivedChannels(channels: string[]) {
  if (!props.config.auto_bind || isPaused.value) return;
  channels = channels.filter(id => (globalChannelStore.getBuffer(id, false)?.getSize() || 0) > 0);
  if (channels.slice(0, 8).join('\0') === localSeries.value.map(series => series.channel).join('\0')) return;
  const previous = new Map(localSeries.value.map(series => [series.channel, series]));
  localSeries.value = channels.slice(0, 8).map((channel, i) => previous.get(channel) || { channel, color: DEFAULT_CHANNEL_PALETTE[i], visible: true });
  reinitChart();
}

watch(
  () => props.config.series,
  (val) => {
    localSeries.value = [...val];
    if (props.config.auto_bind) { bindReceivedChannels(globalChannelStore.listChannels()); return; }
    reinitChart();
  },
  { deep: true }
);

// 监听通道元数据变更 (曲线颜色、可见性与 Scale/Offset 全局响应式同步)
watch(
  () => store.channelMetaMap.value,
  () => {
    if (uplotInstance.value) {
      for (let idx = 0; idx < localSeries.value.length; idx++) {
        const s = localSeries.value[idx];
        const meta = store.getChannelMeta(s.channel);
        const targetSeries = (uplotInstance.value.series as any)?.[idx + 1];
        if (targetSeries) {
          targetSeries.stroke = meta.color || s.color;
        }
        uplotInstance.value.setSeries(idx + 1, {
          show: s.visible && meta.visible,
        });
      }
      uplotInstance.value.redraw();
    }
  },
  { deep: true }
);

// 监听 Auto 缩放全局广播触发
watch(
  () => store.autoScaleTrigger.value,
  () => {
    resetView();
  }
);

// 缓存的数据切片
let xData: any = new Float64Array(0);
let ySeriesData: any[] = [];

// 每条曲线最多向绘图器提供此数量的显示点。记录缓冲仍保留完整原始样本。
const MAX_DISPLAY_POINTS_PER_CHANNEL = 3000;
let observedStoreGeneration = globalChannelStore.getGeneration();

const uplotId = `uplot_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function initChart() {
  if (!chartContainer.value || xData.length < 2 || uplotInstance.value) return;

  const width = Math.max(120, chartContainer.value.clientWidth || props.w);
  const height = Math.max(100, chartContainer.value.clientHeight || props.h - 40);

  const seriesOpts: uPlot.Series[] = [
    {
      label: '时间',
      value: (_u, v) => (v == null ? '-' : v.toFixed(3) + 's'),
    },
  ];

  for (const s of localSeries.value) {
    const meta = store.getChannelMeta(s.channel);
    seriesOpts.push({
      label: meta.name || s.channel || '通道',
      stroke: meta.color || s.color || '#DA7756',
      width: 2,
      show: s.visible && meta.visible,
      value: (_u, v) => (v == null ? '-' : v.toFixed(meta.decimal ?? 2)),
    });
  }

  const opts: uPlot.Options = {
    width,
    height,
    scales: {
      x: {
        time: false,
      },
      y: {
        auto: props.config.y_mode === 'auto',
        range: props.config.y_mode === 'manual'
          ? [props.config.y_min ?? -10, props.config.y_max ?? 10]
          : undefined,
      },
    },
    series: seriesOpts,
    axes: [
      {
        stroke: () => axisColor,
        grid: { stroke: () => gridColor, width: 1 },
        ticks: { stroke: () => gridColor, width: 1 },
        font: '11px Consolas, monospace',
        values: (_u, vals) => vals.map((v) => v.toFixed(1) + 's'),
      },
      {
        stroke: () => axisColor,
        grid: { stroke: () => gridColor, width: 1 },
        ticks: { stroke: () => gridColor, width: 1 },
        font: '11px Consolas, monospace',
        values: (_u, vals) => vals.map((v) => v.toFixed(1)),
      },
    ],
    cursor: {
      drag: { x: true, y: false, setScale: true },
      sync: { key: 'vofa-waveform' },
      points: {
        size: 6,
        fill: '#DA7756',
      },
    },
    hooks: {
      setSelect: [
        (u) => {
          const min = u.posToVal(u.select.left, 'x');
          const max = u.posToVal(u.select.left + u.select.width, 'x');
          if (max > min) {
            const dt = max - min;
            const freq = dt > 0 ? 1 / dt : 0;
            // 统计主显示通道在这个时间区间内的 Min/Max/Delta
            let yMin = Infinity;
            let yMax = -Infinity;
            let highCount = 0;
            let totalCount = 0;
            const primaryIdx = localSeries.value.findIndex((s) => s.visible);
            if (primaryIdx >= 0 && ySeriesData[primaryIdx]) {
              const yArr = ySeriesData[primaryIdx];
              for (let i = 0; i < xData.length; i++) {
                const t = xData[i];
                if (t >= min && t <= max) {
                  const val = yArr[i];
                  if (val < yMin) yMin = val;
                  if (val > yMax) yMax = val;
                }
              }
              const yMid = (yMin + yMax) / 2;
              for (let i = 0; i < xData.length; i++) {
                const t = xData[i];
                if (t >= min && t <= max) {
                  const val = yArr[i];
                  if (val >= yMid) highCount++;
                  totalCount++;
                }
              }
            }
            const dutyCycle = totalCount > 0 && yMax - yMin > 1e-4
              ? (highCount / totalCount) * 100
              : undefined;

            selectionStats.value = {
              dt,
              freq,
              yMin: isFinite(yMin) ? yMin : 0,
              yMax: isFinite(yMax) ? yMax : 0,
              dy: isFinite(yMax - yMin) ? yMax - yMin : 0,
              dutyCycle,
            };
          }
        },
      ],
    },
  };

  const initialData: uPlot.AlignedData = [xData];
  for (let i = 0; i < localSeries.value.length; i++) {
    const series = ySeriesData[i];
    if (series && series.length === xData.length) {
      initialData.push(series);
    } else {
      const empty = new Float64Array(xData.length);
      empty.fill(NaN);
      initialData.push(empty);
    }
  }

  uplotInstance.value = new uPlot(opts, initialData, chartContainer.value);
}

function reinitChart() {
  if (uplotInstance.value) {
    uplotInstance.value.destroy();
    uplotInstance.value = null;
  }
  initChart();
}

function toggleSeries(idx: number) {
  localSeries.value[idx].visible = !localSeries.value[idx].visible;
  if (uplotInstance.value) {
    uplotInstance.value.setSeries(idx + 1, { show: localSeries.value[idx].visible });
  }
}

// 调度器调用的核心绘图帧
function onRenderFrame() {
  const storeGeneration = globalChannelStore.getGeneration();
  if (storeGeneration !== observedStoreGeneration) {
    clearRenderedData();
  }
  if (isPaused.value) return;
  if (props.config.auto_bind) bindReceivedChannels(globalChannelStore.listChannels());

  const seriesList = localSeries.value;
  if (seriesList.length === 0) return;

  const isScrubbing = store.scrubState.value.isScrubbing;
  const scrubRatio = store.scrubState.value.ratio;
  if (isScrubbing) isLiveFollowing.value = false;

  const channelIds = [...new Set(seriesList.map((series) => series.channel).filter(Boolean))];
  const ranges = channelIds.map((channel) => globalChannelStore.timeRange(channel)).filter((range): range is { start: number; end: number } => range !== null);
  if (ranges.length === 0) {
    xData = new Float64Array(0);
    ySeriesData = [];
    pointCount.value = 0;
    uplotInstance.value?.destroy();
    uplotInstance.value = null;
    return;
  }

  const oldestTime = Math.min(...ranges.map((range) => range.start));
  const newestTime = Math.max(...ranges.map((range) => range.end));
  const timeWindow = Math.max(0.05, Number.isFinite(props.config.time_window) ? props.config.time_window : 10);
  let viewEnd = newestTime;
  let viewStart = viewEnd - timeWindow;

  if (isScrubbing) {
    viewEnd = oldestTime + (newestTime - oldestTime) * scrubRatio;
    viewStart = viewEnd - timeWindow;
  } else if (!isLiveFollowing.value && uplotInstance.value) {
    const min = uplotInstance.value.scales.x.min;
    const max = uplotInstance.value.scales.x.max;
    if (Number.isFinite(min) && Number.isFinite(max) && (max as number) > (min as number)) {
      viewStart = min as number;
      viewEnd = max as number;
    }
  }

  const snapshotsByChannel = new Map(channelIds.map((channel) => [
    channel,
    globalChannelStore.getBuffer(channel, false)?.getMinMaxView(viewStart, viewEnd, MAX_DISPLAY_POINTS_PER_CHANNEL)
      ?? { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 },
  ]));
  const aligned = alignSnapshotsByTimestamp(seriesList.map((series) => series.channel
    ? snapshotsByChannel.get(series.channel)!
    : { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 }));
  xData = aligned.timestamps;
  ySeriesData = aligned.values.map((rawValues, index) => {
    const meta = store.getChannelMeta(seriesList[index].channel);
    if (meta.scale === 1.0 && meta.yOffset === 0.0) return rawValues;
    const transformed = new Float64Array(rawValues.length);
    for (let i = 0; i < rawValues.length; i++) {
      const value = rawValues[i];
      transformed[i] = Number.isNaN(value) ? Number.NaN : value * meta.scale + meta.yOffset;
    }
    return transformed;
  });

  const targetLen = xData.length;
  const alignedData: uPlot.AlignedData = [xData, ...ySeriesData];

  pointCount.value = targetLen;
  // uPlot cannot calculate ranges from empty or single-sample data. Keep the
  // waiting state visible until there is a usable time window.
  if (targetLen < 2) {
    uplotInstance.value?.destroy();
    uplotInstance.value = null;
    return;
  }

  if (!uplotInstance.value) {
    initChart();
  } else {
    uplotInstance.value.setData(alignedData, false);
  }
  // Keep a real time window in follow, browse, and scrub modes.
  if (uplotInstance.value && Number.isFinite(viewStart) && Number.isFinite(viewEnd) && viewEnd > viewStart) {
    uplotInstance.value.setScale('x', { min: viewStart, max: viewEnd });
  }
}

// 切换暂停状态
function togglePause() {
  isPaused.value = !isPaused.value;
}

// 滚轮缩放支持 (Mouse Wheel Zoom) - 以鼠标指针为中心平滑缩放
function handleWheel(e: WheelEvent) {
  if (!uplotInstance.value || xData.length === 0) return;
  e.preventDefault();
  isLiveFollowing.value = false;

  const factor = e.deltaY < 0 ? 0.8 : 1.25;
  const minX = uplotInstance.value.scales.x.min ?? xData[0];
  const maxX = uplotInstance.value.scales.x.max ?? xData[xData.length - 1];
  const range = maxX - minX;
  if (range <= 0.05 && factor < 1) return; // 最小限制

  // 以鼠标指针在容器内的相对位置作为缩放锚点 (VOFA+ 丝滑对齐体验)
  const rect = chartContainer.value?.getBoundingClientRect();
  let anchorRatio = 0.5;
  if (rect && rect.width > 0) {
    anchorRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }
  const mouseVal = minX + range * anchorRatio;
  const newRange = range * factor;
  const nextMin = mouseVal - newRange * anchorRatio;
  const nextMax = mouseVal + newRange * (1 - anchorRatio);
  uplotInstance.value.setScale('x', {
    min: nextMin,
    max: nextMax,
  });
  isLiveFollowing.value = false;
}

// 双击或点击按钮重置缩放与平移 (恢复实时流跟随态)
function resetView() {
  if (!uplotInstance.value) return;
  isLiveFollowing.value = true;
  selectionStats.value = null;
  store.setScrubState(false, 1.0);

  // 清除手动设定的 min/max 强制锁定，恢复 uPlot 原生自适应流式跟随
  uplotInstance.value.setScale('x', {
    min: null as any,
    max: null as any,
  });

  if (props.config.y_mode === 'manual') {
    uplotInstance.value.setScale('y', {
      min: props.config.y_min ?? -10,
      max: props.config.y_max ?? 10,
    });
  } else {
    uplotInstance.value.setScale('y', {
      min: null as any,
      max: null as any,
    });
  }

  if (xData.length > 0) {
    onRenderFrame();
  }
}

// 柱状直方图实时聚合数据 (VOFA+ 柱状观察模式)
const barChartData = computed(() => {
  return localSeries.value.map((s) => {
    const meta = store.getChannelMeta(s.channel);
    const pt = globalChannelStore.latest(s.channel);
    const current = pt ? pt.v * meta.scale + meta.yOffset : null;
    const snap = globalChannelStore.snapshot(s.channel);
    let min = Infinity;
    let max = -Infinity;
    if (snap.count > 0) {
      const n = Math.min(100, snap.count);
      for (let i = snap.count - n; i < snap.count; i++) {
        const v = snap.values[i] * meta.scale + meta.yOffset;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return {
      channel: s.channel,
      name: meta.name || s.channel,
      color: meta.color || s.color || '#DA7756',
      visible: s.visible && meta.visible,
      current,
      min: isFinite(min) ? min : 0,
      max: isFinite(max) ? max : 0,
      decimal: meta.decimal ?? 2,
    };
  });
});

function handleDoubleClick(e?: MouseEvent) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  resetView();
}

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  setTimeout(() => {
    if (chartContainer.value && uplotInstance.value) {
      uplotInstance.value.setSize({
        width: Math.max(100, chartContainer.value.clientWidth),
        height: Math.max(80, chartContainer.value.clientHeight),
      });
    }
  }, 60);
}

async function openFftSpectrum() {
  if (xData.length === 0 || ySeriesData.length === 0) {
    alert('当前没有可供计算 FFT 频谱的波形数据');
    return;
  }
  const primaryIdx = localSeries.value.findIndex((s) => s.visible && s.channel);
  const targetIdx = primaryIdx >= 0 ? primaryIdx : 0;
  const values = ySeriesData[targetIdx];
  const targetChannel = localSeries.value[targetIdx]?.channel || `series_${targetIdx}`;
  if (!values || values.length < 16) {
    alert('数据点数过少（需至少 16 点）');
    return;
  }
  fftJob?.cancel();
  const generation = globalChannelStore.getGeneration();
  const sessionContext = globalChannelStore.getSessionContext();
  const job = analysisWorker.runFft(xData, values, 1024, {
    source: 'live',
    sessionId: sessionContext.sessionId,
    epoch: sessionContext.epoch,
    generation,
    channelIds: [targetChannel],
  });
  fftJob = job;
  isFftAnalyzing.value = true;
  try {
    const { quality, result } = await job.promise;
    if (fftJob?.id !== job.id || generation !== globalChannelStore.getGeneration()) return;
    if (!quality.valid) {
      alert(`FFT 已拒绝：${quality.reason || '采样数据质量不符合要求'}`);
      return;
    }
    if (!result) {
      alert('FFT 计算失败：有效样本不足或时间基础无效');
      return;
    }
    fftInputQuality.value = quality;
    fftResult.value = result;
    isFftOpen.value = true;
  } catch (error) {
    if (fftJob?.id !== job.id) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!/取消/.test(message)) alert(`FFT 计算失败：${message}`);
  } finally {
    if (fftJob?.id === job.id) {
      fftJob = null;
      isFftAnalyzing.value = false;
    }
  }
}

const fftPolylinePoints = computed(() => {
  if (!fftResult.value || fftResult.value.amplitudes.length === 0) return '';
  const amps = fftResult.value.amplitudes;
  let maxAmp = 0;
  for (let i = 0; i < amps.length; i++) {
    if (amps[i] > maxAmp) maxAmp = amps[i];
  }
  if (maxAmp <= 0) maxAmp = 1;
  const w = 480;
  const h = 130;
  const pts: string[] = [];
  for (let i = 0; i < amps.length; i++) {
    const x = 10 + (i / (amps.length - 1)) * w;
    const y = 140 - (amps[i] / maxAmp) * h;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
});

const fftPolygonPoints = computed(() => {
  const line = fftPolylinePoints.value;
  if (!line) return '';
  return `10,140 ${line} 490,140`;
});

// 拖拽平移视口 (VOFA+ 原生交互：中键拖拽 或 Shift+左键拖拽)
let isPanning = false;
let panStartX = 0;
let panStartMinX = 0;
let panStartMaxX = 0;
let cleanupPanListeners: (() => void) | null = null;

function handlePointerDown(e: PointerEvent) {
  if (!uplotInstance.value || xData.length === 0) return;
  if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
    isPanning = true;
    isLiveFollowing.value = false;
    panStartX = e.clientX;
    panStartMinX = uplotInstance.value.scales.x.min ?? xData[0];
    panStartMaxX = uplotInstance.value.scales.x.max ?? xData[xData.length - 1];

    if (chartContainer.value) {
      chartContainer.value.style.cursor = 'grabbing';
    }

    const onPointerMove = (ev: PointerEvent) => {
      if (!isPanning || !uplotInstance.value) return;
      ev.preventDefault();
      const dx = ev.clientX - panStartX;
      const width = chartContainer.value?.clientWidth || 500;
      const range = panStartMaxX - panStartMinX;
      const deltaVal = (dx / width) * range;
      uplotInstance.value.setScale('x', {
        min: panStartMinX - deltaVal,
        max: panStartMaxX - deltaVal,
      });
      isLiveFollowing.value = false;
    };

    const cleanup = () => {
      isPanning = false;
      if (chartContainer.value) {
        chartContainer.value.style.cursor = '';
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      cleanupPanListeners = null;
    };
    const onPointerUp = () => cleanup();

    cleanupPanListeners?.();
    cleanupPanListeners = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }
}

// 导出 CSV
function exportCsv() {
  const min = uplotInstance.value?.scales.x.min;
  const max = uplotInstance.value?.scales.x.max;
  const fromTime = Number.isFinite(min) ? min as number : xData[0];
  const toTime = Number.isFinite(max) ? max as number : xData[xData.length - 1];
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime) {
    alert('当前没有可导出的波形数据');
    return;
  }

  // Export every retained source sample in the selected interval. The chart's
  // display decimation and scale/offset transforms are intentionally excluded.
  const snapshots = localSeries.value.map((series) => series.channel
    ? globalChannelStore.snapshot(series.channel, fromTime, toTime)
    : { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 });
  const aligned = alignSnapshotsByTimestamp(snapshots);
  if (aligned.timestamps.length === 0) {
    alert('当前时间范围内没有可导出的波形数据');
    return;
  }

  const csvCell = (value: string) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const headers = [
    'Timestamp_s',
    ...localSeries.value.map((series, index) => {
      const meta = store.getChannelMeta(series.channel);
      return csvCell(`${meta.name || series.channel || `CH_${index + 1}`} [${series.channel || `CH_${index + 1}`}]`);
    }),
  ];
  const rows: string[] = [headers.join(',')];

  for (let i = 0; i < aligned.timestamps.length; i++) {
    const row = [aligned.timestamps[i].toPrecision(17)];
    for (let j = 0; j < aligned.values.length; j++) {
      const value = aligned.values[j]?.[i];
      row.push(Number.isFinite(value) ? value.toPrecision(17) : '');
    }
    rows.push(row.join(','));
  }

  const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(rows.join('\n'));
  const link = document.createElement('a');
  link.setAttribute('href', csvContent);
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  link.setAttribute('download', `waveform_${now}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// 触发阶跃响应分析。样本快照在主线程取得，数值计算交给分析 Worker。
async function triggerStepAnalysis() {
  stepJob?.cancel();
  stepJob = null;
  isStepAnalyzing.value = false;
  const actualCh = props.config.actual_channel?.trim();
  const targetCh = props.config.target_channel?.trim();
  const generation = globalChannelStore.getGeneration();
  isStepModalOpen.value = true;
  latestStepMetrics.value = null;

  if (!actualCh || !targetCh) {
    stepAnalysisMessage.value = '请先在图表属性中明确绑定实际响应通道和目标通道。';
  } else if (actualCh === targetCh) {
    stepAnalysisMessage.value = '实际响应和目标通道不能绑定到同一通道。';
  } else if (stepTimeInput.value.trim() !== '' && !Number.isFinite(Number(stepTimeInput.value))) {
    stepAnalysisMessage.value = '阶跃时刻必须是以秒为单位的有限数值。';
  } else {
    const actualSnap = globalChannelStore.snapshot(actualCh);
    const targetSnap = globalChannelStore.snapshot(targetCh);
    if (actualSnap.count < 10 || targetSnap.count < 1) {
      stepAnalysisMessage.value = '未计算：需要至少 10 个有效响应样本和目标通道数据。';
    } else {
      const options = {
        bandPercent: 0.02,
        ...(stepTimeInput.value.trim() === '' ? {} : { stepTime: Number(stepTimeInput.value) }),
      };
      if (options.stepTime === undefined) {
        const baseline = targetSnap.values[0];
        const threshold = 1e-4;
        let stepIndex = -1;
        let targetInputError = false;
        for (let index = 1; index < targetSnap.count; index++) {
          if (!Number.isFinite(targetSnap.timestamps[index])
            || targetSnap.timestamps[index] <= targetSnap.timestamps[index - 1]
            || !Number.isFinite(targetSnap.values[index])) {
            stepAnalysisMessage.value = '未计算：目标通道时间戳或数值无效，无法确定阶跃时刻。';
            targetInputError = true;
            break;
          }
          if (stepIndex < 0 && Math.abs(targetSnap.values[index] - baseline) > threshold) stepIndex = index;
        }
        if (stepIndex < 0 && !targetInputError) {
          stepAnalysisMessage.value = '未计算：目标通道在当前区间没有可识别阶跃；也可输入已知阶跃时刻。';
        }
        if (stepIndex >= 0) options.stepTime = targetSnap.timestamps[stepIndex];
      }

      if (options.stepTime !== undefined) {
        const job = analysisWorker.runStep(
          actualSnap.timestamps,
          actualSnap.values,
          targetSnap.values[targetSnap.count - 1],
          options,
          {
            source: 'live',
            ...globalChannelStore.getSessionContext(),
            generation,
            channelIds: [actualCh, targetCh],
          },
        );
        stepJob = job;
        isStepAnalyzing.value = true;
        stepAnalysisMessage.value = '正在后台计算阶跃特征…';
        try {
          const response = await job.promise;
          if (stepJob?.id !== job.id || generation !== globalChannelStore.getGeneration()) return;
          latestStepMetrics.value = response.result;
          stepAnalysisMessage.value = response.result
            ? ''
            : `未计算：${response.quality.reason || '阶跃数据质量不符合要求'}`;
          if (response.result) emit('step-captured', response.result);
        } catch (error) {
          if (stepJob?.id !== job.id) return;
          const message = error instanceof Error ? error.message : String(error);
          if (!/取消/.test(message)) stepAnalysisMessage.value = `阶跃分析失败：${message}`;
        } finally {
          if (stepJob?.id === job.id) {
            stepJob = null;
            isStepAnalyzing.value = false;
          }
        }
        return;
      }
    }
  }
}

// Resize 响应
let resizeObserver: ResizeObserver | null = null;
let clearUnsubscribe: (() => void) | null = null;

function clearRenderedData() {
  observedStoreGeneration = globalChannelStore.getGeneration();
  xData = new Float64Array(0);
  ySeriesData = [];
  pointCount.value = 0;
  selectionStats.value = null;
  isLiveFollowing.value = true;
  uplotInstance.value?.destroy();
  uplotInstance.value = null;
}

onMounted(() => {
  refreshChartTheme();
  themeObserver = new MutationObserver(refreshChartTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  initChart();
  channelListUnsubscribe = globalChannelStore.onChannelsChanged(bindReceivedChannels);
  clearUnsubscribe = globalChannelStore.onCleared(() => clearRenderedData());

  // 挂载尺寸监听
  if (chartContainer.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === chartContainer.value && uplotInstance.value) {
          const { width, height } = entry.contentRect;
          if (width > 50 && height > 50) {
            uplotInstance.value.setSize({ width, height });
          }
        }
      }
    });
    resizeObserver.observe(chartContainer.value);
    chartContainer.value.addEventListener('wheel', handleWheel, { passive: false });
    chartContainer.value.addEventListener('dblclick', handleDoubleClick);
    chartContainer.value.addEventListener('pointerdown', handlePointerDown);
  }

  // 注册到全局单 rAF 调度器 (支持非激活 Tab 保护与暂停)
  globalRenderScheduler.register(uplotId, onRenderFrame, {
    tabId: props.tabId,
    fpsLimit: 60,
  });
});

onUnmounted(() => {
  channelListUnsubscribe?.();
  themeObserver?.disconnect();
  themeObserver = null;
  fftJob?.cancel();
  fftJob = null;
  stepJob?.cancel();
  stepJob = null;
  globalRenderScheduler.unregister(uplotId);
  clearUnsubscribe?.();
  cleanupPanListeners?.();

  if (chartContainer.value) {
    chartContainer.value.removeEventListener('wheel', handleWheel);
    chartContainer.value.removeEventListener('dblclick', handleDoubleClick);
    chartContainer.value.removeEventListener('pointerdown', handlePointerDown);
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
</script>

<template>
  <div class="flagship-chart-widget" :class="{ 'is-fullscreen': isFullscreen }">
    <!-- 图表顶栏工具条：通道图例、测距指示、暂停与导出 (双击顶栏全屏放大) -->
    <header class="chart-header" @dblclick="toggleFullscreen" title="双击顶栏全屏放大/还原">
      <!-- 多通道图例显隐按钮 -->
      <div class="series-pills">
        <button
          v-for="(s, idx) in localSeries"
          :key="idx"
          type="button"
          class="series-pill"
          :class="{ 'is-hidden': !s.visible || !store.getChannelMeta(s.channel).visible }"
          @click="toggleSeries(idx)"
          :title="s.visible && store.getChannelMeta(s.channel).visible ? '点击隐藏曲线' : '点击显示曲线'"
        >
          <span class="series-dot" :style="{ backgroundColor: store.getChannelMeta(s.channel).color || s.color }"></span>
          <span class="series-name">{{ store.getChannelMeta(s.channel).name || s.channel || `通道 ${idx + 1}` }}</span>
        </button>
      </div>

      <!-- 操作按钮群 -->
      <div class="chart-actions">
        <!-- 视图模式切换：波形图 vs 柱状条形图 (VOFA+ 原生模式) -->
        <div class="view-mode-tabs">
          <button
            type="button"
            class="btn-chart-tool btn-mode"
            :class="{ active: viewMode === 'waveform' }"
            @click="viewMode = 'waveform'"
            title="时域波形图模式"
          >
            波形
          </button>
          <button
            type="button"
            class="btn-chart-tool btn-mode"
            :class="{ active: viewMode === 'bar' }"
            @click="viewMode = 'bar'"
            title="直方柱状图模式"
          >
            柱状
          </button>
        </div>

        <!-- 测距提示小胶囊 (含占空比估算) -->
        <div v-if="selectionStats" class="stat-badge" title="选中区间测距与占空比分析">
          <span>Δt: {{ (selectionStats.dt * 1000).toFixed(1) }}ms</span>
          <span>Δy: {{ selectionStats.dy.toFixed(2) }}</span>
          <span v-if="selectionStats.dutyCycle != null">占空比: {{ selectionStats.dutyCycle.toFixed(1) }}%</span>
          <button class="btn-clear-stat" @click="handleDoubleClick" title="重置测距缩放">✕</button>
        </div>

        <!-- 实时跟随 / 回溯观察状态指示 -->
        <button
          v-if="!isLiveFollowing"
          type="button"
          class="live-status-pill pill-paused"
          @click="resetView"
          title="当前处于局部回溯状态，点击或双击图表可复位至实时跟随"
        >
          回溯中
        </button>

        <!-- 复位视口 -->
        <button
          type="button"
          class="btn-chart-tool"
          @click="resetView"
          title="复位波形视口至完整范围 (双击图表亦可复位)"
        >
          回到实时
        </button>

<details class="chart-more"><summary>分析与导出</summary><div class="chart-more-items">        <!-- FFT 频谱分析按钮 -->
        <button
          type="button"
          class="btn-chart-tool"
          :class="{ 'is-analyzing': isFftOpen }"
          :disabled="isFftAnalyzing"
          @click="openFftSpectrum"
          title="对当前视窗主通道数据执行离散傅里叶变换 (FFT 单边幅值谱)"
        >
          {{ isFftAnalyzing ? 'FFT 计算中…' : 'FFT 频谱' }}
        </button>

        <!-- 阶跃分析按钮 -->
        <button
          type="button"
          class="btn-chart-tool"
          :class="{ 'is-analyzing': isStepModalOpen || isStepAnalyzing }"
          :disabled="isStepAnalyzing"
          @click="triggerStepAnalysis"
          title="执行控制理论阶跃响应特征分析 (超调量 Mp、上升时间 tr、调节时间 ts)"
        >
          {{ isStepAnalyzing ? '阶跃计算中…' : '阶跃分析' }}
        </button>

        <!-- CSV 导出 -->
        <button
          type="button"
          class="btn-chart-tool"
          @click="exportCsv"
          title="导出当前视窗为 CSV 文件"
        >
          导出 CSV
        </button>

</div></details>

        <!-- 暂停/继续 -->
        <button
          type="button"
          class="btn-chart-tool"
          :class="{ 'is-paused': isPaused }"
          @click="togglePause"
          :title="isPaused ? '继续流式绘制' : '暂停当前画面以供游标测量'"
        >
          {{ isPaused ? '继续显示' : '暂停显示' }}
        </button>

        <!-- 全屏最大化/还原切换 -->
        <button
          type="button"
          class="btn-chart-tool"
          @click="toggleFullscreen"
          :title="isFullscreen ? '还原尺寸' : '全屏放大查看'"
        >
          {{ isFullscreen ? '还原' : '全屏' }}
        </button>
      </div>
    </header>

    <!-- uPlot 渲染视口 (波形模式) -->
    <div v-show="viewMode === 'waveform'" class="chart-viewport" ref="chartContainer">
      <div v-if="pointCount < 2" class="chart-empty-state">
        <svg viewBox="0 0 48 32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 17h9l5-11 8 21 7-15 4 5h11" stroke-linejoin="round" stroke-linecap="round"/></svg>
        <strong>等待遥测数据</strong>
        <span>选择串口并连接设备，或点击上方「体验演示」。</span>
        <small>收到有效样本后显示波形；无曲线时请核对协议与通道绑定。</small>
      </div>
    </div>

    <!-- 柱状/条形图渲染视口 (VOFA+ 直方观察模式) -->
    <div v-if="viewMode === 'bar'" class="chart-bar-viewport custom-scrollbar">
      <div
        v-for="item in barChartData"
        :key="item.channel"
        class="bar-item-card"
        :class="{ 'is-hidden': !item.visible }"
      >
        <div class="bar-header">
          <div class="bar-info-left">
            <span class="bar-color-dot" :style="{ backgroundColor: item.color }"></span>
            <span class="bar-name font-mono" :title="item.name">{{ item.name }}</span>
          </div>
          <span class="bar-val font-mono" :style="{ color: item.color }">
            {{ item.current !== null ? item.current.toFixed(item.decimal) : '--' }}
          </span>
        </div>
        <div class="bar-track">
          <div
            class="bar-fill"
            :style="{
              width: `${item.current !== null && item.max > item.min ? Math.max(0, Math.min(100, ((item.current - item.min) / (item.max - item.min)) * 100)) : 50}%`,
              backgroundColor: item.color,
            }"
          ></div>
        </div>
        <div class="bar-limits font-mono">
          <span>Min: {{ item.min.toFixed(1) }}</span>
          <span>Max: {{ item.max.toFixed(1) }}</span>
        </div>
      </div>
    </div>

    <!-- FFT 频谱分析浮动卡片抽屉 (VOFA+ 原生频谱) -->
    <div v-if="isFftOpen" class="fft-analysis-drawer">
      <div class="fft-drawer-header">
        <div class="drawer-title-wrap">
          <span class="drawer-title">📊 快速傅里叶变换频谱分析 (FFT Spectrum)</span>
          <span class="sample-rate-tag" v-if="fftResult && fftInputQuality">
            时间戳估算 {{ fftResult.sampleRate }} Hz · 间隔最大偏差 {{ fftInputQuality.maxIntervalDeviationPct?.toFixed(2) }}%
          </span>
        </div>
        <button class="drawer-close" @click="isFftOpen = false">✕</button>
      </div>
      <div class="fft-drawer-body" v-if="fftResult">
        <div class="fft-summary-bar">
          <div class="summary-item">
            <span class="lbl">主频峰值:</span>
            <span class="val font-mono highlight">{{ fftResult.peakFreq }} Hz</span>
          </div>
          <div class="summary-item">
            <span class="lbl">主频幅值:</span>
            <span class="val font-mono">{{ fftResult.peakAmp }}</span>
          </div>
          <div class="summary-item">
            <span class="lbl">FFT 点数:</span>
            <span class="val font-mono">{{ fftResult.frequencies.length * 2 }} 点 (Hanning窗)</span>
          </div>
        </div>

        <!-- 频谱 SVG 柱状/折线图 -->
        <div class="fft-chart-box">
          <svg class="fft-svg" viewBox="0 0 500 160" preserveAspectRatio="none">
            <!-- 频域网格线 -->
            <line x1="0" y1="40" x2="500" y2="40" stroke="rgba(255,255,255,0.06)" stroke-dasharray="2,2" />
            <line x1="0" y1="80" x2="500" y2="80" stroke="rgba(255,255,255,0.06)" stroke-dasharray="2,2" />
            <line x1="0" y1="120" x2="500" y2="120" stroke="rgba(255,255,255,0.06)" stroke-dasharray="2,2" />

            <!-- 频谱多边形与折线 -->
            <polygon :points="fftPolygonPoints" fill="var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25))" />
            <polyline :points="fftPolylinePoints" fill="none" stroke="var(--accent-terracotta, #DA7756)" stroke-width="1.5" />
          </svg>
          <div class="fft-x-labels">
            <span>0 Hz</span>
            <span>{{ (fftResult.sampleRate / 4).toFixed(0) }} Hz</span>
            <span>{{ (fftResult.sampleRate / 2).toFixed(0) }} Hz (奈奎斯特极限)</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 阶跃分析浮动卡片抽屉 (可折叠) -->
    <div v-if="isStepModalOpen" class="step-analysis-drawer">
      <div class="step-drawer-header">
        <span class="drawer-title">⚡ 阶跃响应动力学特征</span>
        <button class="drawer-close" @click="isStepModalOpen = false">✕</button>
      </div>
      <div class="step-drawer-body">
        <template v-if="latestStepMetrics">
          <div class="metric-grid">
            <div class="metric-tile">
              <span class="lbl">超调量 Mp</span>
              <span
                class="val font-mono"
                :class="{
                  'val-good': latestStepMetrics.overshoot_pct <= 15,
                  'val-warn': latestStepMetrics.overshoot_pct > 15 && latestStepMetrics.overshoot_pct <= 30,
                  'val-danger': latestStepMetrics.overshoot_pct > 30,
                }"
              >
                {{ latestStepMetrics.overshoot_pct }}%
              </span>
            </div>
            <div class="metric-tile">
              <span class="lbl">调节时间 ts</span>
              <span class="val font-mono">
                {{ latestStepMetrics.settling_time_s != null ? `${(latestStepMetrics.settling_time_s * 1000).toFixed(0)} ms` : '--' }}
              </span>
            </div>
            <div class="metric-tile">
              <span class="lbl">上升时间 tr</span>
              <span class="val font-mono">
                {{ latestStepMetrics.rise_time_s != null ? `${(latestStepMetrics.rise_time_s * 1000).toFixed(0)} ms` : '--' }}
              </span>
            </div>
            <div class="metric-tile">
              <span class="lbl">稳态误差 ess</span>
              <span class="val font-mono">{{ latestStepMetrics.steady_state_error }}</span>
            </div>
            <div class="metric-tile">
              <span class="lbl">阻尼比 ζ</span>
              <span class="val font-mono">{{ latestStepMetrics.damping_ratio ?? '--' }}</span>
            </div>
            <div class="metric-tile">
              <span class="lbl">收敛状态</span>
              <span class="val-badge" :class="latestStepMetrics.is_stable ? 'badge-stable' : 'badge-unstable'">
                {{ latestStepMetrics.is_stable ? '已稳定收敛' : '振荡/未收敛' }}
              </span>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="step-empty-tip" role="status">{{ stepAnalysisMessage }}</div>
        </template>
        <label class="step-time-input">
          <span>已知阶跃时刻（秒，可选）</span>
          <input v-model="stepTimeInput" type="number" inputmode="decimal" step="any" placeholder="留空则检测目标通道变化" />
          <button type="button" :disabled="isStepAnalyzing" @click="triggerStepAnalysis">{{ isStepAnalyzing ? '计算中…' : '按此时刻重算' }}</button>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart-more { position:relative; flex-shrink:0; font-size:12px; }.chart-more summary { cursor:pointer; padding:6px 8px; min-height:32px; white-space:nowrap; box-sizing:border-box; border:1px solid var(--border-subtle); border-radius:5px; }.chart-more-items { position:absolute; right:0; top:100%; min-width:160px; background:var(--bg-surface); border:1px solid var(--border-strong); border-radius:6px; padding:6px; display:flex; flex-direction:column; gap:6px; z-index:20; box-shadow:var(--card-shadow); }.chart-more-items .btn-chart-tool { justify-content:flex-start; min-height:32px; font-size:12px; }

.flagship-chart-widget {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-surface, #272623);
  position: relative;
  container-type: size;
  overflow: hidden;
  user-select: none;
  transition: background-color 0.25s ease;
}

.chart-header {
  min-height: 40px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  justify-content: space-between;
  padding: 4px 8px;
  flex-shrink: 0;
  z-index: 10;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

.series-pills {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 160px;
  min-width: 0;
  max-width: 100%;
  max-height: 72px;
  flex-wrap: wrap;
  overflow: auto;
}

.series-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 9999px;
  padding: 4px 8px;
  min-height: 32px;
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-main, #ECEAE4);
  cursor: pointer;
  transition: all 0.15s ease;
}

.series-pill:hover {
  background: var(--bg-elevated, #2F2E2A);
  border-color: var(--accent-terracotta, #DA7756);
}

.series-pill.is-hidden {
  opacity: 0.35;
  text-decoration: line-through;
}

.series-name {
  max-width: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.series-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.chart-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 360px;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.chart-actions > .btn-chart-tool { order: 0; }
.view-mode-tabs { order: 1; }
.chart-more { order: 2; }
.stat-badge { order: 3; }
.live-status-pill { order: 4; }

.stat-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  font-size: 12px;
  min-height: 32px;
  max-width: 100%;
  flex-wrap: wrap;
  white-space: nowrap;
  font-family: monospace;
  padding: 2px 6px;
  border-radius: 4px;
}

.btn-clear-stat {
  background: transparent;
  border: none;
  color: var(--accent-terracotta, #DA7756);
  cursor: pointer;
  padding: 0;
  font-size: 10px;
  margin-left: 2px;
}

.live-status-pill {
  font-size: 12px;
  min-height: 32px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  font-family: monospace;
}
.live-status-pill.pill-paused {
  background: color-mix(in srgb, var(--accent-amber) 12%, var(--bg-surface));
  border: 1px solid var(--accent-amber);
  color: var(--accent-amber);
}
.live-status-pill:hover {
  background: color-mix(in srgb, var(--accent-amber) 20%, var(--bg-surface));
  border-color: var(--accent-amber);
}

.btn-chart-tool {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
  min-height: 32px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-chart-tool:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-main, #ECEAE4);
  border-color: var(--border-strong, #4A4843);
}

.btn-chart-tool.is-paused {
  background: color-mix(in srgb, var(--accent-rose) 12%, var(--bg-surface));
  border-color: var(--accent-rose);
  color: var(--accent-rose);
}

.btn-chart-tool.is-analyzing {
  background: color-mix(in srgb, var(--accent-amber) 12%, var(--bg-surface));
  border-color: var(--accent-amber);
  color: var(--accent-amber);
}

.view-mode-tabs {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  padding: 1px;
  border-radius: 4px;
}

.btn-chart-tool.btn-mode.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.18));
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  font-weight: 600;
}

.chart-viewport {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.chart-empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  pointer-events: none;
}

.chart-empty-state svg { width:48px; height:32px; color:var(--accent-terracotta); margin-bottom:6px; }
.chart-empty-state strong { font-size:15px; font-weight:550; color:var(--text-main); }
.chart-empty-state small { max-width:42ch; font-size:11px; line-height:1.6; }

/* 柱状直方图视口 */
.chart-bar-viewport {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-base, #1F1E1D);
}

.bar-item-card {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: opacity 0.2s ease;
}

.bar-item-card.is-hidden {
  opacity: 0.35;
}

.bar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bar-info-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bar-color-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.bar-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.bar-val {
  font-size: 13px;
  font-weight: 700;
}

.bar-track {
  width: 100%;
  height: 8px;
  background: var(--bg-elevated, #2F2E2A);
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
}

.bar-limits {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-soft, #706E66);
}

/* 阶跃抽屉 */
.step-analysis-drawer {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 320px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 8px;
  box-shadow: var(--card-shadow, 0 8px 24px rgba(0, 0, 0, 0.45));
  backdrop-filter: blur(8px);
  z-index: 20;
  overflow: hidden;
}

.step-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.drawer-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-terracotta, #DA7756);
}

.drawer-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 12px;
}

.drawer-close:hover {
  color: var(--text-main, #ECEAE4);
}

.step-drawer-body {
  padding: 8px 10px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.metric-tile {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
}

.metric-tile .lbl {
  font-size: 9px;
  color: var(--text-muted, #9E9C94);
}

.metric-tile .val {
  font-size: 12px;
  font-weight: bold;
  color: var(--text-main, #ECEAE4);
}

.val-good {
  color: #7AA89B !important;
}

.val-warn {
  color: #E59E38 !important;
}

.val-danger {
  color: #E06D85 !important;
}

.val-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 2px;
  text-align: center;
  margin-top: 2px;
}

.badge-stable {
  background: rgba(122, 168, 155, 0.2);
  color: #7AA89B;
}

.badge-unstable {
  background: rgba(224, 109, 133, 0.2);
  color: #E06D85;
}

.step-empty-tip {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  text-align: center;
  padding: 8px 0;
}

.step-time-input {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
}

.step-time-input input {
  width: 110px;
  min-width: 72px;
  padding: 4px 6px;
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
  font: inherit;
}

.step-time-input input:focus {
  border-color: var(--accent-terracotta, #DA7756);
  outline: none;
}

.step-time-input button {
  padding: 4px 7px;
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 4px;
  color: #ffffff;
  background: var(--accent-terracotta, #DA7756);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.step-time-input button:hover {
  background: var(--accent-terracotta-hover, #E58565);
}


.flagship-chart-widget.is-fullscreen {
  position: fixed !important;
  inset: 12px !important;
  z-index: 1000 !important;
  border-radius: 12px !important;
  border: 1px solid var(--accent-terracotta, #DA7756) !important;
  box-shadow: 0 0 50px rgba(0, 0, 0, 0.9) !important;
}

/* FFT 频谱分析抽屉 */
.fft-analysis-drawer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-surface, #272623);
  border-top: 1px solid var(--accent-terracotta, #DA7756);
  box-shadow: var(--card-shadow, 0 -8px 24px rgba(0, 0, 0, 0.4));
  backdrop-filter: blur(8px);
  z-index: 25;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.2s ease-out;
  max-height: 280px;
}

.fft-drawer-header {
  height: 32px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.drawer-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sample-rate-tag {
  font-size: 11px;
  font-family: monospace;
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  padding: 1px 6px;
  border-radius: 3px;
}

.fft-drawer-body {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fft-summary-bar {
  display: flex;
  gap: 20px;
  font-size: 12px;
}

.fft-summary-bar .summary-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.fft-summary-bar .lbl {
  color: var(--text-muted, #9E9C94);
}

.fft-summary-bar .val {
  color: var(--text-main, #ECEAE4);
}

.fft-summary-bar .val.highlight {
  color: var(--accent-terracotta, #DA7756);
  font-weight: 700;
  font-size: 13px;
}

.fft-chart-box {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fft-svg {
  width: 100%;
  height: 120px;
  overflow: visible;
}

.fft-x-labels {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  font-family: monospace;
  color: var(--text-muted, #9E9C94);
}

.chart-header :is(button, summary):focus-visible {
  outline: 2px solid var(--accent-terracotta);
  outline-offset: 2px;
}

@container (max-width: 640px) {
  .series-pills {
    flex-basis: 100%;
    flex-wrap: nowrap;
    max-height: 32px;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .chart-actions { flex-basis: 100%; justify-content: flex-start; }
}

@container (max-height: 220px) {
  .chart-empty-state { gap: 6px; padding: 8px; }
  .chart-empty-state svg, .chart-empty-state small { display: none; }
}
</style>
