<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import type { PlantModel, DiscretizePidResult } from '../core/control/types';
import type { SimulateClosedLoopResult } from '../core/control/types';
import type { StepResponseMetrics } from '../core/analysis/types';
import { discretizePid } from '../core/control/discretize';
import { globalChannelStore } from '../core/channel/ChannelStore';
import { analysisWorker, type CancellableAnalysis } from '../services/analysis/analysis-worker-client';
import { getSimulationInputError } from '../core/control/simulationReadiness';
import { comparableStepMetrics } from '../core/control/simulationComparison';

const props = withDefaults(
  defineProps<{
    plant?: PlantModel | null;
    pid?: { kp: number; ki: number; kd: number; tf?: number } | null;
    sampleTime?: number;
    stepMetrics?: StepResponseMetrics | null;
    loopId?: string;
    loopName?: string;
    measuredChannelId?: string | null;
  }>(),
  {
    sampleTime: 0.001,
    loopId: 'speed',
    loopName: '速度环',
  }
);

const activePlant = computed(() => props.plant ?? null);
const activePid = computed(() => props.pid ?? null);
const simulationInputError = computed(() => getSimulationInputError(
  activePlant.value,
  activePid.value,
  props.sampleTime,
));
const isSimulationReady = computed(() => simulationInputError.value === null);

// 仿真预测闭环响应在独立 Worker 中执行，避免大采样时间窗冻结主界面。
const simResult = ref<SimulateClosedLoopResult | null>(null);
const simulationBusy = ref(false);
const simulationError = ref('');
let simulationJob: CancellableAnalysis<SimulateClosedLoopResult> | null = null;

async function runSimulation() {
  simulationJob?.cancel();
  simResult.value = null;
  simulationError.value = simulationInputError.value || '';
  if (!isSimulationReady.value || !activePlant.value || !activePid.value) {
    simulationBusy.value = false;
    return;
  }
  const job = analysisWorker.runSimulation({
    plant: activePlant.value,
    pid: activePid.value,
    sampleTime: props.sampleTime,
    simTime: 1.5,
    stepValue: 1.0,
    initialValue: 0.0,
  }, {
    source: 'simulation',
    generation: globalChannelStore.getGeneration(),
    channelIds: [],
  });
  simulationJob = job;
  simulationBusy.value = true;
  simulationError.value = '';
  simResult.value = null;
  try {
    const result = await job.promise;
    if (simulationJob?.id !== job.id) return;
    simResult.value = result;
    simulationError.value = result.metrics_error || '';
  } catch (error) {
    if (simulationJob?.id !== job.id) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!/取消/.test(message)) simulationError.value = message;
  } finally {
    if (simulationJob?.id === job.id) {
      simulationJob = null;
      simulationBusy.value = false;
    }
  }
}

const predMetrics = computed(() => simResult.value?.metrics ?? null);
const sessionGeneration = ref(globalChannelStore.getGeneration());
const measuredMetrics = computed(() => { void sessionGeneration.value; return comparableStepMetrics(props.stepMetrics, props.measuredChannelId, {
  ...globalChannelStore.getSessionContext(),
  generation: globalChannelStore.getGeneration(),
}); });

// 离散化 C 代码
const codeTab = ref<'incremental' | 'positional'>('incremental');
const discretizeResult = computed<DiscretizePidResult | null>(() => {
  if (!isSimulationReady.value || !activePid.value) return null;
  return discretizePid({
    kp: activePid.value.kp,
    ki: activePid.value.ki,
    kd: activePid.value.kd,
    sampleTime: props.sampleTime,
    outputLimits: [-100, 100],
  });
});

const currentCCode = computed(() => {
  if (!discretizeResult.value) return simulationInputError.value || '等待有效模型和 PID 候选。';
  if (codeTab.value === 'incremental') {
    return discretizeResult.value.incremental.c_code;
  }
  return discretizeResult.value.positional.c_code;
});

