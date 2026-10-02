<script setup lang="ts">
import { ref, onUnmounted } from 'vue';

interface Props {
  modelValue?: number; // 左侧面板百分比 (0~100)
  min?: number;        // 最小限制百分比 (默认 20)
  max?: number;        // 最大限制百分比 (默认 80)
  collapsed?: boolean; // 右侧是否折叠
  collapsible?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: 50,
  min: 25,
  max: 80,
  collapsed: false,
  collapsible: true,
});

const emit = defineEmits<{
  (e: 'update:modelValue', val: number): void;
  (e: 'update:collapsed', val: boolean): void;
  (e: 'toggle'): void;
  (e: 'reset'): void;
}>();

const isDragging = ref(false);
const splitterRef = ref<HTMLDivElement | null>(null);

function startDrag() {
  if (props.collapsed) return;
  isDragging.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  window.addEventListener('mousemove', onDragging);
  window.addEventListener('mouseup', stopDrag);
}

function onDragging(e: MouseEvent) {
  if (!isDragging.value || !splitterRef.value) return;

  const container = splitterRef.value.parentElement;
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const rawX = e.clientX - rect.left;
  let percent = (rawX / rect.width) * 100;

  if (percent < props.min) percent = props.min;
  if (percent > props.max) percent = props.max;

  emit('update:modelValue', Math.round(percent * 10) / 10);
}

function stopDrag() {
  if (!isDragging.value) return;
  isDragging.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';

  window.removeEventListener('mousemove', onDragging);
  window.removeEventListener('mouseup', stopDrag);
}

function handleDoubleClick() {
  if (props.collapsed) return;
  emit('update:modelValue', 50);
  emit('reset');
}

function handleToggleCollapse(e: MouseEvent) {
  e.stopPropagation();
  emit('update:collapsed', !props.collapsed);
  emit('toggle');
}

onUnmounted(() => {
  stopDrag();
});
</script>

<template>
  <div
    ref="splitterRef"
    class="workbench-splitter"
    :class="{ 'is-dragging': isDragging, 'is-collapsed': collapsed }"
    @mousedown="startDrag"
    @dblclick="handleDoubleClick"
    :title="collapsed ? '点击展开扩展翼' : '双击复位为 1:1 分屏，按住左右拖拽调整宽度'"
  >
    <!-- 分割线中心握把与折叠按钮 -->
    <div class="splitter-handle-wrapper">
      <button
        v-if="collapsible"
        type="button"
        class="collapse-trigger-btn"
        :class="{ 'rotate-180': collapsed }"
        @click="handleToggleCollapse"
        :title="collapsed ? '展开扩展翼 (Alt + B)' : '收起扩展翼 (Alt + B)'"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" class="w-3.5 h-3.5 fill-current">
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" />
        </svg>
      </button>

      <!-- 拖拽握把点阵 -->
      <div v-if="!collapsed" class="drag-grip-dots">
        <span class="grip-dot"></span>
        <span class="grip-dot"></span>
        <span class="grip-dot"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workbench-splitter {
  width: 8px;
  position: relative;
  background-color: var(--bg-surface);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  cursor: col-resize;
  transition: background-color 0.15s ease;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.workbench-splitter:hover,
.workbench-splitter.is-dragging {
  background-color: var(--accent-terracotta);
  box-shadow: 0 0 8px rgba(218, 119, 86, 0.4);
}

.workbench-splitter.is-collapsed {
  cursor: pointer;
  width: 14px;
  background-color: var(--bg-elevated);
  border-left: 1px solid var(--border-subtle);
  border-right: 1px solid var(--border-subtle);
}

.workbench-splitter.is-collapsed:hover {
  background-color: var(--accent-terracotta);
}

.splitter-handle-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.collapse-trigger-btn {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  border-radius: 4px;
  width: 16px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.collapse-trigger-btn:hover {
  background: var(--accent-terracotta);
  color: #ffffff;
  border-color: var(--accent-terracotta);
}

.collapse-trigger-btn svg {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  flex-shrink: 0;
}

.collapse-trigger-btn.rotate-180 {
  transform: rotate(180deg);
}

.drag-grip-dots {
  display: flex;
  flex-direction: column;
  gap: 3px;
  opacity: 0.6;
}

.grip-dot {
  width: 2px;
  height: 2px;
  background-color: var(--text-muted);
  border-radius: 50%;
}

.workbench-splitter:hover .grip-dot {
  background-color: #ffffff;
}
</style>
