<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { GaugeConfig } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';
import { useWidgetStore } from '../../stores/widgetStore';

const props = defineProps<{
  config: GaugeConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const store = useWidgetStore();
const currentVal = ref<number | null>(null);
const smoothedAngle = ref<number>(0);

// 表盘参数
const minVal = computed(() => props.config.min ?? -1.0);
const maxVal = computed(() => props.config.max ?? 1.0);
const unit = computed(() => props.config.unit || '');
const precision = computed(() => props.config.precision ?? 2);
const redlineRatio = computed(() => Math.min(1, Math.max(0, props.config.redline_ratio ?? 0.8)));

// 仪表盘几何尺寸 (根据外壳 w, h 取正方形区域自适应)
const size = computed(() => Math.max(120, Math.min(props.w, props.h)));
const center = computed(() => size.value / 2);
const radius = computed(() => size.value * 0.42);

// 角度范围：扫掠 270 度 (-135° ~ +135°)
const START_ANGLE = -135;
const END_ANGLE = 135;
const TOTAL_SWEEP = 270;

// 将数值映射为角度 (-135° 到 +135°)
function valueToAngle(val: number): number {
  const min = minVal.value;
  const max = maxVal.value;
  if (max <= min) return START_ANGLE;
  const clamped = Math.max(min, Math.min(max, val));
  const ratio = (clamped - min) / (max - min);
  return START_ANGLE + ratio * TOTAL_SWEEP;
}

// 目标旋转角度
const targetAngle = computed(() => {
  if (currentVal.value === null) return START_ANGLE;
  return valueToAngle(currentVal.value);
});

// 生成刻度线集合
const ticks = computed(() => {
  const list: { angle: number; isMajor: boolean; label?: string; isRed: boolean }[] = [];
  const min = minVal.value;
  const max = maxVal.value;
  const count = 6; // 6个主刻度
  for (let i = 0; i <= count; i++) {
    const ratio = i / count;
    const angle = START_ANGLE + ratio * TOTAL_SWEEP;
    const val = min + ratio * (max - min);
    list.push({
      angle,
      isMajor: true,
      label: val.toFixed(precision.value === 0 ? 0 : 1),
      isRed: ratio >= redlineRatio.value && redlineRatio.value < 1,
    });
    // 副刻度
    if (i < count) {
      const subAngle = angle + (TOTAL_SWEEP / count) / 2;
      list.push({
        angle: subAngle,
        isMajor: false,
        isRed: (ratio + 0.5 / count) >= redlineRatio.value && redlineRatio.value < 1,
      });
    }
  }
  return list;
});

// 计算圆弧路径
function describeArc(x: number, y: number, r: number, startAngle: number, endAngle: number): string {
  const startRad = ((startAngle - 90) * Math.PI) / 180;
  const endRad = ((endAngle - 90) * Math.PI) / 180;
  const x1 = x + r * Math.cos(startRad);
  const y1 = y + r * Math.sin(startRad);
  const x2 = x + r * Math.cos(endRad);
  const y2 = y + r * Math.sin(endRad);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

const mainArcPath = computed(() => {
  return describeArc(center.value, center.value, radius.value, START_ANGLE, END_ANGLE);
});

const redArcPath = computed(() => {
  if (redlineRatio.value >= 1) return '';
  const redStartAngle = START_ANGLE + redlineRatio.value * TOTAL_SWEEP;
  return describeArc(center.value, center.value, radius.value, redStartAngle, END_ANGLE);
});

const activeArcPath = computed(() => {
  if (currentVal.value === null) return '';
  const clampedAngle = Math.max(START_ANGLE, Math.min(END_ANGLE, smoothedAngle.value));
  if (clampedAngle <= START_ANGLE + 0.5) return '';
  return describeArc(center.value, center.value, radius.value, START_ANGLE, clampedAngle);
});

let lastTime = performance.now();
let needleVelocity = 0; // 仪表盘指针角速度 (deg/s)
const ZETA = 0.85; // 阻尼比 (0.85 产生轻微机械回弹过冲与迅速稳定，高度还原真实物理动圈仪表)
const OMEGA = 18.0; // 固有角频率 (rad/s)
const gaugeId = `gauge_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function updateGaugeFrame(now: number) {
  const dtMs = Math.min(50, Math.max(1, now - lastTime));
  lastTime = now;
  const dt = dtMs / 1000; // 转换为秒

  // 从 ChannelStore 读取最新值并应用精细缩放与偏置
  if (props.config.channel) {
    const pt = globalChannelStore.latest(props.config.channel);
    if (pt) {
      const meta = store.getChannelMeta(props.config.channel);
      currentVal.value = pt.v * meta.scale + meta.yOffset;
    } else {
      currentVal.value = null;
    }
  } else {
    currentVal.value = null;
  }

  // 二阶弹簧-阻尼动力学系统 (2nd-Order Damped Harmonic Oscillator)
  const target = targetAngle.value;
  const error = target - smoothedAngle.value;

  // 加速度 a = w^2 * error - 2 * zeta * w * v
  const accel = (OMEGA * OMEGA) * error - 2 * ZETA * OMEGA * needleVelocity;
  needleVelocity += accel * dt;
  smoothedAngle.value += needleVelocity * dt;

  // 极微小振荡静态收敛，消除浮点抖动
  if (Math.abs(error) < 0.05 && Math.abs(needleVelocity) < 0.2) {
    smoothedAngle.value = target;
    needleVelocity = 0;
  }
}

onMounted(() => {
  lastTime = performance.now();
  smoothedAngle.value = START_ANGLE;
  needleVelocity = 0;
  globalRenderScheduler.register(gaugeId, updateGaugeFrame, {
    tabId: props.tabId,
    fpsLimit: 60,
  });
});

onUnmounted(() => {
  globalRenderScheduler.unregister(gaugeId);
});

const formattedReading = computed(() => {
  if (currentVal.value === null) return '--';
  return currentVal.value.toFixed(precision.value);
});

const isOutOfRange = computed(() => {
  if (currentVal.value === null) return false;
  return currentVal.value < minVal.value || currentVal.value > maxVal.value;
});
</script>

<template>
  <div class="gauge-container">
    <div
      class="gauge-box"
      :style="{ width: size + 'px', height: size + 'px' }"
    >
      <svg class="gauge-svg" :width="size" :height="size">
        <!-- 极简几何底环 (双圆弧之一) -->
        <path
          :d="mainArcPath"
          fill="none"
          stroke="var(--border-strong, #4A4843)"
          :stroke-width="size * 0.024"
          stroke-linecap="round"
        />

        <!-- 陶土色实时扫掠进度弧 (双圆弧之二) -->
        <path
          v-if="activeArcPath"
          :d="activeArcPath"
          fill="none"
          stroke="var(--accent-terracotta, #DA7756)"
          :stroke-width="size * 0.03"
          stroke-linecap="round"
        />

        <!-- 柔和危险红线警告弧段 -->
        <path
          v-if="redArcPath"
          :d="redArcPath"
          fill="none"
          stroke="#E06D85"
          :stroke-width="size * 0.03"
          stroke-linecap="round"
          opacity="0.7"
        />

        <!-- 刻度线与刻度值 -->
        <g :transform="`translate(${center}, ${center})`">
          <g
            v-for="(tick, idx) in ticks"
            :key="idx"
            :transform="`rotate(${tick.angle})`"
          >
            <!-- 极简微细刻度线 -->
            <line
              :x1="0"
              :y1="-radius + (tick.isMajor ? size * 0.016 : size * 0.008)"
              :x2="0"
              :y2="-radius - (tick.isMajor ? size * 0.032 : size * 0.016)"
              :stroke="tick.isRed ? '#E06D85' : (tick.isMajor ? 'var(--text-muted, #9E9C94)' : 'var(--text-soft, #706E66)')"
              :stroke-width="tick.isMajor ? 1.5 : 1"
            />
          </g>

          <!-- 刻度文字 -->
          <text
            v-for="(tick, idx) in ticks.filter(t => t.isMajor && t.label)"
            :key="'label-' + idx"
            :x="(radius - size * 0.1) * Math.sin(((tick.angle) * Math.PI) / 180)"
            :y="-(radius - size * 0.1) * Math.cos(((tick.angle) * Math.PI) / 180)"
            fill="var(--text-muted, #9E9C94)"
            :font-size="Math.max(9, size * 0.048)"
            text-anchor="middle"
            dominant-baseline="central"
            class="font-mono font-medium"
          >
            {{ tick.label }}
          </text>

          <!-- 纤细刀锋指针与陶土色中心轴承 -->
          <g :transform="`rotate(${smoothedAngle})`">
            <!-- 纤细刀锋指针 -->
            <polygon
              :points="`0,${size * 0.03} -${Math.max(1.2, size * 0.008)},0 0,-${radius * 0.94} ${Math.max(1.2, size * 0.008)},0`"
              fill="var(--text-main, #ECEAE4)"
              class="needle-polygon"
            />
            <!-- 中心轴承外圈 -->
            <circle
              cx="0"
              cy="0"
              :r="size * 0.04"
              fill="var(--bg-surface, #272623)"
              stroke="var(--accent-terracotta, #DA7756)"
              stroke-width="1.8"
            />
            <!-- 中心轴承陶土色轴芯 -->
            <circle
              cx="0"
              cy="0"
              :r="size * 0.02"
              fill="var(--accent-terracotta, #DA7756)"
            />
          </g>
        </g>
      </svg>

      <!-- 底部实时读数与物理单位 -->
      <div
        class="reading-overlay"
        :style="{ bottom: size * 0.12 + 'px' }"
      >
        <span
          class="reading-value font-mono font-bold"
          :class="{ 'text-danger': isOutOfRange }"
          :style="{ fontSize: Math.max(14, size * 0.11) + 'px' }"
        >
          {{ formattedReading }}
        </span>
        <span
          v-if="unit"
          class="reading-unit font-mono"
          :style="{ fontSize: Math.max(10, size * 0.055) + 'px' }"
        >
          {{ unit }}
        </span>
      </div>

      <!-- 通道标签 -->
      <div class="channel-tag">
        <span class="dot"></span>
        <span class="name">{{ config.channel || '未绑定通道' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gauge-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: transparent;
  position: relative;
  overflow: hidden;
}

.gauge-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gauge-svg {
  display: block;
}

.needle-polygon {
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.4));
}

.reading-overlay {
  position: absolute;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
  width: 100%;
  pointer-events: none;
}

.reading-value {
  color: var(--accent-terracotta, #DA7756);
  line-height: 1;
}

.reading-value.text-danger {
  color: #E06D85;
  animation: pulse-danger 1s infinite alternate;
}

.reading-unit {
  color: var(--text-muted, #9E9C94);
  font-weight: 500;
}

.channel-tag {
  position: absolute;
  top: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  background: var(--bg-elevated, #2F2E2A);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle, #383633);
}

.channel-tag .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background-color: var(--accent-terracotta, #DA7756);
}

@keyframes pulse-danger {
  from {
    transform: scale(1);
    opacity: 0.9;
  }
  to {
    transform: scale(1.08);
    opacity: 1;
  }
}
</style>
