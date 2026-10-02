<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from 'vue';
import type { CanvasWidgetInstance, GridSize, ChartConfig } from '../../types/widget';
import { useWidgetStore } from '../../stores/widgetStore';
import { globalWidgetRegistry } from '../../core/widget/registry';
import { snap, clampToCanvas, computeResize, type ResizeHandle } from '../../utils/grid';
import GaugeWidget from './GaugeWidget.vue';
import ChartWidget from './ChartWidget.vue';
import ButtonWidget from './ButtonWidget.vue';
import SliderWidget from './SliderWidget.vue';
import NumberWidget from './NumberWidget.vue';
import LedWidget from './LedWidget.vue';
import KnobWidget from './KnobWidget.vue';
import StatCardWidget from './StatCardWidget.vue';
import StepResponseCard from './StepResponseCard.vue';
const BodeWidget = defineAsyncComponent(() => import('./BodeWidget.vue'));

const props = defineProps<{
  widget: CanvasWidgetInstance;
  locked: boolean;
  isSelected: boolean;
  gridSize: GridSize;
  canvasW: number;
  canvasH: number;
  isConnected: boolean;
  tabId?: string;
}>();

const emit = defineEmits<{
  (e: 'select', id: string): void;
  (e: 'update-position', id: string, x: number, y: number): void;
  (e: 'update-size', id: string, w: number, h: number): void;
  (e: 'update-geometry', id: string, x: number, y: number, w: number, h: number): void;
  (e: 'open-config', widget: CanvasWidgetInstance): void;
  (e: 'delete', id: string): void;
  (e: 'duplicate', id: string): void;
  (e: 'context-menu', event: MouseEvent, widget: CanvasWidgetInstance): void;
}>();

const store = useWidgetStore();

// 通道跨组件拖拽悬停与绑定状态
const isChannelDragHover = ref(false);
const hoverChannelName = ref('');

function onChannelDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('application/x-vofa-channel') || store.draggingChannelId.value) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    isChannelDragHover.value = true;
    const draggingId = store.draggingChannelId.value;
    hoverChannelName.value = draggingId ? store.getChannelMeta(draggingId).name : '通道';
  }
}

function onChannelDragLeave(e: DragEvent) {
  if (!e.relatedTarget || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
    isChannelDragHover.value = false;
  }
}

function onChannelDrop(e: DragEvent) {
  isChannelDragHover.value = false;
  const channelId = e.dataTransfer?.getData('application/x-vofa-channel') || store.draggingChannelId.value;
  if (!channelId) return;
  e.preventDefault();
  e.stopPropagation();

  const meta = store.getChannelMeta(channelId);
  const chName = meta.name || channelId;

  if (props.widget.type === 'chart') {
    const chartCfg = props.widget.config as ChartConfig;
    const exists = chartCfg.series.find((s) => s.channel === channelId || s.channel === chName);
    if (!exists) {
      chartCfg.series.push({
        channel: chName,
        color: meta.color || '#DA7756',
        visible: true,
      });
    }
  } else if (props.widget.type === 'slider' || props.widget.type === 'knob') {
    (props.widget.config as any).feedback_channel = chName;
  } else if ('channel' in props.widget.config) {
    (props.widget.config as any).channel = chName;
  }
  store.updateWidget(props.widget);
}

// 拖动位移状态 (临时预览)
const isDragging = ref(false);
const dragPos = ref({ x: props.widget.x, y: props.widget.y });
let dragStartPointer = { x: 0, y: 0 };
let dragStartWidget = { x: 0, y: 0 };

// 8向缩放手柄状态 (临时预览)
const isResizing = ref(false);
const activeHandle = ref<ResizeHandle | null>(null);
const resizePos = ref({ x: props.widget.x, y: props.widget.y });
const resizeSize = ref({ w: props.widget.w, h: props.widget.h });
let resizeStartPointer = { x: 0, y: 0 };
let resizeStartWidget = { x: 0, y: 0, w: 0, h: 0 };