const copySuccess = ref(false);
const copyError = ref('');
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCode() {
  if (!discretizeResult.value) return;
  copyError.value = '';
  try {
    if (!navigator.clipboard) throw new Error('当前环境不支持剪贴板，请选择代码后手动复制');
    await navigator.clipboard.writeText(currentCCode.value);
    copySuccess.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copySuccess.value = false;
    }, 2000);
  } catch (error) { copySuccess.value = false; copyError.value = error instanceof Error ? error.message : String(error); }
}

// Canvas 绘制阶跃对比响应
const simCanvasRef = ref<HTMLCanvasElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let clearUnsubscribe: (() => void) | null = null;

function drawStepComparison() {
  const canvas = simCanvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(w * dpr), targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) { canvas.width = targetW; canvas.height = targetH; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const result = simResult.value;
  if (!result) return;
  const times = result.times;
  const vals = result.values;
  if (!times || times.length === 0) return;

  const padLeft = 40;
  const padRight = 20;
  const padTop = 15;
  const padBottom = 22;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const tMax = times[times.length - 1];
  if (!Number.isFinite(tMax) || tMax <= 0) return;
  let yMax = 1.3;
  let yMin = 0;
  for (const value of vals) {
    if (Number.isFinite(value)) { yMax = Math.max(yMax, value); yMin = Math.min(yMin, value); }
  }

  const mapX = (t: number) => padLeft + (t / tMax) * plotW;
  const mapY = (v: number) => padTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // 1. 背景与网格 (主题自适应)
  const theme = getComputedStyle(document.documentElement);
  const color = (name: string) => theme.getPropertyValue(name).trim();
  ctx.fillStyle = color('--bg-base');
  ctx.fillRect(padLeft, padTop, plotW, plotH);

  ctx.strokeStyle = color('--border-subtle');
  ctx.lineWidth = 1;

  // 时间刻度
  ctx.fillStyle = color('--text-muted');
  ctx.font = `11px ${color('--font-mono')}`;
  ctx.textAlign = 'center';
  const tSteps = 5;
  for (let i = 0; i <= tSteps; i++) {
    const t = (tMax / tSteps) * i;
    const x = mapX(t);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
    ctx.fillText(`${t.toFixed(2)}s`, x, h - 6);
  }

  // 目标值 1.0 水平线
  const y1 = mapY(1.0);
  ctx.strokeStyle = color('--text-muted');
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, y1);
  ctx.lineTo(padLeft + plotW, y1);
  ctx.stroke();

  // ±2% 稳态误差带 (0.98 ~ 1.02)
  const yUpper = mapY(1.02);
  const yLower = mapY(0.98);
  ctx.fillStyle = color('--accent-emerald');
  ctx.globalAlpha = .12;
  ctx.fillRect(padLeft, yUpper, plotW, yLower - yUpper);
  ctx.globalAlpha = 1;

  ctx.setLineDash([]);

  // Y 轴刻度
  ctx.textAlign = 'right';
  ctx.fillStyle = color('--text-muted');
  ctx.fillText('1.0', padLeft - 6, y1 + 3);
  ctx.fillText('0.5', padLeft - 6, mapY(0.5) + 3);
  ctx.fillText('0.0', padLeft - 6, mapY(0.0) + 3);

  // 仅绘制模型预测。未对齐的实测数据与推测轮廓不能标为实测曲线。
  // 3. 绘制理论闭环预测响应曲线 (陶土强调色实线)
  ctx.strokeStyle = color('--wave-1');
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i = 0; i < times.length; i++) {
    const x = mapX(times[i]);
    const y = mapY(vals[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 4. 超调量峰值与调节时间标记
  const metrics = predMetrics.value;
  if (!metrics) return;
  const peakVal = metrics.y_max;
  const peakY = mapY(peakVal);
  if (metrics.overshoot_pct > 0.5) {
    ctx.fillStyle = color('--wave-1');
    ctx.beginPath();
    ctx.arc(mapX(times[vals.indexOf(peakVal)]), peakY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillText(`预测 Mp=${metrics.overshoot_pct.toFixed(1)}%`, mapX(times[vals.indexOf(peakVal)]) + 6, peakY - 4);
  }
}

watch([activePlant, activePid, () => props.sampleTime], () => {
  void runSimulation();
}, { immediate: true, deep: true });

watch([simResult, codeTab], () => {
  nextTick(drawStepComparison);
});

onMounted(() => {
  clearUnsubscribe = globalChannelStore.onCleared(() => { sessionGeneration.value = globalChannelStore.getGeneration(); });
  resizeObserver = new ResizeObserver(drawStepComparison);
  if (simCanvasRef.value) resizeObserver.observe(simCanvasRef.value);
  themeObserver = new MutationObserver(drawStepComparison);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  nextTick(() => {
    drawStepComparison();
  });
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  clearUnsubscribe?.();
  if (copyTimer) clearTimeout(copyTimer);
  simulationJob?.cancel();
  simulationJob = null;
});

</script>

<template>
  <section class="sim-compare-view" aria-label="仿真预测对比">
    <header class="sim-heading">
      <h2>仿真预测对比</h2>
      <p>基于当前模型与 PID 的单位阶跃预测。设备实测需关联同一会话与反馈通道。</p>
    </header>
    <div class="sim-canvas-box">
      <canvas ref="simCanvasRef" width="880" height="240" class="sim-canvas" aria-label="单位阶跃模型预测响应"></canvas>
      <div v-if="!simResult" class="sim-empty" role="status">
        <strong>{{ simulationBusy ? '正在计算模型响应' : '尚未生成预测曲线' }}</strong>
        <span>{{ simulationError || '在高级分析中配置有效对象模型、PID 与采样周期后查看结果。' }}</span>
      </div>
      <div class="sim-legend">
        <span><i class="legend-line"></i>模型预测</span>
        <span><i class="legend-band"></i>±2% 容差带</span>
        <span>模型采样周期 {{ (sampleTime * 1000).toPrecision(3) }} ms</span>
      </div>
    </div>
    <p v-if="!measuredMetrics" class="comparison-note">尚无与当前会话、反馈通道关联的实测指标。未绘制推测的实测曲线。</p>
    <div class="table-scroll">
      <table class="compare-table">
        <caption class="visually-hidden">已关联的实测指标与模型预测指标</caption>
        <thead><tr><th scope="col">指标</th><th scope="col">关联实测</th><th scope="col">模型预测</th></tr></thead>
        <tbody>
          <tr><th scope="row">超调量 Mp</th><td>{{ measuredMetrics ? measuredMetrics.overshoot_pct.toFixed(1) + '%' : '—' }}</td><td>{{ predMetrics ? predMetrics.overshoot_pct.toFixed(1) + '%' : '—' }}</td></tr>
          <tr><th scope="row">调节时间 ts</th><td>{{ measuredMetrics?.settling_time_s != null ? measuredMetrics.settling_time_s.toFixed(3) + ' s' : '—' }}</td><td>{{ predMetrics?.settling_time_s != null ? predMetrics.settling_time_s.toFixed(3) + ' s' : '—' }}</td></tr>
          <tr><th scope="row">归一化稳态误差</th><td>{{ measuredMetrics ? (measuredMetrics.steady_state_error / measuredMetrics.step_amplitude).toFixed(4) : '—' }}</td><td>{{ predMetrics ? predMetrics.steady_state_error.toFixed(4) : '—' }}</td></tr>
        </tbody>
      </table>
    </div>
    <details class="code-export">
      <summary>导出 PID 代码示例</summary>
      <p class="comparison-note">示例输出限幅为 ±100。采样周期、单位、积分与输出边界须按固件核对。</p>
      <div class="code-export-header">
        <div class="code-tab-switch" aria-label="PID 实现形式">
          <button type="button" :aria-pressed="codeTab === 'incremental'" @click="codeTab = 'incremental'">增量式</button>
          <button type="button" :aria-pressed="codeTab === 'positional'" @click="codeTab = 'positional'">位置式</button>
        </div>
        <button type="button" :disabled="!discretizeResult" @click="copyCode">{{ copySuccess ? '已复制' : '复制代码' }}</button>
      </div>
      <pre class="code-snippet-box"><code>{{ currentCCode }}</code></pre>
      <p v-if="copyError" role="status" class="comparison-note">{{ copyError }}</p>
    </details>
  </section>
</template>

<style scoped>
.sim-compare-view { display:flex; flex-direction:column; gap:16px; padding:20px; height:100%; min-height:0; color:var(--text-main); background:var(--bg-surface); overflow:auto; }
.sim-compare-view > * { flex-shrink:0; }
.sim-heading h2 { margin:0 0 6px; font-size:16px; font-weight:600; }
.sim-heading p,.comparison-note { margin:0; font-size:12px; line-height:1.65; color:var(--text-muted); }
.sim-canvas-box { position:relative; background:var(--bg-base); border:1px solid var(--border-subtle); border-radius:8px; padding:12px; }
.sim-canvas { display:block; width:100%; height:240px; }
.sim-empty { position:absolute; inset:12px 12px 42px; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:8px; padding:20px; text-align:center; }
.sim-empty strong { font-size:14px; font-weight:600; }
.sim-empty span { max-width:48ch; color:var(--text-muted); font-size:12px; line-height:1.65; }
.sim-legend { display:flex; flex-wrap:wrap; gap:16px; margin-top:10px; color:var(--text-muted); font-size:12px; }
.sim-legend span { display:inline-flex; align-items:center; gap:7px; }
.legend-line { width:16px; border-top:2px solid var(--wave-1); }
.legend-band { width:16px; height:8px; background:var(--accent-emerald); opacity:.5; }
.table-scroll { overflow:auto; }
.compare-table { width:100%; border-collapse:collapse; font-size:13px; text-align:left; font-variant-numeric:tabular-nums; }
.compare-table th,.compare-table td { padding:10px 12px; border-bottom:1px solid var(--border-subtle); }
.compare-table thead th { color:var(--text-muted); font-size:12px; font-weight:500; background:var(--bg-elevated); }
.compare-table tbody th { font-weight:500; }
.compare-table td { font-family:var(--font-mono); }
.code-export { border-top:1px solid var(--border-subtle); padding-top:14px; }
.code-export summary { cursor:pointer; font-size:13px; font-weight:500; padding:5px 0; }
.code-export .comparison-note { margin:10px 0; }
.code-export-header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:12px 0; }
.code-tab-switch { display:flex; gap:6px; }
.code-export button { min-height:32px; padding:6px 12px; font-size:12px; color:var(--text-main); background:var(--bg-elevated); border:1px solid var(--border-subtle); border-radius:6px; cursor:pointer; }
.code-export button:hover:enabled { background:var(--bg-base); border-color:var(--border-strong); }
.code-export button[aria-pressed='true'] { color:var(--accent-terracotta); border-color:var(--accent-terracotta); background:var(--accent-terracotta-soft); }
.code-export button:disabled { opacity:.45; cursor:not-allowed; }
.code-snippet-box { margin:0; padding:14px; background:var(--bg-base); color:var(--text-main); border-radius:6px; font:12px/1.7 var(--font-mono); overflow:auto; max-height:320px; white-space:pre; }
@media(max-width:700px) { .sim-compare-view { padding:14px; } .sim-canvas { height:200px; } .sim-legend { gap:10px; } .compare-table th,.compare-table td { padding:9px 8px; } }
</style>
