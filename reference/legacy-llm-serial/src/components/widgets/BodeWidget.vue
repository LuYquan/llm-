<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import type { BodeConfig } from '../../types/widget';
import { globalProjectModel } from '../../core/project/ProjectModel';
import type { ControlLoop } from '../../core/project/types';
import type { PlantModel, BodeResult } from '../../core/control/types';
import { computeBode } from '../../core/control/computeBode';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';

const props = defineProps<{
  config: BodeConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const currentLoop = ref<ControlLoop | null>(null);
const bodeResult = ref<BodeResult | null>(null);

const widgetUniqueId = `bode_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

// 获取当前绑定的环路配置
function resolveLoop(): ControlLoop | undefined {
  if (props.config.loop_id) {
    const found = globalProjectModel.getLoop(props.config.loop_id);
    if (found) return found;
  }
  return globalProjectModel.getActiveLoop() || globalProjectModel.getLoops()[0];
}

// 只有有效辨识结果才允许计算波特图。plant_family 只是候选族，不能推导出
// 增益、时间常数或延迟；因此不会用示例模型或“第一个可用环路”填充指标。
function resolvePlantModel(loop: ControlLoop): PlantModel | null {
  if (loop.state === 'untuned' || !loop.identified_model) return null;
  return loop.identified_model;
}

// 重新解算波特图
function updateBode() {
  const loop = resolveLoop();
  if (!loop) return;
  currentLoop.value = loop;

  const plant = resolvePlantModel(loop);
  const p = loop.current_params;
  if (!plant || !p) {
    bodeResult.value = null;
    nextTick(() => drawBodeCanvas());
    return;
  }
  const ts = loop.sample_period_s || loop.sample_time || 0.001;

  const res = computeBode(
    plant,
    {
      kp: p.kp,
      ki: p.ki,
      kd: p.kd,
    },
    {
      sampleTime: ts,
      omegaMin: props.config.omega_min ?? 0.1,
      omegaMax: props.config.omega_max ?? 1000,
      pointsCount: 160,
    }
  );

  bodeResult.value = res;
  nextTick(() => {
    drawBodeCanvas();
  });
}

// HTML5 Canvas 绘制高保真幅频与相频曲线
function drawBodeCanvas() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(200, rect.width);
  const height = Math.max(120, rect.height);

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  // 1. 背景底色
  const isLight = document.documentElement.classList.contains('light');
  ctx.fillStyle = isLight ? '#FAF9F5' : '#1F1E1D';
  ctx.fillRect(0, 0, width, height);

  if (!bodeResult.value) {
    ctx.fillStyle = isLight ? '#706E66' : '#9E9C94';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无有效对象模型；请先完成并确认一次辨识', width / 2, height / 2 - 8);
    ctx.fillStyle = isLight ? '#9E9C94' : '#706E66';
    ctx.font = '10px sans-serif';
    ctx.fillText('plant_family 与示例参数不会被当作实测证据', width / 2, height / 2 + 14);
    return;
  }

  const padLeft = 46;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 22;
  const midGap = 12;

  const plotW = width - padLeft - padRight;
  const halfH = (height - padTop - padBottom - midGap) / 2;

  if (plotW <= 20 || halfH <= 20) return;

  const pts = bodeResult.value.curve;
  if (!pts || pts.length < 2) return;

  const minW = pts[0].omega;
  const maxW = pts[pts.length - 1].omega;
  const logMin = Math.log10(minW);
  const logMax = Math.log10(maxW);

  function xFromOmega(w: number): number {
    const lw = Math.log10(Math.max(1e-5, w));
    return padLeft + ((lw - logMin) / (logMax - logMin)) * plotW;
  }

  // 幅值范围: 固定 [-60dB, +40dB]
  const magMin = -60;
  const magMax = 40;
  function yFromMag(mag: number): number {
    const clamped = Math.max(magMin, Math.min(magMax, mag));
    return padTop + halfH - ((clamped - magMin) / (magMax - magMin)) * halfH;
  }

  // 相位范围: 固定 [-270°, 0°]
  const phaseMin = -270;
  const phaseMax = 0;
  const phaseTop = padTop + halfH + midGap;
  function yFromPhase(deg: number): number {
    const clamped = Math.max(phaseMin, Math.min(phaseMax, deg));
    return phaseTop + halfH - ((clamped - phaseMin) / (phaseMax - phaseMin)) * halfH;
  }

  // 2. 绘制网格与刻度
  ctx.lineWidth = 1;

  // 频域垂直对数网格
  for (let dec = Math.ceil(logMin); dec <= Math.floor(logMax); dec++) {
    const wDec = Math.pow(10, dec);
    const x = xFromOmega(wDec);
    ctx.strokeStyle = isLight ? '#E8E6DF' : '#2F2E2A';
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, height - padBottom);
    ctx.stroke();

    // 刻度文本
    ctx.fillStyle = isLight ? '#9E9C94' : '#706E66';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${wDec >= 1 ? wDec : wDec.toFixed(1)}`, x, height - 8);
  }

  // 幅频 0 dB 基准线 (高亮黄色虚线)
  const y0db = yFromMag(0);
  ctx.strokeStyle = '#eab308';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, y0db);
  ctx.lineTo(padLeft + plotW, y0db);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#eab308';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('0dB', padLeft - 6, y0db + 3);

  // 相频 -180° 基准线 (红色虚线)
  const y180deg = yFromPhase(-180);
  ctx.strokeStyle = '#ef4444';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padLeft, y180deg);
  ctx.lineTo(padLeft + plotW, y180deg);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ef4444';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('-180°', padLeft - 6, y180deg + 3);

  // 3. 绘制开环幅频对数曲线 (Claude 陶土红 #DA7756)
  ctx.strokeStyle = '#DA7756';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = xFromOmega(pts[i].omega);
    const y = yFromMag(pts[i].mag_db);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 4. 绘制开环相频曲线 (Claude 鼠尾草绿 #7AA89B)
  ctx.strokeStyle = '#7AA89B';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = xFromOmega(pts[i].omega);
    const y = yFromPhase(pts[i].phase_deg);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 5. 若启用延时损失，绘制 ZOH 延时相角损失曲线 (虚线 #f43f5e)
  if (props.config.show_delay_loss !== false) {
    ctx.strokeStyle = '#f43f5e';
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = xFromOmega(pts[i].omega);
      const y = yFromPhase(pts[i].phase_deg - pts[i].delay_phase_deg); // 扣除延时后的相角
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 6. 标注剪切频率 ωc 与相位裕度 γ
  const wc = bodeResult.value.omega_c;
  const pm = bodeResult.value.phase_margin;
  if (wc !== null && pm !== null && wc >= minW && wc <= maxW) {
    const xWc = xFromOmega(wc);
    // 垂线指示
    ctx.strokeStyle = '#a855f7';
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(xWc, padTop);
    ctx.lineTo(xWc, height - padBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // 0dB 点实心圆
    ctx.fillStyle = '#a855f7';
    ctx.beginPath();
    ctx.arc(xWc, y0db, 4, 0, Math.PI * 2);
    ctx.fill();

    // 标尺文字
    ctx.fillStyle = '#d8b4fe';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`ωc=${wc.toFixed(1)}r/s`, xWc + 4, padTop + 12);
  }
}

let unbindProject: (() => void) | null = null;

onMounted(() => {
  updateBode();

  // 监听全局项目拓扑与参数变化
  unbindProject = globalProjectModel.onModelChanged(() => {
    updateBode();
  });

  // 注册全局调度器 (2Hz 刷新，防止多 Tab 后台消耗)
  if (props.config.auto_refresh !== false) {
    globalRenderScheduler.register(widgetUniqueId, updateBode, {
      tabId: props.tabId,
      fpsLimit: 2,
    });
  }

  window.addEventListener('resize', drawBodeCanvas);
});

onUnmounted(() => {
  if (unbindProject) unbindProject();
  globalRenderScheduler.unregister(widgetUniqueId);
  window.removeEventListener('resize', drawBodeCanvas);
});

watch(
  () => [props.w, props.h, props.config],
  () => {
    updateBode();
  },
  { deep: true }
);
</script>

<template>
  <div class="bode-widget-container">
    <!-- 顶部状态栏: 环路名称、裕度指标与稳定性徽章 -->
    <div class="bode-widget-header">
      <div class="header-left">
        <span class="widget-icon">📉</span>
        <span class="loop-title">{{ currentLoop ? (currentLoop.name || currentLoop.id) : '波特图分析仪' }}</span>
        <span class="struct-badge" v-if="currentLoop">{{ currentLoop.structure }}</span>
      </div>

      <div class="header-right" v-if="bodeResult && config.show_stability_margins !== false">
        <span
          class="metric-pill"
          :class="{
            'pill-good': bodeResult.phase_margin !== null && bodeResult.phase_margin >= 45,
            'pill-warn': bodeResult.phase_margin !== null && bodeResult.phase_margin < 45 && bodeResult.phase_margin > 0,
            'pill-bad': bodeResult.phase_margin === null || bodeResult.phase_margin <= 0,
          }"
          title="开环相位裕度 γ = 180° + ∠L(jωc)"
        >
          γ = {{ bodeResult.phase_margin !== null ? `${bodeResult.phase_margin.toFixed(0)}°` : '--' }}
        </span>

        <span class="metric-pill pill-neutral" title="基于已确认对象模型的模型预测；仍需实测验证">
          模型预测
        </span>

        <span class="metric-pill pill-neutral" title="开环截止/剪切频率 ωc">
          ωc = {{ bodeResult.omega_c !== null ? `${bodeResult.omega_c.toFixed(1)}` : '--' }} r/s
        </span>

        <span
          class="stability-badge"
          :class="bodeResult.is_stable === null ? 'badge-unknown' : (bodeResult.is_stable ? 'badge-stable' : 'badge-unstable')"
        >
          {{ bodeResult.is_stable === null ? '⚪ 未知' : (bodeResult.is_stable ? '🟢 稳定' : '🔴 不稳定') }}
        </span>
      </div>
      <div v-else class="bode-unknown-badge" title="需要有效辨识模型和当前控制器参数">
        ⚪ 未知 · 等待有效模型
      </div>
    </div>

    <!-- 波特图 Canvas 绘制区 -->
    <div class="bode-canvas-wrapper">
      <canvas ref="canvasRef" class="bode-canvas"></canvas>
    </div>
  </div>
</template>

<style scoped>
.bode-widget-container {
  width: 100%;
  height: 100%;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.bode-widget-header {
  height: 32px;
  min-height: 32px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.widget-icon {
  font-size: 14px;
}

.loop-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.struct-badge {
  font-size: 10px;
  font-family: monospace;
  background: var(--bg-surface, #272623);
  color: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--border-subtle, #383633);
  padding: 1px 4px;
  border-radius: 3px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bode-unknown-badge {
  color: #f0c76f;
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid #695324;
  border-radius: 3px;
  background: rgba(105, 83, 36, 0.18);
}

.metric-pill {
  font-size: 11px;
  font-family: monospace;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
}

.pill-good {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.pill-warn {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.pill-bad {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.pill-neutral {
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
}

.stability-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}

.badge-stable {
  color: #4ade80;
}

.badge-unstable {
  color: #f87171;
}

.badge-unknown {
  color: var(--text-muted);
}

.bode-canvas-wrapper {
  flex: 1;
  width: 100%;
  height: calc(100% - 32px);
  position: relative;
  overflow: hidden;
}

.bode-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
