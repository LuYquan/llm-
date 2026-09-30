<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import type { PlantModel, BodeResult, PidStructure } from '../core/control/types';
import { computeBode } from '../core/control/computeBode';
import { solvePid } from '../core/control/solvePid';
import { recommendTargets } from '../core/control/recommendTargets';
import { getPidCandidateUseError, getPlantModelError } from '../core/control/simulationReadiness';

const EXAMPLE_PLANT: PlantModel = {
  family: 'fopdt',
  k: 1.8,
  t: 0.22,
  tau: 0.015,
};

const props = withDefaults(
  defineProps<{
    plant?: PlantModel | null;
    plantOrigin?: 'identified' | 'manual';
    sampleTime?: number;
    initialKp?: number;
    initialKi?: number;
    initialKd?: number;
    loopId?: string;
    loopName?: string;
  }>(),
  {
    sampleTime: 0.001,
    plantOrigin: 'manual',
    loopId: 'speed',
    loopName: '速度环',
  }
);

const emit = defineEmits<{
  (e: 'apply-command', cmd: string): void;
  (e: 'save-quick', cmd: { name: string; command: string }): void;
  (e: 'solved-pid', pid: { kp: number; ki: number; kd: number } | null): void;
  (e: 'update:plant', plant: PlantModel): void;
  (e: 'trigger-identify'): void;
}>();

// 本地受控对象响应式模型 (支持外部辨识注入与现场手动修正)
function clonePlant(plant: PlantModel): PlantModel {
  return plant.family === 'transfer_function'
    ? { ...plant, numerator: [...plant.numerator], denominator: [...plant.denominator] }
    : { ...plant };
}
const localPlant = ref<PlantModel>(clonePlant(props.plant ?? EXAMPLE_PLANT));
const numeratorDraft = ref(localPlant.value.family === 'transfer_function' ? localPlant.value.numerator.join(', ') : '');
const denominatorDraft = ref(localPlant.value.family === 'transfer_function' ? localPlant.value.denominator.join(', ') : '');
const plantSource = ref<'example' | 'identified' | 'manual'>(props.plant ? props.plantOrigin : 'example');
let manualPlantEcho: string | null = null;
const hasControllerBaseline = computed(() =>
  [props.initialKp, props.initialKi, props.initialKd].every((value) => Number.isFinite(value))
);
const plantSourceLabel = computed(() => ({
  example: '示例参数，仅用于离线预览',
  identified: '已辨识模型',
  manual: getPlantModelError(localPlant.value) ? '手动模型草稿 · 待补齐' : '手动设定模型',
}[plantSource.value]));

watch(
  () => props.plant,
  (newP) => {
    const nextModel = JSON.stringify(newP ?? null);
    if (newP && manualPlantEcho === nextModel) {
      manualPlantEcho = null;
      localPlant.value = clonePlant(newP);
      return;
    }
    manualPlantEcho = null;
    localPlant.value = clonePlant(newP ?? EXAMPLE_PLANT);
    numeratorDraft.value = localPlant.value.family === 'transfer_function' ? localPlant.value.numerator.join(', ') : '';
    denominatorDraft.value = localPlant.value.family === 'transfer_function' ? localPlant.value.denominator.join(', ') : '';
    plantSource.value = newP ? props.plantOrigin : 'example';
    invalidateSolvedPid(newP ? '对象模型已更新，请重新解算 PID。' : '当前是示例模型，仅用于离线预览。');
  },
  { deep: true }
);

function onPlantChange() {
  plantSource.value = 'manual';
  manualPlantEcho = JSON.stringify(localPlant.value);
  invalidateSolvedPid('对象参数已修改，请重新解算 PID。');
  emit('update:plant', clonePlant(localPlant.value));
}

