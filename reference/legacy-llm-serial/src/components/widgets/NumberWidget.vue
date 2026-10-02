<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { NumberConfig } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import { globalRenderScheduler } from '../../core/widget/renderScheduler';
import { useWidgetStore } from '../../stores/widgetStore';

const props = defineProps<{
  config: NumberConfig;
  w: number;
  h: number;
  widgetId?: string;
  tabId?: string;
}>();

const store = useWidgetStore();
const currentVal = ref<number | null>(null);
const prevVal = ref<number | null>(null);
const trend = ref<'up' | 'down' | 'flat'>('flat');

const numberId = `num_${props.widgetId || Math.random().toString(36).slice(2, 8)}`;

function updateNumber() {
  if (!props.config.channel) {
    if (currentVal.value !== null) {
      currentVal.value = null;
      prevVal.value = null;
      trend.value = 'flat';
    }
    return;
  }
  const pt = globalChannelStore.latest(props.config.channel);
  if (pt) {
    const meta = store.getChannelMeta(props.config.channel);
    const transformed = pt.v * meta.scale + meta.yOffset;
    if (transformed !== currentVal.value) {
      prevVal.value = currentVal.value;
      currentVal.value = transformed;
      if (prevVal.value !== null) {
        const diff = transformed - prevVal.value;
        if (Math.abs(diff) < 1e-4) {
          trend.value = 'flat';
        } else if (diff > 0) {
          trend.value = 'up';
        } else {
          trend.value = 'down';
        }
      }
    }
  } else {
    currentVal.value = null;
  }
}

onMounted(() => {
  globalRenderScheduler.register(numberId, updateNumber, {
    tabId: props.tabId,
    fpsLimit: 30,
  });
});

onUnmounted(() => {
  globalRenderScheduler.unregister(numberId);
});

const formattedValue = computed(() => {
  if (currentVal.value === null) return '--';
  const meta = props.config.channel ? store.getChannelMeta(props.config.channel) : null;
  const prec = props.config.precision ?? meta?.decimal ?? 2;
  return currentVal.value.toFixed(prec);
});

const isOutOfRange = computed(() => {
  if (currentVal.value === null) return false;
  if (props.config.min != null && currentVal.value < props.config.min) return true;
  if (props.config.max != null && currentVal.value > props.config.max) return true;
  return false;
});
</script>

<template>
  <div class="number-widget-container" :class="{ 'is-out-of-range': isOutOfRange }">
    <div class="num-header">
      <span class="num-prefix">{{ config.prefix || config.channel || '数值' }}</span>
      <span v-if="config.channel" class="num-channel-pill font-mono">{{ config.channel }}</span>
    </div>

    <div class="num-display-row">
      <div class="num-main font-mono" :class="{ 'text-warn': isOutOfRange }">
        {{ formattedValue }}
      </div>
      <div class="num-unit-col">
        <span class="trend-icon" :class="trend" :title="trend === 'up' ? '数值上升中' : trend === 'down' ? '数值下降中' : '平稳'">
          <template v-if="trend === 'up'">▲</template>
          <template v-else-if="trend === 'down'">▼</template>
          <template v-else>━</template>
        </span>
        <span v-if="config.unit" class="num-unit">{{ config.unit }}</span>
      </div>
    </div>

    <!-- 范围辅助指示条 -->
    <div v-if="config.min != null && config.max != null" class="range-indicator">
      <span class="range-min">{{ config.min }}</span>
      <div class="range-bar">
        <div
          class="range-fill"
          :style="{
            width: `${Math.min(100, Math.max(0, (((currentVal ?? config.min) - config.min) / ((config.max - config.min) || 1)) * 100))}%`
          }"
        ></div>
      </div>
      <span class="range-max">{{ config.max }}</span>
    </div>
  </div>
</template>

<style scoped>
.number-widget-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 12px 16px;
  box-sizing: border-box;
  background: var(--bg-surface, #272623);
  border-radius: 4px;
  position: relative;
  overflow: hidden;
  user-select: none;
}

.number-widget-container.is-out-of-range {
  background: radial-gradient(circle at center, rgba(224, 109, 133, 0.15) 0%, var(--bg-surface, #272623) 80%);
}

.num-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.num-prefix {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  font-weight: 500;
  letter-spacing: 0.5px;
}

.num-channel-pill {
  font-size: 10px;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25));
}

.num-display-row {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  margin: auto 0;
}

.num-main {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-main, #ECEAE4);
  line-height: 1;
}

.num-main.text-warn {
  color: #E06D85;
  text-shadow: 0 0 14px rgba(224, 109, 133, 0.4);
}

.num-unit-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.trend-icon {
  font-size: 10px;
}

.trend-icon.up {
  color: #7AA89B;
}

.trend-icon.down {
  color: #E06D85;
}

.trend-icon.flat {
  color: var(--text-soft, #706E66);
}

.num-unit {
  font-size: 12px;
  color: var(--text-muted, #9E9C94);
  font-weight: 500;
}

.range-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  font-family: monospace;
  color: var(--text-soft, #706E66);
}

.range-bar {
  flex: 1;
  height: 4px;
  background: var(--border-subtle, #383633);
  border-radius: 2px;
  overflow: hidden;
}

.range-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-terracotta, #DA7756), #7AA89B);
  transition: width 0.15s ease-out;
}
</style>
