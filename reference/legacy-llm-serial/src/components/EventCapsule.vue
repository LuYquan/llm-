<script setup lang="ts">
import { computed } from 'vue';
import type { FirmwareAnomaly } from '../core/copilot/types';

const props = defineProps<{
  anomaly: FirmwareAnomaly | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', anomaly: FirmwareAnomaly): void;
  (e: 'dismiss'): void;
}>();

const icon = computed(() => {
  if (!props.anomaly) return '⚠️';
  switch (props.anomaly.type) {
    case 'hardfault':
      return '⚡';
    case 'assert':
      return '🛑';
    case 'oscillation':
      return '〰';
    case 'divergence':
      return '💥';
    case 'watchdog':
      return '⏱';
    case 'overtemp':
      return '🔥';
    case 'overcurrent':
    case 'undervoltage':
      return '⚡';
    default:
      return '⚠️';
  }
});

const typeLabel = computed(() => {
  if (!props.anomaly) return '异常';
  switch (props.anomaly.type) {
    case 'hardfault':
      return 'HardFault';
    case 'assert':
      return 'Assert 断言';
    case 'oscillation':
      return '持续震荡';
    case 'divergence':
      return '通道发散';
    case 'watchdog':
      return '看门狗异常';
    case 'overtemp':
      return '温度超限';
    case 'overcurrent':
      return '过流报警';
    case 'undervoltage':
      return '欠压报警';
    case 'param_limit':
      return '参数超限';
    default:
      return '系统错误';
  }
});

function handleClick() {
  if (props.anomaly) {
    emit('click', props.anomaly);
  }
}

function handleDismiss(e: MouseEvent) {
  e.stopPropagation();
  emit('dismiss');
}
</script>

<template>
  <transition name="capsule-pop">
    <div
      v-if="visible && anomaly"
      class="event-capsule"
      :class="anomaly.level === 'critical' ? 'level-critical' : 'level-warning'"
      @click="handleClick"
      title="点击唤醒 Copilot 开展针对性深度根因诊断"
    >
      <div class="capsule-content">
        <span class="capsule-icon">{{ icon }}</span>
        <span class="capsule-tag">[{{ typeLabel }}]</span>
        <span class="capsule-msg">{{ anomaly.message }}</span>
      </div>

      <div class="capsule-actions">
        <span class="capsule-cta">唤醒 Copilot 诊断 ▲</span>
        <button
          type="button"
          class="btn-capsule-close"
          @click="handleDismiss"
          title="关闭提醒"
        >
          ×
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.event-capsule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  margin: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  border: 1px solid transparent;
}

.event-capsule.level-critical {
  background: linear-gradient(90deg, rgba(239, 68, 68, 0.22) 0%, rgba(30, 15, 20, 0.85) 100%);
  border-color: rgba(239, 68, 68, 0.55);
  color: #fecaca;
}

.event-capsule.level-critical:hover {
  background: linear-gradient(90deg, rgba(239, 68, 68, 0.32) 0%, rgba(45, 18, 25, 0.95) 100%);
  border-color: rgba(239, 68, 68, 0.8);
  transform: translateY(-1px);
}

.event-capsule.level-warning {
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.2) 0%, rgba(28, 20, 12, 0.85) 100%);
  border-color: rgba(245, 158, 11, 0.55);
  color: #fef3c7;
}

.event-capsule.level-warning:hover {
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.3) 0%, rgba(38, 28, 16, 0.95) 100%);
  border-color: rgba(245, 158, 11, 0.8);
  transform: translateY(-1px);
}

.capsule-content {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.capsule-icon {
  font-size: 14px;
}

.capsule-tag {
  font-weight: 700;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.capsule-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.95;
  font-family: inherit;
}

.capsule-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 12px;
}

.capsule-cta {
  font-size: 11px;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  font-weight: 600;
  letter-spacing: 0.3px;
  transition: background 0.15s ease;
}

.event-capsule:hover .capsule-cta {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.btn-capsule-close {
  background: transparent;
  border: none;
  color: currentColor;
  opacity: 0.6;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
}

.btn-capsule-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.2);
}

/* 动效 */
.capsule-pop-enter-active,
.capsule-pop-leave-active {
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.capsule-pop-enter-from,
.capsule-pop-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