const solvedPid = ref<{ kp: number; ki: number; kd: number } | null>(null);
const solvedBasisSignature = ref<string | null>(null);
function invalidateSolvedPid(message: string) {
  solvedPid.value = null;
  solvedBasisSignature.value = null;
  solveSuccess.value = false;
  curKp.value = Number.isFinite(props.initialKp) ? props.initialKp! : 0;
  curKi.value = Number.isFinite(props.initialKi) ? props.initialKi! : 0;
  curKd.value = Number.isFinite(props.initialKd) ? props.initialKd! : 0;
  solveMsg.value = message;
  emit('solved-pid', null);
}

const controllerSourceLabel = computed(() => solvedPid.value
  ? '本次频域解算候选'
  : hasControllerBaseline.value
    ? '项目 PID 基线，尚未确认设备回读'
    : '未提供 PID 参数');

watch(() => props.sampleTime, (sampleTime, previous) => {
  if (sampleTime !== previous) invalidateSolvedPid('采样周期已变化，请重新解算 PID。');
});

watch(() => [props.initialKp, props.initialKi, props.initialKd] as const, ([kp, ki, kd], previous) => {
  if (previous && (kp !== previous[0] || ki !== previous[1] || kd !== previous[2])) {
    curKp.value = Number.isFinite(kp) ? kp! : 0;
    curKi.value = Number.isFinite(ki) ? ki! : 0;
    curKd.value = Number.isFinite(kd) ? kd! : 0;
    invalidateSolvedPid('项目 PID 基线已变化，请重新解算。');
  }
});

const showPlantEdit = ref(false);
const plantSummary = computed(() => getPlantModelError(localPlant.value) ? '模型参数待补齐或修正' : localPlant.value.family === 'transfer_function'
  ? `分子 [${localPlant.value.numerator.join(', ')}] / 分母 [${localPlant.value.denominator.join(', ')}]`
  : `K=${localPlant.value.k}, ${localPlant.value.family === 'sopdt' ? `ωn=${localPlant.value.wn}, ζ=${localPlant.value.zeta}` : `T=${localPlant.value.t}s`}`);
function changePlantFamily(event: Event) {
  const family = (event.target as HTMLSelectElement).value as PlantModel['family'];
  if (family === localPlant.value.family) return;
  const tau = NaN;
  numeratorDraft.value = denominatorDraft.value = '';
  localPlant.value = family === 'transfer_function'
    ? { family, numerator: [], denominator: [], tau }
    : family === 'sopdt'
      ? { family, k: NaN, wn: NaN, zeta: NaN, tau }
      : { family, k: NaN, t: NaN, tau };
  onPlantChange();
}
function changeCoefficients(which: 'numerator' | 'denominator', event: Event) {
  if (localPlant.value.family !== 'transfer_function') return;
  const text = (event.target as HTMLInputElement).value.trim();
  if (which === 'numerator') numeratorDraft.value = (event.target as HTMLInputElement).value;
  else denominatorDraft.value = (event.target as HTMLInputElement).value;
  localPlant.value[which] = text ? text.split(/[,，\s]+/).map(Number) : [];
  onPlantChange();
}
function togglePlantEditor() {
  showPlantEdit.value = !showPlantEdit.value;
  if (!showPlantEdit.value || plantSource.value !== 'example') return;
  const family = localPlant.value.family;
  localPlant.value = family === 'transfer_function'
    ? { family, numerator: [], denominator: [], tau: NaN }
    : family === 'sopdt'
      ? { family, k: NaN, wn: NaN, zeta: NaN, tau: NaN }
      : { family, k: NaN, t: NaN, tau: NaN };
  numeratorDraft.value = denominatorDraft.value = '';
  onPlantChange();
}

// 可调参数与解算目标
const targetWc = ref(15.0);
const targetPm = ref(55.0);
const structure = ref<PidStructure>('PI');
const pidConstraintType = ref<'ratio' | 'corner'>('ratio');
const targetWd = ref(50.0);
const curKp = ref(props.initialKp ?? 0);
const curKi = ref(props.initialKi ?? 0);
const curKd = ref(props.initialKd ?? 0);

