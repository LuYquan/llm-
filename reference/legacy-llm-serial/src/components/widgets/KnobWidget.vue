<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { KnobConfig } from '../../types/widget';
import { formatPrecision, checkAndSanitizeNumeric } from '../../core/widget/safetyGuard';
import { globalSendGate } from '../../core/widget/sendGate';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';

const props = defineProps<{
  config: KnobConfig;
  title: string;
  locked: boolean;
  isConnected: boolean;
  w: number;
  h: number;
  widgetId?: string;
}>();

const localValue = ref<number>(props.config.default_value ?? 0);
const isDragging = ref(false);
const status = ref<'idle' | 'sending' | 'ok' | 'error'>('idle');
const feedbackMsg = ref('');
let feedbackTimer: number | null = null;
let throttleTimer: number | null = null;
let lastSentTime = 0;

// VOFA+ 闭环反馈通道读数
const feedbackVal = ref<number | null>(null);
const knobRenderId = `knob_fb_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function updateFeedback() {
  if (!props.config.feedback_channel) {
    if (feedbackVal.value !== null) feedbackVal.value = null;
    return;
  }
  const pt = globalChannelStore.latest(props.config.feedback_channel);
  feedbackVal.value = pt ? pt.v : null;
}

onMounted(() => {
  globalRenderScheduler.register(knobRenderId, updateFeedback, { fpsLimit: 25 });
});

onUnmounted(() => {
  globalRenderScheduler.unregister(knobRenderId);
});

const minVal = computed(() => props.config.min ?? 0);
const maxVal = computed(() => props.config.max ?? 100);
const stepVal = computed(() => props.config.step ?? 1);
const precisionVal = computed(() => props.config.precision ?? 0);
const unit = computed(() => props.config.unit || '');

const START_ANGLE = -135;
const TOTAL_SWEEP = 270;

const currentAngle = computed(() => {
  const min = minVal.value;
  const max = maxVal.value;
  if (max <= min) return START_ANGLE;
  const clamped = Math.max(min, Math.min(max, localValue.value));
  const ratio = (clamped - min) / (max - min);
  return START_ANGLE + ratio * TOTAL_SWEEP;
});

const displayValue = computed(() => {
  return formatPrecision(localValue.value, precisionVal.value);
});

// 随外壳 w, h 自适应缩放旋钮盘面
const dialSize = computed(() => Math.max(70, Math.min(props.w - 40, props.h - 60, 240)));

watch(
  () => props.config.default_value,
  (val) => {
    if (typeof val === 'number') {
      localValue.value = val;
    }
  }
);

function showFeedback(type: 'ok' | 'error', msg: string) {
  status.value = type;
  feedbackMsg.value = msg;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    status.value = 'idle';
    feedbackMsg.value = '';
  }, 2000);
}

async function doDispatch(val: number) {
  if (props.config.enabled === false || !props.config.command_template?.trim()) {
    showFeedback('error', '控件尚未绑定设备指令，请先配置模板并启用。');
    return;
  }
  if (!props.locked) {
    showFeedback('error', '编辑态禁止下发');
    return;
  }
  if (!props.isConnected) {
    showFeedback('error', '串口未连接');
    return;
  }

  status.value = 'sending';
  const result = await globalSendGate.dispatch(
    {
      id: props.widgetId || 'knob_send',
      type: 'knob',
      title: props.title,
      command_template: props.config.command_template,
      encoding: props.config.encoding || 'text',
      min: minVal.value,
      max: maxVal.value,
      step: stepVal.value,
      precision: precisionVal.value,
    } as any,
    '',
    val
  );

  if (result.ok) {
    showFeedback('ok', '已下发');
  } else {
    showFeedback('error', result.message || '下发失败');
  }
}

let startY = 0;
let startVal = 0;

function onKnobPointerDown(e: PointerEvent) {
  if (!props.locked) return; // 编辑态不响应旋钮
  isDragging.value = true;
  startY = e.clientY;
  startVal = localValue.value;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onKnobPointerMove(e: PointerEvent) {
  if (!isDragging.value) return;

  const dy = startY - e.clientY; // 向上拖拽增大，向下拖拽减小
  const span = maxVal.value - minVal.value;
  const delta = (dy / 150) * span; // 150px 扫掠整个量程
  let next = startVal + delta;

  // 吸附步长
  if (stepVal.value > 0) {
    next = Math.round((next - minVal.value) / stepVal.value) * stepVal.value + minVal.value;
  }
  next = Math.max(minVal.value, Math.min(maxVal.value, next));
  localValue.value = Number(next.toFixed(precisionVal.value));

  if (props.config.send_mode === 'input') {
    const throttleMs = props.config.throttle_ms || 50;
    const now = Date.now();
    if (now - lastSentTime >= throttleMs) {
      lastSentTime = now;
      doDispatch(localValue.value);
    } else {
      if (throttleTimer) clearTimeout(throttleTimer);
      throttleTimer = window.setTimeout(() => {
        lastSentTime = Date.now();
        doDispatch(localValue.value);
      }, throttleMs);
    }
  }
}

function onKnobPointerUp(e: PointerEvent) {
  if (!isDragging.value) return;
  isDragging.value = false;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {}

  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  doDispatch(localValue.value);
}

// 双击就地微调
const isEditingDirect = ref(false);
const editText = ref('');

function startDirectEdit() {
  if (!props.locked) return;
  editText.value = displayValue.value;
  isEditingDirect.value = true;
}

function commitDirectEdit() {
  if (!isEditingDirect.value) return;
  isEditingDirect.value = false;
  const parsed = parseFloat(editText.value);
  const check = checkAndSanitizeNumeric(parsed, {
    min: minVal.value,
    max: maxVal.value,
    step: stepVal.value,
    precision: precisionVal.value,
  });
  if (check.ok) {
    localValue.value = check.value;
    doDispatch(check.value);
  } else {
    showFeedback('error', check.message || '数值不合规');
  }
}
</script>

<template>
  <div class="knob-widget-root" :class="{ 'is-locked-out': !locked }">
    <!-- 旋钮本体区域 -->
    <div
      class="knob-dial-wrap"
      :style="{ width: `${dialSize}px`, height: `${dialSize}px` }"
      @pointerdown="onKnobPointerDown"
      @pointermove="onKnobPointerMove"
      @pointerup="onKnobPointerUp"
      @pointercancel="onKnobPointerUp"
    >
      <svg class="knob-arc-svg" viewBox="0 0 100 100">
        <!-- 外圈底弧 -->
        <path
          d="M 21.7 78.3 A 40 40 0 1 1 78.3 78.3"
          fill="none"
          stroke="var(--border-subtle, rgba(255, 255, 255, 0.12))"
          stroke-width="5"
          stroke-linecap="round"
        />
        <!-- 旋钮身体 -->
        <circle cx="50" cy="50" r="32" fill="var(--bg-elevated, #2F2E2A)" stroke="var(--border-subtle, #383633)" stroke-width="2" />
        <circle cx="50" cy="50" r="28" fill="var(--bg-surface, #272623)" />
        <!-- 刻度槽与指示针 -->
        <g :transform="`rotate(${currentAngle} 50 50)`">
          <line x1="50" y1="24" x2="50" y2="34" stroke="var(--accent-terracotta, #DA7756)" stroke-width="3" stroke-linecap="round" />
          <circle cx="50" cy="24" r="2" fill="var(--accent-terracotta, #DA7756)" />
        </g>
      </svg>
    </div>

    <!-- 底部数值与反馈 -->
    <div class="knob-footer">
      <div class="val-display" @dblclick.stop="startDirectEdit" title="双击输入精确数值">
        <input
          v-if="isEditingDirect"
          type="text"
          class="direct-input"
          v-model="editText"
          @blur="commitDirectEdit"
          @keydown.enter="commitDirectEdit"
          @keydown.esc="isEditingDirect = false"
          autofocus
        />
        <span v-else class="num-str font-mono">{{ displayValue }}</span>
        <span v-if="unit" class="unit-str">{{ unit }}</span>
      </div>

      <!-- VOFA+ 闭环反馈通道读数 -->
      <div v-if="config.feedback_channel" class="feedback-channel-pill" :title="`反馈通道 [${config.feedback_channel}]`">
        <span class="fb-label">FB:</span>
        <span class="fb-val font-mono">{{ feedbackVal !== null ? feedbackVal.toFixed(precisionVal) : '--' }}</span>
      </div>

      <span v-if="feedbackMsg" class="feedback-pill" :class="`badge-${status}`">
        {{ feedbackMsg }}
      </span>
      <span v-else-if="!config.feedback_channel" class="range-sub font-mono">
        [{{ minVal }} ~ {{ maxVal }}]
      </span>
    </div>
  </div>
</template>

<style scoped>
.knob-widget-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px;
  box-sizing: border-box;
  background: #090e17;
  border-radius: 4px;
  user-select: none;
}

.knob-widget-root.is-locked-out {
  opacity: 0.85;
}

.knob-dial-wrap {
  width: 90px;
  height: 90px;
  cursor: grab;
  touch-action: none;
}

.knob-dial-wrap:active {
  cursor: grabbing;
}

.knob-arc-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.knob-footer {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.val-display {
  display: flex;
  align-items: baseline;
  gap: 3px;
  cursor: pointer;
}

.num-str {
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-terracotta, #DA7756);
}

.unit-str {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.direct-input {
  width: 60px;
  height: 22px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: var(--text-main, #ECEAE4);
  font-family: monospace;
  font-size: 13px;
  text-align: center;
  border-radius: 3px;
  outline: none;
}

.range-sub {
  font-size: 9px;
  color: #64748b;
}

.feedback-channel-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.35);
  border-radius: 3px;
  font-size: 10px;
}

.fb-label {
  color: #22c55e;
  font-weight: 700;
}

.fb-val {
  color: #86efac;
}

.feedback-pill {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 3px;
}

.badge-ok {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.badge-error {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.badge-sending {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.2));
  color: var(--accent-terracotta, #DA7756);
}
</style>
