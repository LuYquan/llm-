<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { SliderConfig } from '../../types/widget';
import { formatPrecision, checkAndSanitizeNumeric } from '../../core/widget/safetyGuard';
import { globalSendGate } from '../../core/widget/sendGate';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';

const props = defineProps<{
  config: SliderConfig;
  title: string;
  locked: boolean;
  isConnected: boolean;
  widgetId?: string;
}>();

// 内部交互数值
const localValue = ref<number>(props.config.default_value ?? 0);

// 就地双击修改
const isDirectEditing = ref(false);
const directEditText = ref('');

// 交互与反馈状态
const status = ref<'idle' | 'sending' | 'ok' | 'error'>('idle');
const feedbackMsg = ref('');
let feedbackTimer: number | null = null;

let throttleTimer: number | null = null;
let lastSentTime = 0;

// VOFA+ 闭环反馈通道读数
const feedbackVal = ref<number | null>(null);
const sliderRenderId = `slider_fb_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function updateFeedback() {
  if (!props.config.feedback_channel) {
    if (feedbackVal.value !== null) feedbackVal.value = null;
    return;
  }
  const pt = globalChannelStore.latest(props.config.feedback_channel);
  feedbackVal.value = pt ? pt.v : null;
}

onMounted(() => {
  globalRenderScheduler.register(sliderRenderId, updateFeedback, { fpsLimit: 25 });
});

onUnmounted(() => {
  globalRenderScheduler.unregister(sliderRenderId);
});

const displayValue = computed(() => {
  return formatPrecision(localValue.value, props.config.precision ?? 0);
});

// 监听配置变化
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
      id: props.widgetId || 'slider_send',
      type: 'slider',
      title: props.title,
      command_template: props.config.command_template,
      encoding: props.config.encoding || 'text',
      min: props.config.min,
      max: props.config.max,
      step: props.config.step,
      precision: props.config.precision,
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

// 连续滑动
function handleInput(e: Event) {
  const target = e.target as HTMLInputElement;
  const val = parseFloat(target.value);
  localValue.value = val;

  if (props.config.send_mode === 'input') {
    const throttleMs = props.config.throttle_ms || 50;
    const now = Date.now();
    if (now - lastSentTime >= throttleMs) {
      lastSentTime = now;
      doDispatch(val);
    } else {
      if (throttleTimer) clearTimeout(throttleTimer);
      throttleTimer = window.setTimeout(() => {
        lastSentTime = Date.now();
        doDispatch(localValue.value);
      }, throttleMs);
    }
  }
}

// 松手完成
function handleChange() {
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  doDispatch(localValue.value);
}

// 键盘方向键微调
function handleKeyDown(e: KeyboardEvent) {
  if (isDirectEditing.value) return;
  const step = e.shiftKey ? (props.config.step || 1) * 10 : (props.config.step || 1);

  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = Math.min(props.config.max, localValue.value + step);
    localValue.value = next;
    doDispatch(next);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.max(props.config.min, localValue.value - step);
    localValue.value = next;
    doDispatch(next);
  }
}

function startDirectEdit() {
  directEditText.value = displayValue.value;
  isDirectEditing.value = true;
}

function commitDirectEdit() {
  if (!isDirectEditing.value) return;
  isDirectEditing.value = false;
  const parsed = parseFloat(directEditText.value);
  const check = checkAndSanitizeNumeric(parsed, props.config as any);
  if (check.ok) {
    localValue.value = check.value;
    doDispatch(check.value);
  } else {
    showFeedback('error', check.message || '数值不合规');
  }
}

// VOFA+ 原生步进微调按钮 (支持 Shift 10倍步长)
function stepValue(direction: 1 | -1, e?: MouseEvent) {
  if (!props.locked) return;
  const baseStep = props.config.step || 1;
  const multiplier = e && e.shiftKey ? 10 : 1;
  const delta = direction * baseStep * multiplier;
  const next = Math.max(props.config.min, Math.min(props.config.max, localValue.value + delta));
  const prec = props.config.precision ?? 0;
  const sanitized = parseFloat(next.toFixed(prec));
  localValue.value = sanitized;
  doDispatch(sanitized);
}
</script>

<template>
  <div
    class="slider-widget-root"
    :class="{ 'is-locked-out': !locked }"
    tabindex="0"
    @keydown="handleKeyDown"
  >
    <!-- 顶部数值读数与单位 -->
    <div class="slider-header">
      <div class="value-display" @dblclick.stop="startDirectEdit" title="双击直接修改数值">
        <input
          v-if="isDirectEditing"
          type="text"
          class="direct-input"
          v-model="directEditText"
          @blur="commitDirectEdit"
          @keydown.enter="commitDirectEdit"
          @keydown.esc="isDirectEditing = false"
          autofocus
        />
        <span v-else class="num-text">{{ displayValue }}</span>
        <span class="unit-text" v-if="config.unit">{{ config.unit }}</span>
      </div>

      <!-- VOFA+ 闭环反馈通道读数 -->
      <div v-if="config.feedback_channel" class="feedback-channel-pill" :title="`反馈通道 [${config.feedback_channel}]`">
        <span class="fb-label">FB:</span>
        <span class="fb-val font-mono">{{ feedbackVal !== null ? feedbackVal.toFixed(config.precision ?? 1) : '--' }}</span>
      </div>

      <!-- 反馈指示 -->
      <span class="feedback-badge" v-if="feedbackMsg" :class="`badge-${status}`">
        {{ feedbackMsg }}
      </span>
    </div>

    <!-- 滑块导轨与两端微调按钮 (VOFA+ 原生交互) -->
    <div class="slider-track-wrap">
      <button
        type="button"
        class="step-btn"
        :disabled="!locked || localValue <= config.min"
        @click="stepValue(-1, $event)"
        title="单步递减 (Shift+点击为 10× 步长)"
      >
        −
      </button>
      <input
        type="range"
        class="vofa-range"
        :min="config.min"
        :max="config.max"
        :step="config.step"
        :value="localValue"
        :disabled="!locked"
        @input="handleInput"
        @change="handleChange"
        @pointerup="handleChange"
      />
      <button
        type="button"
        class="step-btn"
        :disabled="!locked || localValue >= config.max"
        @click="stepValue(1, $event)"
        title="单步递增 (Shift+点击为 10× 步长)"
      >
        +
      </button>
    </div>

    <!-- 两端极值提示 -->
    <div class="range-limits">
      <span>{{ config.min }}</span>
      <span class="mode-tag">{{ config.send_mode === 'input' ? '实时流' : '松手发' }}</span>
      <span>{{ config.max }}</span>
    </div>
  </div>
</template>

<style scoped>
.slider-widget-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  padding: 8px 12px;
  box-sizing: border-box;
  justify-content: center;
  gap: 4px;
  outline: none;
}

.slider-widget-root.is-locked-out {
  opacity: 0.65;
  cursor: not-allowed;
}

.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 24px;
}

.value-display {
  display: flex;
  align-items: baseline;
  gap: 4px;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  border: 1px solid var(--accent-terracotta-soft, rgba(218, 119, 86, 0.2));
  transition: all 0.15s ease;
}

.value-display:hover {
  border-color: var(--accent-terracotta, #DA7756);
}

.feedback-channel-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  background: rgba(122, 168, 155, 0.15);
  border: 1px solid rgba(122, 168, 155, 0.35);
  border-radius: 4px;
  font-size: 11px;
}

.fb-label {
  color: #7AA89B;
  font-weight: 700;
}

.fb-val {
  color: var(--text-main, #ECEAE4);
}

.num-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 15px;
  font-weight: 700;
  color: var(--accent-terracotta, #DA7756);
}

.unit-text {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.direct-input {
  width: 60px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: var(--text-main, #ECEAE4);
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 1px 4px;
  border-radius: 4px;
  outline: none;
}

.feedback-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
}

.badge-ok {
  background: rgba(122, 168, 155, 0.2);
  color: #7AA89B;
  border: 1px solid #7AA89B;
}

.badge-error {
  background: rgba(224, 109, 133, 0.2);
  color: #E06D85;
  border: 1px solid #E06D85;
}

.slider-track-wrap {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-btn {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  transition: all 0.12s ease;
  line-height: 1;
  padding: 0;
}

.step-btn:hover:not(:disabled) {
  background: var(--bg-surface, #272623);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

.step-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.step-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.vofa-range {
  flex: 1;
  width: 100%;
  height: 6px;
  -webkit-appearance: none;
  background: var(--border-strong, #4A4843);
  border-radius: 9999px;
  outline: none;
  cursor: pointer;
}

.vofa-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 20px;
  height: 14px;
  border-radius: 7px; /* 扁平圆角药丸状 */
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  transition: transform 0.12s ease, background-color 0.12s ease;
}

.vofa-range::-webkit-slider-thumb:hover {
  transform: scale(1.12);
  background: var(--accent-terracotta-hover, #E58565);
}

.range-limits {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  color: var(--text-soft, #706E66);
  font-family: 'JetBrains Mono', monospace;
}

.mode-tag {
  font-size: 9px;
  color: var(--text-muted, #9E9C94);
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
