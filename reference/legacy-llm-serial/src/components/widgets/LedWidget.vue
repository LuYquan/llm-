<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { LedConfig } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';
import { useWidgetStore } from '../../stores/widgetStore';

const props = defineProps<{
  config: LedConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const store = useWidgetStore();
const currentVal = ref<number | null>(null);
const ledId = `led_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function updateLed() {
  if (!props.config.channel) {
    if (currentVal.value !== null) currentVal.value = null;
    return;
  }
  const pt = globalChannelStore.latest(props.config.channel);
  if (pt) {
    const meta = store.getChannelMeta(props.config.channel);
    currentVal.value = pt.v * meta.scale + meta.yOffset;
  } else {
    currentVal.value = null;
  }
}

onMounted(() => {
  globalRenderScheduler.register(ledId, updateLed, {
    tabId: props.tabId,
    fpsLimit: 30,
  });
});

onUnmounted(() => {
  globalRenderScheduler.unregister(ledId);
});

const ledState = computed<'normal' | 'warn' | 'alarm' | 'off'>(() => {
  if (currentVal.value === null) return 'off';
  const v = currentVal.value;

  if (props.config.condition_mode === 'three_zone') {
    const alarmThresh = props.config.threshold ?? 100;
    const warnThresh = props.config.warning_threshold ?? 80;
    if (v >= alarmThresh) return 'alarm';
    if (v >= warnThresh) return 'warn';
    return 'normal';
  }

  // 默认二态判定
  switch (props.config.active_condition) {
    case 'non_zero':
      return Math.abs(v) > 1e-6 ? 'normal' : 'off';
    case 'positive':
      return v > 1e-6 ? 'normal' : 'off';
    case 'threshold':
      return v >= (props.config.threshold ?? 0) ? 'normal' : 'off';
    default:
      return Boolean(v) ? 'normal' : 'off';
  }
});

const isLit = computed(() => ledState.value !== 'off');

const currentColor = computed(() => {
  const isLightMode = document.documentElement.classList.contains('light');
  switch (ledState.value) {
    case 'alarm':
      return '#ef4444';
    case 'warn':
      return props.config.color_warn || '#eab308';
    case 'normal':
      return props.config.color_on || '#22c55e';
    case 'off':
    default:
      return props.config.color_off || (isLightMode ? '#E8E6DF' : '#383633');
  }
});

const stateText = computed(() => {
  switch (ledState.value) {
    case 'alarm':
      return 'ALARM (报警)';
    case 'warn':
      return 'WARN (预警)';
    case 'normal':
      return props.config.condition_mode === 'three_zone' ? 'NORMAL (正常)' : 'ON (激活)';
    case 'off':
    default:
      return 'OFF (待机)';
  }
});
</script>

<template>
  <div class="led-widget-container">
    <div class="led-center-body">
      <!-- LED 光珠 -->
      <div
        class="led-bulb"
        :class="[config.shape || 'circle', { 'is-lit': isLit }]"
        :style="{
          backgroundColor: currentColor,
          boxShadow: isLit ? `0 0 16px ${currentColor}, 0 0 28px ${currentColor}80` : 'none',
        }"
      >
        <!-- 反光高光点 -->
        <div class="led-reflection"></div>
      </div>

      <!-- 标签与状态 -->
      <div class="led-info">
        <span class="led-label">{{ config.label || '指示灯' }}</span>
        <span class="led-state-text font-mono" :style="{ color: isLit ? currentColor : 'var(--text-muted)' }">
          {{ stateText }}
        </span>
      </div>
    </div>

    <!-- 底部通道指示 -->
    <div class="led-footer">
      <span class="ch-name font-mono">{{ config.channel || '未绑定通道' }}</span>
      <span class="ch-val font-mono">{{ currentVal != null ? currentVal.toFixed(2) : '--' }}</span>
    </div>
  </div>
</template>

<style scoped>
.led-widget-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 10px 14px;
  box-sizing: border-box;
  background: var(--bg-surface, #272623);
  border-radius: 6px;
  user-select: none;
  overflow: hidden;
  box-shadow: var(--card-shadow, 0 1px 3px rgba(0, 0, 0, 0.2));
  transition: background-color 0.2s ease, border-color 0.2s ease;
}

.led-center-body {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: auto 0;
}

.led-bulb {
  position: relative;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  border: 2px solid var(--border-subtle, rgba(255, 255, 255, 0.15));
  flex-shrink: 0;
}

.led-bulb.circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.led-bulb.rect {
  width: 40px;
  height: 24px;
  border-radius: 4px;
}

.led-reflection {
  position: absolute;
  top: 3px;
  left: 6px;
  width: 35%;
  height: 25%;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  transform: rotate(-30deg);
}

.led-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.led-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.led-state-text {
  font-size: 11px;
  font-weight: 500;
}

.led-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-subtle, #383633);
  padding-top: 4px;
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}
</style>