const solveMsg = ref('');
const solveSuccess = ref(false);
const currentSolveBasisSignature = computed(() => JSON.stringify({
  plant: localPlant.value,
  plantSource: plantSource.value,
  sampleTime: props.sampleTime,
  targetWc: targetWc.value,
  targetPm: targetPm.value,
  structure: structure.value,
  pidConstraintType: pidConstraintType.value,
  targetWd: targetWd.value,
}));
const canUseSolvedPid = computed(() => Boolean(
  solvedPid.value
    && solvedBasisSignature.value === currentSolveBasisSignature.value
    && getPidCandidateUseError(
      plantSource.value,
      solvedPid.value !== null,
      localPlant.value,
      solvedPid.value,
      props.sampleTime,
    ) === null
));

watch(currentSolveBasisSignature, (signature) => {
  if (solvedPid.value && solvedBasisSignature.value !== signature) {
    invalidateSolvedPid('解算目标或控制结构已变化，请重新解算 PID。');
  }
});

// 画布引用
const bodeCanvasRef = ref<HTMLCanvasElement | null>(null);
let themeObserver: MutationObserver | null = null;
let sizeObserver: ResizeObserver | null = null;

// 计算波特图
const bodeResult = computed<BodeResult>(() => {
  if (getPlantModelError(localPlant.value) || !Number.isFinite(props.sampleTime) || props.sampleTime <= 0
    || ![curKp.value, curKi.value, curKd.value].every(Number.isFinite)) {
    return { curve: [], omega_c: null, phase_margin: null, omega_pi: null, gain_margin_db: null, is_stable: null };
  }
  try { return computeBode(
    localPlant.value,
    {
      kp: curKp.value,
      ki: curKi.value,
      kd: curKd.value,
    },
    {
      sampleTime: props.sampleTime,
      omegaMin: 0.2,
      omegaMax: 500,
      pointsCount: 160,
    }
  ); } catch {
    return { curve: [], omega_c: null, phase_margin: null, omega_pi: null, gain_margin_db: null, is_stable: null };
  }
});

// 推荐目标 (结构感知)
function handleRecommend() {
  const plantError = plantSource.value === 'example'
    ? '当前对象是示例模型；请先实测辨识，或修改对象参数作为手动模型。'
    : getPlantModelError(localPlant.value) || (!Number.isFinite(props.sampleTime) || props.sampleTime <= 0
      ? '采样周期必须是大于 0 的有限数值。'
      : null);
  if (plantError) {
    solveMsg.value = plantError;
    solveSuccess.value = false;
    return;
  }
  const rec = recommendTargets({
    plant: localPlant.value,
    sampleTime: props.sampleTime,
    desired_phase_margin: targetPm.value,
    structure: structure.value,
  });
  targetWc.value = rec.recommended_omega_c;
  targetPm.value = rec.recommended_phase_margin;
  handleSolve();
}

// 闭式求解 PID
function handleSolve() {
  if (plantSource.value === 'example') {
    invalidateSolvedPid('当前对象是示例模型；它只用于离线预览，不能生成设备命令。请先实测辨识或手动设定对象参数。');
    return;
  }
  const plantError = getPlantModelError(localPlant.value);
  if (plantError || !Number.isFinite(props.sampleTime) || props.sampleTime <= 0) {
    invalidateSolvedPid(plantError || '采样周期必须是大于 0 的有限数值。');
    return;
  }

  solvedPid.value = null;
  emit('solved-pid', null);
  const res = solvePid(localPlant.value, {
    target_omega_c: targetWc.value,
    target_phase_margin: targetPm.value,
    structure: structure.value,
    sampleTime: props.sampleTime,
    derivativeCornerFrequency: pidConstraintType.value === 'corner' ? targetWd.value : undefined,
  });

  solveSuccess.value = res.success;
  solveMsg.value = res.message;

  if (res.success) {
    curKp.value = res.kp;
    curKi.value = res.ki;
    curKd.value = res.kd;
    solvedPid.value = { kp: res.kp, ki: res.ki, kd: res.kd };
    solvedBasisSignature.value = currentSolveBasisSignature.value;
    emit('solved-pid', solvedPid.value);
  }
}