// 最终渲染的坐标与尺寸
const displayX = computed(() => {
  if (isDragging.value) return dragPos.value.x;
  if (isResizing.value) return resizePos.value.x;
  return props.widget.x;
});
const displayY = computed(() => {
  if (isDragging.value) return dragPos.value.y;
  if (isResizing.value) return resizePos.value.y;
  return props.widget.y;
});
const displayW = computed(() => (isResizing.value ? resizeSize.value.w : props.widget.w));
const displayH = computed(() => (isResizing.value ? resizeSize.value.h : props.widget.h));

// 活跃与选中图层提升 (确保手柄与外框不被同级其它卡片遮挡)
const displayZIndex = computed(() => {
  const baseZ = props.widget.z || 1;
  if (isDragging.value || isResizing.value) return baseZ + 200;
  if (props.isSelected) return baseZ + 100;
  return baseZ;
});

// 类型对应图标
const typeIcon = computed(() => {
  const def = globalWidgetRegistry.get(props.widget.type);
  return def ? def.icon : '📦';
});

function handleCardClick() {
  emit('select', props.widget.id);
}

// ==================== 顶部把手拖拽移动 ====================
function onHeaderPointerDown(e: PointerEvent) {
  if (props.locked) return; // 锁定态禁止拖拽
  if ((e.target as HTMLElement).closest('.btn-header-action')) return;

  emit('select', props.widget.id);
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);

  isDragging.value = true;
  dragStartPointer = { x: e.clientX, y: e.clientY };
  dragStartWidget = { x: props.widget.x, y: props.widget.y };
  dragPos.value = { x: props.widget.x, y: props.widget.y };
}

function onHeaderPointerMove(e: PointerEvent) {
  if (!isDragging.value) return;
  const dx = e.clientX - dragStartPointer.x;
  const dy = e.clientY - dragStartPointer.y;

  const rawX = dragStartWidget.x + dx;
  const rawY = dragStartWidget.y + dy;

  const snappedX = snap(rawX, props.gridSize);
  const snappedY = snap(rawY, props.gridSize);

  const clamped = clampToCanvas(
    snappedX,
    snappedY,
    props.widget.w,
    props.widget.h,
    props.canvasW,
    props.canvasH
  );

  dragPos.value = clamped;
}

function onHeaderPointerUp(e: PointerEvent) {
  if (!isDragging.value) return;
  isDragging.value = false;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {}

  emit('update-position', props.widget.id, dragPos.value.x, dragPos.value.y);
}

// ==================== 8向手柄缩放调节 ====================
function onResizePointerDown(e: PointerEvent, handle: ResizeHandle) {
  if (props.locked) return;
  e.stopPropagation();

  emit('select', props.widget.id);
  const target = e.currentTarget as HTMLElement;
  try {
    target.setPointerCapture(e.pointerId);
  } catch {}

  isResizing.value = true;
  activeHandle.value = handle;
  resizeStartPointer = { x: e.clientX, y: e.clientY };
  resizeStartWidget = {
    x: props.widget.x,
    y: props.widget.y,
    w: props.widget.w,
    h: props.widget.h,
  };
  resizePos.value = { x: props.widget.x, y: props.widget.y };
  resizeSize.value = { w: props.widget.w, h: props.widget.h };
}

function onResizePointerMove(e: PointerEvent) {
  if (!isResizing.value || !activeHandle.value) return;
  const dx = e.clientX - resizeStartPointer.x;
  const dy = e.clientY - resizeStartPointer.y;

  const def = globalWidgetRegistry.get(props.widget.type);
  const minW = def ? def.defaultSize.min_w : 100;
  const minH = def ? def.defaultSize.min_h : 60;

  const res = computeResize({
    handle: activeHandle.value,
    startX: resizeStartWidget.x,
    startY: resizeStartWidget.y,
    startW: resizeStartWidget.w,
    startH: resizeStartWidget.h,
    dx,
    dy,
    minW,
    minH,
    gridSize: props.gridSize,
    canvasW: props.canvasW,
    canvasH: props.canvasH,
  });

  resizePos.value = { x: res.x, y: res.y };
  resizeSize.value = { w: res.w, h: res.h };
}