// 格式化指令
const generatedCommand = computed(() => {
  if (!canUseSolvedPid.value || !solvedPid.value) return null;
  const loop = (props.loopId || 'SPEED').toUpperCase();
  return `SET:${loop}:KP=${solvedPid.value.kp.toFixed(4)},KI=${solvedPid.value.ki.toFixed(4)},KD=${solvedPid.value.kd.toFixed(4)}\n`;
});

function handleApply() {
  if (generatedCommand.value) emit('apply-command', generatedCommand.value);
}

function handleSaveQuick() {
  if (!generatedCommand.value) return;
  emit('save-quick', {
    name: `Bode 整定: ${props.loopName || '速度环'}`,
    command: generatedCommand.value,
  });
}

// 绘制波特图
function drawBode() {
  const canvas = bodeCanvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.clientWidth || 460;
  const h = canvas.clientHeight || 220;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
  if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const background = token('--bg-base');
  const grid = token('--border-subtle');
  const muted = token('--text-muted');
  const magnitudeColor = token('--accent-terracotta');
  const phaseColor = token('--accent-amber');
  const marginColor = token('--accent-emerald');

  const pts = bodeResult.value.curve;
  if (!pts || pts.length === 0) return;

  const padLeft = 45;
  const padRight = 20;
  const padTop = 15;
  const padBottom = 22;
  const gap = 16;
  const plotW = w - padLeft - padRight;
  const plotH = (h - padTop - padBottom - gap) / 2;

  const magY0 = padTop;
  const phaseY0 = padTop + plotH + gap;

  // X 轴对数坐标映射
  const logWMin = Math.log10(pts[0].omega);
  const logWMax = Math.log10(pts[pts.length - 1].omega);
  const mapX = (omega: number) => {
    const lw = Math.log10(omega);
    return padLeft + ((lw - logWMin) / (logWMax - logWMin)) * plotW;
  };

  // Y 轴范围
  const magMin = -60;
  const magMax = 40;
  const mapMagY = (db: number) => {
    const clamped = Math.max(magMin, Math.min(magMax, db));
    return magY0 + plotH - ((clamped - magMin) / (magMax - magMin)) * plotH;
  };

  const phaseMin = -270;
  const phaseMax = 0;
  const mapPhaseY = (deg: number) => {
    const clamped = Math.max(phaseMin, Math.min(phaseMax, deg));
    return phaseY0 + plotH - ((clamped - phaseMin) / (phaseMax - phaseMin)) * plotH;
  };

  // 1. 绘制网格与背景 (主题自适应)
  ctx.fillStyle = background;
  ctx.fillRect(padLeft, magY0, plotW, plotH);
  ctx.fillRect(padLeft, phaseY0, plotW, plotH);

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;

  // 频率刻度竖线 (对数格)
  const freqs = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  ctx.fillStyle = muted;
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';

  for (const f of freqs) {
    if (f >= pts[0].omega && f <= pts[pts.length - 1].omega) {
      const x = mapX(f);
      ctx.beginPath();
      ctx.moveTo(x, magY0);
      ctx.lineTo(x, magY0 + plotH);
      ctx.moveTo(x, phaseY0);
      ctx.lineTo(x, phaseY0 + plotH);
      ctx.stroke();
      ctx.fillText(String(f), x, h - 6);
    }
  }

  // 0 dB 水平虚线
  const y0Db = mapMagY(0);
  ctx.strokeStyle = magnitudeColor;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, y0Db);
  ctx.lineTo(padLeft + plotW, y0Db);
  ctx.stroke();
  ctx.setLineDash([]);

  // -180° 水平虚线
  const y180Deg = mapPhaseY(-180);
  ctx.strokeStyle = magnitudeColor;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, y180Deg);
  ctx.lineTo(padLeft + plotW, y180Deg);
  ctx.stroke();
  ctx.setLineDash([]);

  // Y 轴标签
  ctx.textAlign = 'right';
  ctx.fillStyle = muted;
  ctx.fillText('0dB', padLeft - 6, y0Db + 3);
  ctx.fillText('20dB', padLeft - 6, mapMagY(20) + 3);
  ctx.fillText('-40dB', padLeft - 6, mapMagY(-40) + 3);

  ctx.fillText('0°', padLeft - 6, mapPhaseY(0) + 3);
  ctx.fillText('-90°', padLeft - 6, mapPhaseY(-90) + 3);
  ctx.fillText('-180°', padLeft - 6, y180Deg + 3);

  // 2. 绘制幅频曲线 (陶土强调色)
  ctx.strokeStyle = magnitudeColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = mapX(pts[i].omega);
    const y = mapMagY(pts[i].mag_db);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 3. 绘制相频曲线 (温润琥珀色)
  ctx.strokeStyle = phaseColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = mapX(pts[i].omega);
    const y = mapPhaseY(pts[i].phase_deg);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 4. 剪切频率 ωc 与相位裕度 γ 高亮竖线
  const wc = bodeResult.value.omega_c;
  const pm = bodeResult.value.phase_margin;
  if (wc !== null && wc >= pts[0].omega && wc <= pts[pts.length - 1].omega) {
    const xWc = mapX(wc);
    ctx.strokeStyle = marginColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xWc, magY0);
    ctx.lineTo(xWc, magY0 + plotH);
    ctx.moveTo(xWc, phaseY0);
    ctx.lineTo(xWc, phaseY0 + plotH);
    ctx.stroke();

    // 标出 ωc 锚点
    ctx.fillStyle = marginColor;
    ctx.beginPath();
    ctx.arc(xWc, y0Db, 4, 0, Math.PI * 2);
    ctx.fill();

    // 相位裕度标注线
    if (pm !== null) {
      const yPhaseWc = mapPhaseY(-180 + pm);
      ctx.strokeStyle = marginColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xWc, y180Deg);
      ctx.lineTo(xWc, yPhaseWc);
      ctx.stroke();

      ctx.fillStyle = marginColor;
      ctx.textAlign = 'left';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`γ = ${pm.toFixed(1)}°`, xWc + 6, (y180Deg + yPhaseWc) / 2 + 4);
    }
  }
}

watch([bodeResult, curKp, curKi, curKd], () => {
  nextTick(drawBode);
});

onMounted(() => {
  themeObserver = new MutationObserver(() => nextTick(drawBode));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  if (bodeCanvasRef.value) {
    sizeObserver = new ResizeObserver(drawBode);
    sizeObserver.observe(bodeCanvasRef.value);
  }
  nextTick(() => {
    drawBode();
  });
});
onUnmounted(() => { themeObserver?.disconnect(); sizeObserver?.disconnect(); });
</script>

<template>
  <div class="bode-plot-viewer">
    <!-- 顶部状态栏与指标卡片 -->
    <div class="bode-top-bar">
      <div class="bode-badges">
        <span class="badge-item" :class="plantSource === 'example' ? 'badge-warn' : 'badge-good'" role="status">
          {{ plantSourceLabel }}
        </span>
        <button type="button" class="badge-item badge-plant" @click="togglePlantEditor" title="点击展开/收起模型参数调整">
          对象: <strong>{{ localPlant.family.toUpperCase() }}</strong>
          ({{ plantSummary }}, τ={{ Number.isFinite(localPlant.tau) ? `${localPlant.tau}s` : '待提供' }})
        </button>
        <span
          class="badge-item"
          :class="bodeResult.phase_margin !== null && bodeResult.phase_margin >= 45 ? 'badge-good' : 'badge-warn'"
        >
          相位裕度 γ: <strong>{{ bodeResult.phase_margin !== null ? `${bodeResult.phase_margin.toFixed(1)}°` : '--' }}</strong>
        </span>
        <span class="badge-item badge-wc">
          剪切频率 ωc: <strong>{{ bodeResult.omega_c !== null ? `${bodeResult.omega_c.toFixed(2)} rad/s` : '--' }}</strong>
        </span>
        <span class="badge-item badge-gm">
          幅值裕度 GM: <strong>{{ bodeResult.gain_margin_db !== null ? `${bodeResult.gain_margin_db} dB` : '未知' }}</strong>
        </span>
      </div>

      <div class="bode-actions-group">
        <button type="button" class="btn-tool-ghost" @click="emit('trigger-identify')" title="从 ChannelStore 历史波形中自动辨识模型参数">
          实测辨识
        </button>
        <button type="button" class="btn-tool-ghost" @click="togglePlantEditor" title="修改物理对象模型参数">
          设定对象
        </button>
        <button type="button" class="btn-tool-ghost" @click="handleRecommend" title="依据采样率与物理滞后推荐科学剪切频率与裕度">
          推荐目标
        </button>
      </div>
    </div>

    <!-- 被控对象现场调测条 -->
    <div v-if="showPlantEdit" class="plant-edit-panel">
      <div class="plant-edit-row">
        <label>模型:</label>
        <select :value="localPlant.family" aria-label="对象模型类型" class="tuner-select" @change="changePlantFamily">
          <option value="fopdt">FOPDT (一阶惯性滞后)</option>
          <option value="sopdt">SOPDT (二阶震荡)</option>
          <option value="integral_lag">积分+惯性 (位置/无自衡)</option>
          <option value="transfer_function">自定义 G(s) 系数</option>
        </select>
        <template v-if="localPlant.family === 'transfer_function'">
          <label>分子（s 降幂）<input :value="numeratorDraft" class="tuner-coefficients" @input="changeCoefficients('numerator', $event)" /></label>
          <label>分母（s 降幂）<input :value="denominatorDraft" class="tuner-coefficients" @input="changeCoefficients('denominator', $event)" /></label>
        </template>
        <template v-else>
          <label>增益 K:</label>
          <input type="number" step="0.1" v-model.number="localPlant.k" class="tuner-input-sm" @input="onPlantChange" />
        </template>
        <template v-if="localPlant.family === 'sopdt'">
          <label>ωn:</label>
          <input type="number" step="0.5" v-model.number="(localPlant as any).wn" class="tuner-input-sm" @input="onPlantChange" />
          <label>ζ:</label>
          <input type="number" step="0.05" v-model.number="(localPlant as any).zeta" class="tuner-input-sm" @input="onPlantChange" />
        </template>
        <template v-else-if="localPlant.family !== 'transfer_function'">
          <label>T(s):</label>
          <input type="number" step="0.01" v-model.number="(localPlant as any).t" class="tuner-input-sm" @input="onPlantChange" />
        </template>
        <label>τ(s):</label>
        <input type="number" step="0.005" v-model.number="localPlant.tau" aria-label="对象纯延迟 · 秒" class="tuner-input-sm" @input="onPlantChange" />
      </div>
    </div>

    <!-- 主波特图画布与侧边控制器面板 -->
    <div class="bode-content-grid">
      <!-- 左侧 Canvas 曲线区 -->
      <div class="bode-canvas-wrap">
        <canvas ref="bodeCanvasRef" width="460" height="240" class="bode-canvas"></canvas>
        <div class="bode-legend">
          <span class="legend-item"><i class="dot dot-mag"></i> 幅频 (dB)</span>
          <span class="legend-item"><i class="dot dot-phase"></i> 相频 (°)</span>
          <span class="legend-item"><i class="dot dot-wc"></i> 剪切点 ωc</span>
          <span class="legend-item"><i class="dot dot-delay"></i> 包含 -1.5ωTs 采样延时</span>
        </div>
      </div>

      <!-- 右侧频域解算与参数调控区 -->
      <div class="bode-tuner-panel">
        <div class="tuner-title">频域参数计算</div>

        <div class="tuner-form">
          <div class="form-row">
            <label>目标 ωc* (rad/s)</label>
            <input type="number" step="0.5" min="0.1" max="300" v-model.number="targetWc" aria-label="目标剪切频率 · rad/s" class="tuner-input font-mono" />
          </div>

          <div class="form-row">
            <label>期望裕度 γ* (°)</label>
            <input type="number" step="1" min="30" max="85" v-model.number="targetPm" aria-label="期望相位裕度 · 度" class="tuner-input font-mono" />
          </div>

          <div class="form-row">
            <label>控制器结构</label>
            <select v-model="structure" class="tuner-select font-mono">
              <option value="PI">PI (速度/电流内环推荐)</option>
              <option value="PID">完整 PID (支持第三约束)</option>
              <option value="PD">PD (姿态与平衡环)</option>
              <option value="P">纯 P (位置外环)</option>
            </select>
          </div>

          <div v-if="structure === 'PID'" class="form-row">
            <label>第三约束类型</label>
            <select v-model="pidConstraintType" class="tuner-select font-mono">
              <option value="ratio">工程默认 (Td = Ti / 4)</option>
              <option value="corner">指定微分转折频率 ωd</option>
            </select>
          </div>

          <div v-if="structure === 'PID' && pidConstraintType === 'corner'" class="form-row">
            <label>转折频率 ωd (rad/s)</label>
            <input type="number" step="1" min="0.1" v-model.number="targetWd" class="tuner-input font-mono" />
          </div>

          <button type="button" class="btn-solve-pid" @click="handleSolve">
            ⚡ 频域闭式求解 PID
          </button>
        </div>

        <!-- 解算结果状态 -->
        <div v-if="solveMsg" class="solve-msg-banner" :class="solveSuccess ? 'msg-success' : 'msg-error'">
          {{ solveMsg }}
        </div>

        <!-- 当前参数输出与动作 -->
        <div class="params-output-box font-mono">
          <div class="params-source-note">{{ controllerSourceLabel }}</div>
          <div class="param-line">Kp = <strong>{{ hasControllerBaseline || solvedPid ? curKp.toFixed(4) : '—' }}</strong></div>
          <div class="param-line">Ki = <strong>{{ hasControllerBaseline || solvedPid ? curKi.toFixed(4) : '—' }}</strong></div>
          <div class="param-line" :class="{ 'kd-cut': curKd === 0 }">
            Kd = <strong>{{ hasControllerBaseline || solvedPid ? curKd.toFixed(4) : '—' }}</strong> {{ curKd === 0 && (hasControllerBaseline || solvedPid) ? '(结构裁剪)' : '' }}
          </div>
        </div>

        <div class="action-buttons-row">
          <button type="button" class="btn-fill" :disabled="!canUseSolvedPid" @click="handleApply" title="仅已辨识或手动模型且本次解算成功后可填入发送区">
            📥 填入发送区
          </button>
          <button type="button" class="btn-save" :disabled="!canUseSolvedPid" @click="handleSaveQuick" title="仅已辨识或手动模型且本次解算成功后可暂存">
            ⭐ 暂存指令
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bode-plot-viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  padding: 6px 10px;
  background: var(--bg-surface, #272623);
  color: var(--text-main, #E8E6DF);
  overflow-y: auto;
}

.bode-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.bode-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.badge-item {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
}

.badge-plant {
  color: var(--accent-terracotta, #DA7756);
  border-color: rgba(218, 119, 86, 0.3);
}

.badge-good {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(52, 211, 153, 0.1);
}

.badge-warn {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.3);
  background: rgba(251, 191, 36, 0.1);
}

.badge-wc {
  color: var(--accent-terracotta, #DA7756);
}

.badge-gm {
  color: #c084fc;
}

.btn-tool-ghost {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #E8E6DF);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-tool-ghost:hover {
  background: var(--accent-terracotta, #DA7756);
  color: #fff;
}

.bode-content-grid {
  display: grid;
  grid-template-columns: 1fr 240px;
  gap: 10px;
  align-items: start;
}

@media (max-width: 720px) {
  .bode-content-grid {
    grid-template-columns: 1fr;
  }
}

.bode-canvas-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 6px;
}

.bode-canvas {
  width: 100%;
  height: 220px;
  display: block;
  border-radius: 4px;
}

.bode-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  padding: 0 4px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
}

.dot-mag {
  background: var(--accent-terracotta, #DA7756);
}

.dot-phase {
  background: #E59E38;
}

.dot-wc {
  background: #10b981;
}

.dot-delay {
  background: #ef4444;
}

.bode-tuner-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 10px;
}

.tuner-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-terracotta, #DA7756);
  border-bottom: 1px solid var(--border-subtle, #383633);
  padding-bottom: 4px;
}

.tuner-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.form-row label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.tuner-input,
.tuner-select {
  width: 95px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #E8E6DF);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.btn-solve-pid {
  margin-top: 4px;
  background: var(--accent-terracotta, #DA7756);
  color: #fff;
  border: none;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.15s ease;
}

.btn-solve-pid:hover {
  background: var(--accent-terracotta-hover, #E58565);
}

.solve-msg-banner {
  font-size: 10px;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1.3;
}

.msg-success {
  background: rgba(16, 185, 129, 0.12);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.msg-error {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.params-output-box {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.params-source-note {
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  margin-bottom: 2px;
}

.kd-cut {
  color: var(--text-muted, #9E9C94);
}

.action-buttons-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.btn-fill {
  background: rgba(16, 185, 129, 0.18);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #34d399;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-fill:hover {
  background: rgba(16, 185, 129, 0.3);
  color: #fff;
}

.btn-fill:disabled,
.btn-save:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-save {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-save:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-main, #E8E6DF);
}

.plant-edit-panel {
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 6px 10px;
}

.plant-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  flex-wrap: wrap;
}

.plant-edit-row label {
  color: var(--text-muted, #9E9C94);
}

.tuner-input-sm {
  width: 60px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #E8E6DF);
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 11px;
  font-family: monospace;
}
.tuner-coefficients { width:140px; font:12px var(--font-mono); min-height:32px; padding:5px 8px; background:var(--bg-surface); color:var(--text-main); border:1px solid var(--border-strong); border-radius:5px; }
.badge-good,.msg-success,.btn-fill { color:var(--accent-emerald); border-color:color-mix(in srgb,var(--accent-emerald) 40%,var(--border-subtle)); background:color-mix(in srgb,var(--accent-emerald) 8%,var(--bg-surface)); }
.badge-warn { color:var(--accent-amber); border-color:color-mix(in srgb,var(--accent-amber) 40%,var(--border-subtle)); background:color-mix(in srgb,var(--accent-amber) 8%,var(--bg-surface)); }
.badge-gm { color:var(--accent-indigo); }
.msg-error { color:var(--accent-rose); border-color:color-mix(in srgb,var(--accent-rose) 40%,var(--border-subtle)); background:color-mix(in srgb,var(--accent-rose) 8%,var(--bg-surface)); }
.dot-phase { background:var(--accent-amber); }.dot-wc { background:var(--accent-emerald); }.dot-delay { background:var(--accent-rose); }
.btn-tool-ghost,.btn-solve-pid,.btn-save,.btn-fill,.tuner-input,.tuner-input-sm,.tuner-select { min-height:32px; font-size:12px; }
.btn-solve-pid { background:var(--accent-action); }
.form-row label,.tuner-title,.plant-edit-row,.params-output-box,.badge-item { font-size:12px; }
.solve-msg-banner,.params-source-note { font-size:12px; line-height:1.5; }
.bode-legend { flex-wrap:wrap; font-size:11px; }
</style>