function onResizePointerUp(e: PointerEvent) {
  if (!isResizing.value) return;
  isResizing.value = false;
  activeHandle.value = null;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {}

  const finalX = resizePos.value.x;
  const finalY = resizePos.value.y;
  const finalW = resizeSize.value.w;
  const finalH = resizeSize.value.h;

  emit('update-geometry', props.widget.id, finalX, finalY, finalW, finalH);
  if (finalX !== props.widget.x || finalY !== props.widget.y) {
    emit('update-position', props.widget.id, finalX, finalY);
  }
  if (finalW !== props.widget.w || finalH !== props.widget.h) {
    emit('update-size', props.widget.id, finalW, finalH);
  }
}

// 右键上下文菜单
function onContextMenu(e: MouseEvent) {
  if (props.locked) return;
  emit('select', props.widget.id);
  emit('context-menu', e, props.widget);
}

// 双击打开配置
function onDblClick() {
  if (!props.locked) {
    emit('open-config', props.widget);
  }
}
</script>

<template>
  <div
    class="canvas-widget-card"
    :class="{
      'is-selected': isSelected,
      'is-locked': locked,
      'is-dragging': isDragging,
      'is-resizing': isResizing,
      'is-channel-hover': isChannelDragHover,
    }"
    :style="{
      left: `${displayX}px`,
      top: `${displayY}px`,
      width: `${displayW}px`,
      height: `${displayH}px`,
      zIndex: displayZIndex,
    }"
    @click="handleCardClick"
    @dblclick="onDblClick"
    @contextmenu.prevent="onContextMenu"
    @dragover="onChannelDragOver"
    @dragleave="onChannelDragLeave"
    @drop="onChannelDrop"
  >
    <!-- 跨组件通道拖拽悬停高亮覆盖层 (VOFA+ 原生交互) -->
    <div v-if="isChannelDragHover" class="channel-drop-hover-overlay">
      <span class="channel-drop-badge">🎯 释放绑定通道: {{ hoverChannelName }}</span>
    </div>

    <!-- 编辑态防误触遮罩 (防电机飞车) -->
    <div
      v-if="!locked && ['slider', 'knob', 'button'].includes(widget.type)"
      class="edit-shield-overlay"
      title="【编辑模式保护】交互已锁定，防止排版卡片时误触发电机下发"
    ></div>

    <!-- 卡片顶部把手栏 (Header Handle) -->
    <div
      class="widget-header"
      :class="{ 'draggable-header': !locked }"
      @pointerdown="onHeaderPointerDown"
      @pointermove="onHeaderPointerMove"
      @pointerup="onHeaderPointerUp"
      @pointercancel="onHeaderPointerUp"
    >
      <div class="header-left">
        <span class="type-icon">{{ typeIcon }}</span>
        <span class="title-text" :title="widget.title">{{ widget.title }}</span>
      </div>

      <!-- 解锁编辑态操作按钮 -->
      <div class="header-actions" v-if="!locked">
        <button
          class="btn-header-action"
          title="属性配置 (⚙️)"
          @click.stop="emit('open-config', widget)"
        >
          ⚙️
        </button>
        <button
          class="btn-header-action btn-delete"
          title="删除控件 (✕)"
          @click.stop="emit('delete', widget.id)"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- 卡片主体内容容器 (支持全部 9 大控件体系) -->
    <div class="widget-content">
      <GaugeWidget
        v-if="widget.type === 'gauge'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />

      <ChartWidget
        v-else-if="widget.type === 'chart'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />

      <ButtonWidget
        v-else-if="widget.type === 'button'"
        :config="(widget.config as any)"
        :title="widget.title"
        :locked="locked"
        :isConnected="isConnected"
        :widgetId="widget.id"
      />

      <SliderWidget
        v-else-if="widget.type === 'slider'"
        :config="(widget.config as any)"
        :title="widget.title"
        :locked="locked"
        :isConnected="isConnected"
        :widgetId="widget.id"
      />

      <NumberWidget
        v-else-if="widget.type === 'number'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />

      <LedWidget
        v-else-if="widget.type === 'led'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />

      <KnobWidget
        v-else-if="widget.type === 'knob'"
        :config="(widget.config as any)"
        :title="widget.title"
        :locked="locked"
        :isConnected="isConnected"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
      />

      <StatCardWidget
        v-else-if="widget.type === 'stat_card'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />

      <StepResponseCard
        v-else-if="widget.type === 'step_card'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />

      <BodeWidget
        v-else-if="widget.type === 'bode'"
        :config="(widget.config as any)"
        :w="displayW"
        :h="displayH - 32"
        :widgetId="widget.id"
        :tabId="tabId"
      />
    </div>

    <!-- 编辑态辅助指示与8向缩放手柄 (VOFA+ 原生交互手柄体系) -->
    <template v-if="!locked">
      <!-- 拖拽/缩放即时坐标与尺寸提示 -->
      <div class="geo-badge" v-if="isDragging">
        X: {{ displayX }} Y: {{ displayY }}
      </div>
      <div class="geo-badge" v-if="isResizing">
        {{ displayW }} × {{ displayH }} (X: {{ displayX }}, Y: {{ displayY }})
      </div>

      <!-- 选中时呈现 8 向拉伸控制手柄 -->
      <template v-if="isSelected">
        <!-- 4 条边缘调整手柄 -->
        <div
          class="resize-handle edge-n"
          title="向上调整高度 (吸附网格)"
          @pointerdown="onResizePointerDown($event, 'n')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
        <div
          class="resize-handle edge-s"
          title="向下调整高度 (吸附网格)"
          @pointerdown="onResizePointerDown($event, 's')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
        <div
          class="resize-handle edge-w"
          title="向左调整宽度 (吸附网格)"
          @pointerdown="onResizePointerDown($event, 'w')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
        <div
          class="resize-handle edge-e"
          title="向右调整宽度 (吸附网格)"
          @pointerdown="onResizePointerDown($event, 'e')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>

        <!-- 4 个角调整手柄 -->
        <div
          class="resize-handle corner-nw"
          title="左上角双向拉伸"
          @pointerdown="onResizePointerDown($event, 'nw')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
        <div
          class="resize-handle corner-ne"
          title="右上角双向拉伸"
          @pointerdown="onResizePointerDown($event, 'ne')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
        <div
          class="resize-handle corner-sw"
          title="左下角双向拉伸"
          @pointerdown="onResizePointerDown($event, 'sw')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
        <div
          class="resize-handle corner-se"
          title="右下角双向拉伸"
          @pointerdown="onResizePointerDown($event, 'se')"
          @pointermove="onResizePointerMove"
          @pointerup="onResizePointerUp"
          @pointercancel="onResizePointerUp"
        ></div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.canvas-widget-card {
  position: absolute;
  background-color: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--card-shadow, 0 1px 3px rgba(0, 0, 0, 0.2), 0 4px 16px rgba(0, 0, 0, 0.3));
  box-sizing: border-box;
  overflow: visible;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.25s ease;
  user-select: none;
}

.canvas-widget-card:hover {
  border-color: var(--border-strong, #4A4843);
}

.canvas-widget-card.is-selected {
  border-color: var(--accent-terracotta, #DA7756) !important;
  box-shadow: 0 0 0 1px var(--accent-terracotta, #DA7756), 0 8px 24px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25)) !important;
}

.canvas-widget-card.is-dragging {
  opacity: 0.85;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5) !important;
  cursor: grabbing !important;
}

.canvas-widget-card.is-resizing {
  opacity: 0.9;
  border-color: var(--accent-terracotta, #DA7756);
}

/* 顶部把手栏 */
.widget-header {
  height: 30px;
  min-height: 30px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
  border-radius: 11px 11px 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  box-sizing: border-box;
  overflow: hidden;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

.widget-header.draggable-header {
  cursor: grab;
}

.widget-header.draggable-header:active {
  cursor: grabbing;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.type-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.title-text {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.btn-header-action {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-header-action:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.btn-header-action.btn-delete:hover {
  background: rgba(239, 68, 68, 0.25);
  color: #f87171;
}

/* 主体内容 */
.widget-content {
  flex: 1;
  width: 100%;
  height: calc(100% - 30px);
  position: relative;
  overflow: hidden;
  border-radius: 0 0 5px 5px;
}

/* 尺寸与坐标徽章 */
.geo-badge {
  position: absolute;
  top: -24px;
  left: 0;
  background: var(--accent-terracotta, #DA7756);
  color: #fff;
  font-size: 10px;
  font-family: monospace;
  padding: 1px 6px;
  border-radius: 3px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  white-space: nowrap;
  z-index: 100;
}

/* 8向拉伸尺寸手柄样式 (VOFA+ 风格) */
.resize-handle {
  position: absolute;
  z-index: 55;
  touch-action: none;
  box-sizing: border-box;
}

/* 4 个边缘调整区域 (扩展至 12px 抓取区，中心保留精准指示条) */
.edge-n {
  top: -6px;
  left: 10px;
  right: 10px;
  height: 12px;
  cursor: ns-resize;
}
.edge-n::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 28px;
  height: 4px;
  background: var(--accent-terracotta, #DA7756);
  border-radius: 2px;
  border: 1px solid #ffffff;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
  opacity: 0.85;
}

.edge-s {
  bottom: -6px;
  left: 10px;
  right: 10px;
  height: 12px;
  cursor: ns-resize;
}
.edge-s::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 28px;
  height: 4px;
  background: var(--accent-terracotta, #DA7756);
  border-radius: 2px;
  border: 1px solid #ffffff;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
  opacity: 0.85;
}

.edge-w {
  left: -6px;
  top: 10px;
  bottom: 10px;
  width: 12px;
  cursor: ew-resize;
}
.edge-w::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 28px;
  background: var(--accent-terracotta, #DA7756);
  border-radius: 2px;
  border: 1px solid #ffffff;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
  opacity: 0.85;
}

.edge-e {
  right: -6px;
  top: 10px;
  bottom: 10px;
  width: 12px;
  cursor: ew-resize;
}
.edge-e::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 28px;
  background: var(--accent-terracotta, #DA7756);
  border-radius: 2px;
  border: 1px solid #ffffff;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
  opacity: 0.85;
}

.edge-n:hover::after,
.edge-s:hover::after,
.edge-w:hover::after,
.edge-e:hover::after {
  opacity: 1;
  background: var(--accent-terracotta-hover, #E58565);
  box-shadow: 0 0 6px var(--accent-terracotta, #DA7756);
}

/* 4 个对角调整角点 */
.corner-nw,
.corner-ne,
.corner-sw,
.corner-se {
  width: 12px;
  height: 12px;
  background: var(--accent-terracotta, #DA7756);
  border: 1.5px solid #ffffff;
  border-radius: 2px;
  box-shadow: 0 0 6px rgba(0, 0, 0, 0.5);
  transition: transform 0.1s ease, background-color 0.1s ease;
}
.corner-nw:hover,
.corner-ne:hover,
.corner-sw:hover,
.corner-se:hover {
  background: var(--accent-terracotta-hover, #E58565);
  transform: scale(1.3);
  box-shadow: 0 0 8px var(--accent-terracotta, #DA7756);
}

.corner-nw {
  top: -6px;
  left: -6px;
  cursor: nwse-resize;
}
.corner-ne {
  top: -6px;
  right: -6px;
  cursor: nesw-resize;
}
.corner-sw {
  bottom: -6px;
  left: -6px;
  cursor: nesw-resize;
}
.corner-se {
  bottom: -6px;
  right: -6px;
  cursor: nwse-resize;
}

/* 跨组件通道拖拽悬停视觉 */
.canvas-widget-card.is-channel-hover {
  outline: 2px dashed var(--accent-terracotta, #DA7756) !important;
  box-shadow: 0 0 20px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.4)) !important;
}

.channel-drop-hover-overlay {
  position: absolute;
  inset: 0;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.18));
  backdrop-filter: blur(1px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 150;
  pointer-events: none;
  animation: fadeIn 0.15s ease-out;
}

.channel-drop-badge {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
  padding: 6px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  border: 1px solid #7dd3fc;
}

/* 编辑态防误触遮罩 (防电机飞车) */
.edit-shield-overlay {
  position: absolute;
  inset: 32px 0 0 0;
  background: transparent;
  z-index: 80;
  cursor: grab;
}
</style>
