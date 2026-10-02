<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useWidgetStore, createNewWidget } from '../stores/widgetStore';
import type { CanvasWidgetInstance, WidgetType } from '../types/widget';
import { globalWidgetRegistry } from '../core/widget/registry';
import { snap, clientToCanvas, clampToCanvas, findFreeSpace } from '../utils/grid';
import {
  getAvailableChannels,
  getWidgetBoundChannel,
  isChannelBindableWidget,
  bindWidgetChannel,
  toggleChartSeriesChannel,
  isChannelInChartSeries,
  formatBindingDisplay,
  type ChannelSelectItem,
} from '../utils/channelHelpers';
import { globalChannelStore } from '../core/channel/ChannelStore';
import CanvasWidgetWrapper from './widgets/CanvasWidgetWrapper.vue';
const CanvasWidgetConfigModal = defineAsyncComponent(() => import('./widgets/CanvasWidgetConfigModal.vue'));

const props = defineProps<{
  isRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'click-canvas'): void;
}>();

const store = useWidgetStore();

// 画布视口 DOM 引用
const canvasViewportRef = ref<HTMLElement | null>(null);
let viewportObserver: ResizeObserver | null = null;
let autoFitDefaultView = true;

// 配置弹窗状态
const isConfigModalOpen = ref(false);
const editingWidget = ref<CanvasWidgetInstance | null>(null);

// Tab 重命名状态
const editingTabId = ref<string | null>(null);
const editingTabName = ref('');

// 拖拽落点幽灵预览
interface DragGhostState {
  visible: boolean;
  type: WidgetType | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

const dragGhost = ref<DragGhostState>({
  visible: false,
  type: null,
  x: 0,
  y: 0,
  w: 240,
  h: 240,
});

let justFinishedDrag = false;

// ==================== 指针级 (Pointer Events) 拖拽与落点处理 ====================
function handleCanvasPointerDrop(type: WidgetType, clientX: number, clientY: number): boolean {
  if (store.isLocked.value) {
    dragGhost.value.visible = false;
    return false;
  }

  const viewport = canvasViewportRef.value;
  if (!viewport) {
    dragGhost.value.visible = false;
    return false;
  }

  const rect = viewport.getBoundingClientRect();
  if (
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    dragGhost.value.visible = false;
    return false;
  }

  // 关键防御：如果落点仍位于左侧抽屉或其它悬浮面板之上，拒绝落位
  if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
    const targetEl = document.elementFromPoint(clientX, clientY);
    if (targetEl && !viewport.contains(targetEl) && targetEl !== viewport) {
      dragGhost.value.visible = false;
      return false;
    }
  }

  const def = globalWidgetRegistry.get(type);
  const size = def?.defaultSize || { w: 240, h: 240 };

  const coords = clientToCanvas(
    clientX,
    clientY,
    rect,
    viewport.scrollLeft,
    viewport.scrollTop,
    size.w / 2,
    size.h / 2,
    store.gridSize.value
  );

  const clamped = clampToCanvas(
    coords.x,
    coords.y,
    size.w,
    size.h,
    store.activeTab.value?.canvas_w || 2400,
    store.activeTab.value?.canvas_h || 1600
  );

  const newWidget = createNewWidget(type, clamped.x, clamped.y);
  store.addWidget(newWidget);
  store.selectedWidgetId.value = newWidget.id;

  dragGhost.value.visible = false;

  // 设置拖拽刚刚结束防抖标记，防止随后的浏览器合成 click 事件误将左侧抽屉收起
  justFinishedDrag = true;
  window.setTimeout(() => {
    justFinishedDrag = false;
  }, 200);

  return true;
}

// 实时响应全局指针拖拽位置，并在进入视口时吸附网格
watch(
  () => [
    store.pointerDragState.value.active,
    store.pointerDragState.value.pointerX,
    store.pointerDragState.value.pointerY,
  ],
  () => {
    if (!store.pointerDragState.value.active || store.isLocked.value) {
      if (!store.draggingWidgetType.value) {
        dragGhost.value.visible = false;
      }
      return;
    }

    const viewport = canvasViewportRef.value;
    if (!viewport) {
      dragGhost.value.visible = false;
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const px = store.pointerDragState.value.pointerX;
    const py = store.pointerDragState.value.pointerY;

    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
      dragGhost.value.visible = false;
      return;
    }

    // 关键防御：如果光标仍停留在左侧抽屉或其它悬浮面板之上，隐藏落点虚线框
    if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
      const targetEl = document.elementFromPoint(px, py);
      if (targetEl && !viewport.contains(targetEl) && targetEl !== viewport) {
        dragGhost.value.visible = false;
        return;
      }
    }

    const type = store.pointerDragState.value.widgetType;
    if (!type) {
      dragGhost.value.visible = false;
      return;
    }

    const def = globalWidgetRegistry.get(type);
    const size = def?.defaultSize || { w: 240, h: 240 };

    const coords = clientToCanvas(
      px,
      py,
      rect,
      viewport.scrollLeft,
      viewport.scrollTop,
      size.w / 2,
      size.h / 2,
      store.gridSize.value
    );

    const clamped = clampToCanvas(
      coords.x,
      coords.y,
      size.w,
      size.h,
      store.activeTab.value?.canvas_w || 2400,
      store.activeTab.value?.canvas_h || 1600
    );

    dragGhost.value = {
      visible: true,
      type,
      x: clamped.x,
      y: clamped.y,
      w: size.w,
      h: size.h,
    };
  }
);

// ==================== HTML5 拖拽放置处理 (兼容旧模式) ====================
function handleDragOver(e: DragEvent) {
  if (store.isLocked.value) return;
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
  }

  const viewport = canvasViewportRef.value;
  if (!viewport) return;

  const rect = viewport.getBoundingClientRect();
  const rawType = (store.draggingWidgetType.value || e.dataTransfer?.getData('application/x-vofa-widget') || 'chart') as WidgetType;
  const def = globalWidgetRegistry.get(rawType);
  const size = def?.defaultSize || { w: 240, h: 240 };

  const coords = clientToCanvas(
    e.clientX,
    e.clientY,
    rect,
    viewport.scrollLeft,
    viewport.scrollTop,
    size.w / 2,
    size.h / 2,
    store.gridSize.value
  );

  const clamped = clampToCanvas(
    coords.x,
    coords.y,
    size.w,
    size.h,
    store.activeTab.value?.canvas_w || 2400,
    store.activeTab.value?.canvas_h || 1600
  );

  dragGhost.value = {
    visible: true,
    type: rawType,
    x: clamped.x,
    y: clamped.y,
    w: size.w,
    h: size.h,
  };
}

function handleDragLeave(e: DragEvent) {
  // 当真正离开视口时隐藏幽灵框
  if (!e.relatedTarget || (e.relatedTarget as HTMLElement).closest('.canvas-viewport') !== canvasViewportRef.value) {
    dragGhost.value.visible = false;
  }
}

function handleDrop(e: DragEvent) {
  if (store.isLocked.value) return;
  e.preventDefault();

  const type = (store.draggingWidgetType.value || e.dataTransfer?.getData('application/x-vofa-widget') || e.dataTransfer?.getData('text/plain')) as WidgetType;
  store.setDraggingWidgetType(null);
  if (!type || !globalWidgetRegistry.has(type)) {
    dragGhost.value.visible = false;
    return;
  }

  const viewport = canvasViewportRef.value;
  if (!viewport) return;

  const rect = viewport.getBoundingClientRect();
  const def = globalWidgetRegistry.get(type);
  const size = def?.defaultSize || { w: 240, h: 240 };

  const coords = clientToCanvas(
    e.clientX,
    e.clientY,
    rect,
    viewport.scrollLeft,
    viewport.scrollTop,
    size.w / 2,
    size.h / 2,
    store.gridSize.value
  );

  const clamped = clampToCanvas(
    coords.x,
    coords.y,
    size.w,
    size.h,
    store.activeTab.value?.canvas_w || 2400,
    store.activeTab.value?.canvas_h || 1600
  );

  const newWidget = createNewWidget(type, clamped.x, clamped.y);
  store.addWidget(newWidget);

  dragGhost.value.visible = false;
}

// 供外部直接添加控件到当前视图中心 (带空白避障算法)
function addWidgetDirectly(type: WidgetType) {
  if (store.isLocked.value) return;
  const viewport = canvasViewportRef.value;
  const def = globalWidgetRegistry.get(type);
  const size = def?.defaultSize || { w: 240, h: 240 };

  let x = 60;
  let y = 60;
  if (viewport) {
    x = snap(viewport.scrollLeft + (viewport.clientWidth - size.w) / 2, store.gridSize.value);
    y = snap(viewport.scrollTop + (viewport.clientHeight - size.h) / 2, store.gridSize.value);
  }

  const freePos = findFreeSpace(
    size.w,
    size.h,
    store.activeWidgets.value,
    store.activeTab.value?.canvas_w || 2400,
    store.gridSize.value,
    Math.max(20, x),
    Math.max(20, y)
  );

  const newWidget = createNewWidget(type, freePos.x, freePos.y);
  store.addWidget(newWidget);
}

// ==================== 画布交互 ====================
function handleCanvasWheel(e: WheelEvent) {
  if (contextMenu.value.visible) {
    contextMenu.value.visible = false;
  }
  const viewport = canvasViewportRef.value;
  if (!viewport) return;

  // Shift + 滚轮横向平移
  if (e.shiftKey && e.deltaY !== 0) {
    e.preventDefault();
    viewport.scrollLeft += e.deltaY;
  }
}

function handleCanvasBgClick(e: MouseEvent) {
  if (justFinishedDrag) {
    justFinishedDrag = false;
    return;
  }
  if (e.target === canvasViewportRef.value || (e.target as HTMLElement).classList.contains('canvas-grid-surface')) {
    store.selectedWidgetId.value = null;
    emit('click-canvas');
  }
}

// ==================== Tab 操作 ====================
async function startRenameTab(tab: { id: string; name: string }) {
  editingTabId.value = tab.id;
  editingTabName.value = tab.name;
  await nextTick();
  const inputEl = document.querySelector<HTMLInputElement>('.tab-rename-input');
  if (inputEl) {
    inputEl.focus();
    inputEl.select();
  }
}

function commitRenameTab(tabId: string) {
  if (editingTabId.value === tabId) {
    store.renameTab(tabId, editingTabName.value);
    editingTabId.value = null;
  }
}

function handleCloseTab(tabId: string, name: string) {
  const tab = store.dashboardState.value.tabs.find((t) => t.id === tabId);
  if (tab && tab.widgets.length > 0) {
    if (!confirm(`工作台「${name}」中包含 ${tab.widgets.length} 个控件，确认关闭吗？`)) {
      return;
    }
  }
  store.removeTab(tabId);
}

// 一键铺满当前视区 (针对选中的控件或当前仅有的波形控件，严格吸附网格)
function handleFitToViewport() {
  const tab = store.activeTab.value;
  if (!tab || tab.widgets.length === 0) return;
  const viewport = canvasViewportRef.value;
  if (!viewport) return;

  const targetId = store.selectedWidgetId.value || tab.widgets[0].id;
  const widget = tab.widgets.find((w) => w.id === targetId);
  if (!widget) return;

  const snappedW = Math.max(400, snap(viewport.clientWidth - 40, store.gridSize.value));
  const snappedH = Math.max(200, snap(viewport.clientHeight - 40, store.gridSize.value));
  if (widget.x === 20 && widget.y === 20 && widget.w === snappedW && widget.h === snappedH) return;
  store.updateWidgetGeometry(widget.id, 20, 20, snappedW, snappedH);
}

// ==================== 控件操作 ====================
function handleOpenConfig(widget: CanvasWidgetInstance) {
  editingWidget.value = widget;
  isConfigModalOpen.value = true;
}

function handleSaveConfig(updated: CanvasWidgetInstance) {
  store.updateWidget(updated);
}

function handleDeleteWidget(id: string) {
  store.deleteWidget(id);
}

function handleDuplicateWidget(id: string) {
  store.duplicateWidget(id);
}

// ==================== 右键上下文菜单管理 ====================
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  widgetId: string;
  widgetTitle: string;
  widgetIcon: string;
  activeSubmenu: 'channel' | null;
  submenuX: number;
  submenuY: number;
}

const contextMenu = ref<ContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  widgetId: '',
  widgetTitle: '',
  widgetIcon: '📦',
  activeSubmenu: null,
  submenuX: 0,
  submenuY: 0,
});

const contextMenuTargetWidget = computed(() => {
  if (!contextMenu.value.widgetId) return null;
  return store.activeWidgets.value.find((w) => w.id === contextMenu.value.widgetId) || null;
});

const currentBindingDisplay = computed(() => {
  return formatBindingDisplay(contextMenuTargetWidget.value, store);
});

const contextSubmenuChannels = ref<ChannelSelectItem[]>([]);
let contextMenuTicker: number | null = null;

function refreshContextSubmenuChannels() {
  const target = contextMenuTargetWidget.value;
  const bound = target ? getWidgetBoundChannel(target) : null;
  contextSubmenuChannels.value = getAvailableChannels(store, globalChannelStore, bound);
}

function startContextMenuTicker() {
  stopContextMenuTicker();
  refreshContextSubmenuChannels();
  contextMenuTicker = window.setInterval(() => {
    if (contextMenu.value.visible && contextMenu.value.activeSubmenu === 'channel') {
      refreshContextSubmenuChannels();
    }
  }, 100);
}

function stopContextMenuTicker() {
  if (contextMenuTicker !== null) {
    clearInterval(contextMenuTicker);
    contextMenuTicker = null;
  }
}

function openChannelSubmenu() {
  const target = contextMenuTargetWidget.value;
  if (!target || !isChannelBindableWidget(target)) return;

  contextMenu.value.activeSubmenu = 'channel';
  startContextMenuTicker();

  // 计算二级级联子菜单位置 (防视口边界溢出)
  const MAIN_MENU_WIDTH = 220;
  const SUBMENU_WIDTH = 270;
  const SUBMENU_HEIGHT = 360;

  // 默认在右侧展开
  let subX = contextMenu.value.x + MAIN_MENU_WIDTH - 2;
  // 若超出屏幕右侧，翻转至左侧展开
  if (subX + SUBMENU_WIDTH > window.innerWidth - 10) {
    subX = Math.max(10, contextMenu.value.x - SUBMENU_WIDTH + 2);
  }

  // 垂直方向对齐二级菜单项高度 (约 y + 42)
  let subY = contextMenu.value.y + 42;
  if (subY + SUBMENU_HEIGHT > window.innerHeight - 10) {
    subY = Math.max(10, window.innerHeight - SUBMENU_HEIGHT - 10);
  }

  contextMenu.value.submenuX = subX;
  contextMenu.value.submenuY = subY;
}

function closeChannelSubmenu() {
  contextMenu.value.activeSubmenu = null;
  stopContextMenuTicker();
}

function closeContextMenu() {
  contextMenu.value.visible = false;
  contextMenu.value.activeSubmenu = null;
  stopContextMenuTicker();
}

function handleSelectSubmenuChannel(chId: string) {
  const target = contextMenuTargetWidget.value;
  if (!target) return;

  bindWidgetChannel(target, chId);
  store.updateWidget(target);
  closeContextMenu();
}

function handleClearSubmenuChannel() {
  const target = contextMenuTargetWidget.value;
  if (!target) return;

  bindWidgetChannel(target, null);
  store.updateWidget(target);
  closeContextMenu();
}

function handleToggleChartChannel(chId: string) {
  const target = contextMenuTargetWidget.value;
  if (!target || target.type !== 'chart') return;

  const meta = store.getChannelMeta(chId);
  toggleChartSeriesChannel(target, chId, meta.color);
  store.updateWidget(target);
  refreshContextSubmenuChannels();
}

function handleClearChartChannels() {
  const target = contextMenuTargetWidget.value;
  if (!target || target.type !== 'chart') return;

  bindWidgetChannel(target, null);
  store.updateWidget(target);
  refreshContextSubmenuChannels();
}

function handleWidgetContextMenu(e: MouseEvent, widget: CanvasWidgetInstance) {
  if (store.isLocked.value) return;
  e.preventDefault();
  store.selectedWidgetId.value = widget.id;
  const def = globalWidgetRegistry.get(widget.type);
  const menuW = 220;
  const menuH = 400;
  const x = Math.max(10, Math.min(e.clientX, window.innerWidth - menuW - 10));
  const y = Math.max(10, Math.min(e.clientY, window.innerHeight - menuH - 10));
  contextMenu.value = {
    visible: true,
    x,
    y,
    widgetId: widget.id,
    widgetTitle: widget.title,
    widgetIcon: def?.icon || '📦',
    activeSubmenu: null,
    submenuX: 0,
    submenuY: 0,
  };
  refreshContextSubmenuChannels();
}

function handleContextMenuAction(action: 'config' | 'duplicate' | 'bringToFront' | 'sendToBack' | 'delete' | 'fill_fullscreen' | 'fill_horizontal' | 'fill_vertical' | 'reset_size') {
  const wid = contextMenu.value.widgetId;
  closeContextMenu();
  if (!wid) return;

  const target = store.activeWidgets.value.find((w) => w.id === wid);

  if (action === 'config') {
    if (target) handleOpenConfig(target);
  } else if (action === 'duplicate') {
    handleDuplicateWidget(wid);
  } else if (action === 'bringToFront') {
    store.bringToFront(wid);
  } else if (action === 'sendToBack') {
    store.sendToBack(wid);
  } else if (action === 'delete') {
    handleDeleteWidget(wid);
  } else if (action === 'fill_fullscreen') {
    const viewport = canvasViewportRef.value;
    if (viewport && target) {
      const snappedW = Math.max(300, snap(viewport.clientWidth - 40, store.gridSize.value));
      const snappedH = Math.max(200, snap(viewport.clientHeight - 40, store.gridSize.value));
      store.updateWidgetGeometry(wid, 20, 20, snappedW, snappedH);
    }
  } else if (action === 'fill_horizontal') {
    const viewport = canvasViewportRef.value;
    if (viewport && target) {
      const snappedW = Math.max(300, snap(viewport.clientWidth - 40, store.gridSize.value));
      store.updateWidgetGeometry(wid, 20, target.y, snappedW, target.h);
    }
  } else if (action === 'fill_vertical') {
    const viewport = canvasViewportRef.value;
    if (viewport && target) {
      const snappedH = Math.max(200, snap(viewport.clientHeight - 40, store.gridSize.value));
      store.updateWidgetGeometry(wid, target.x, 20, target.w, snappedH);
    }
  } else if (action === 'reset_size') {
    if (target) {
      const def = globalWidgetRegistry.get(target.type);
      if (def) {
        store.updateWidgetSize(wid, def.defaultSize.w, def.defaultSize.h);
      }
    }
  }
}

function handleWindowPointerDown(e: MouseEvent) {
  if (contextMenu.value.visible) {
    const el = (e.target as HTMLElement).closest('.vofa-context-menu, .vofa-context-submenu');
    if (!el) {
      closeContextMenu();
    }
  }
}

// 键盘快捷键监听 (Delete/Ctrl+D/Enter/Escape/方向键微调)
function handleGlobalKeyDown(e: KeyboardEvent) {
  if (contextMenu.value.visible) {
    if (e.key === 'Escape') {
      closeContextMenu();
      return;
    }
  }

  // 若配置模态框处于开启态，禁止全局快捷键篡改背景画布控件
  if (isConfigModalOpen.value) return;

  if (store.isLocked.value) return;
  if (!store.selectedWidgetId.value) return;

  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.deleteWidget(store.selectedWidgetId.value);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    store.duplicateWidget(store.selectedWidgetId.value);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = store.activeWidgets.value.find((w) => w.id === store.selectedWidgetId.value);
    if (target) handleOpenConfig(target);
  } else if (e.key === 'Escape') {
    if (store.pointerDragState.value.active) {
      store.cancelPointerDrag();
      dragGhost.value.visible = false;
    }
    store.selectedWidgetId.value = null;
    contextMenu.value.visible = false;
  } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? store.gridSize.value * 2 : store.gridSize.value;
    const target = store.activeWidgets.value.find((w) => w.id === store.selectedWidgetId.value);
    if (target) {
      let nx = target.x;
      let ny = target.y;
      if (e.key === 'ArrowLeft') nx -= step;
      if (e.key === 'ArrowRight') nx += step;
      if (e.key === 'ArrowUp') ny -= step;
      if (e.key === 'ArrowDown') ny += step;
      store.updateWidgetPosition(target.id, nx, ny);
    }
  }
}

onMounted(() => {
  store.loadDashboard();
  store.sendGate.setPortConnected(props.isRunning);
  store.registerDropTarget(handleCanvasPointerDrop);
  window.addEventListener('keydown', handleGlobalKeyDown);
  window.addEventListener('pointerdown', handleWindowPointerDown);

  // The untouched single-waveform view follows its viewport. Once the user
  // enters layout editing, retain their geometry until they explicitly fit it.
  nextTick(() => {
    const fitDefault = () => {
      const tab = store.activeTab.value;
      if (autoFitDefaultView && store.isLocked.value && tab?.id === 'tab_waveform'
        && tab.widgets.length === 1 && tab.widgets[0].type === 'chart') handleFitToViewport();
    };
    fitDefault();
    viewportObserver = new ResizeObserver(fitDefault);
    if (canvasViewportRef.value) viewportObserver.observe(canvasViewportRef.value);
  });
});

watch(() => store.isLocked.value, locked => { if (!locked) autoFitDefaultView = false; });

watch(
  () => props.isRunning,
  (val) => {
    store.sendGate.setPortConnected(val);
  }
);

onUnmounted(() => {
  viewportObserver?.disconnect();
  stopContextMenuTicker();
  store.registerDropTarget(null);
  window.removeEventListener('keydown', handleGlobalKeyDown);
  window.removeEventListener('pointerdown', handleWindowPointerDown);
});

defineExpose({
  addWidgetDirectly,
});
</script>

<template>
  <main class="unified-canvas-workbench">
    <!-- 顶部工作台 Tab 导航栏与工具条 -->
    <header class="workbench-tab-bar">
      <!-- 左侧：多 Tab 列表 -->
      <div class="tabs-scroll-container">
        <div
          v-for="tab in store.dashboardState.value.tabs"
          :key="tab.id"
          class="tab-chip"
          role="tab"
          tabindex="0"
          :aria-selected="store.dashboardState.value.active_tab_id === tab.id"
          :aria-label="tab.name"
          @keydown.enter="store.switchTab(tab.id)"
          @keydown.space.prevent.stop="store.switchTab(tab.id)"
          :class="{ active: store.dashboardState.value.active_tab_id === tab.id }"
          @click="store.switchTab(tab.id)"
        >
          <!-- 内联改名输入框 -->
          <input
            v-if="editingTabId === tab.id"
            v-model="editingTabName"
            type="text"
            class="tab-rename-input"
            autofocus
            @blur="commitRenameTab(tab.id)"
            @keydown.enter="commitRenameTab(tab.id)"
            @keydown.esc="editingTabId = null"
            @click.stop
          />
          <!-- 正常展示标签 -->
          <span
            v-else
            class="tab-name"
            title="双击改名"
            @dblclick.stop="startRenameTab(tab)"
          >
            {{ tab.name }}
          </span>

          <span class="tab-badge">{{ tab.widgets.length }}</span>

          <!-- 关闭 Tab 按钮 -->
          <button
            v-if="store.dashboardState.value.tabs.length > 1"
            class="tab-close-btn"
            title="关闭该工作台"
            @click.stop="handleCloseTab(tab.id, tab.name)"
          >
            ✕
          </button>
        </div>

        <!-- 新建 Tab 按钮 -->
        <button class="btn-new-tab" @click="store.addTab()" title="新建空白工作台">
          <span class="plus-icon">+</span>
          <span>新建 Tab</span>
        </button>
      </div>

      <!-- 右侧：挂锁、网格吸附与自适应工具条 -->
      <div class="canvas-toolbar">
        <!-- 适应视窗按钮 -->
        <button
          class="tool-btn"
          @click="handleFitToViewport"
          title="将当前控件快速自适应拉伸铺满工作区视口"
        >
          <svg class="w-3.5 h-3.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 3 21 3 21 9"></polyline>
            <polyline points="9 21 3 21 3 15"></polyline>
            <line x1="21" y1="3" x2="14" y2="10"></line>
            <line x1="3" y1="21" x2="10" y2="14"></line>
          </svg>
          <span>适应视区</span>
        </button>

        <!-- 网格吸附大小调节 -->
        <div v-if="!store.isLocked.value" class="grid-size-selector">
          <label class="grid-label">网格</label>
          <select
            v-model.number="store.gridSize.value"
            class="grid-select"
            :disabled="store.isLocked.value"
            title="控件拖拽与缩放吸附网格颗粒度"
          >
            <option :value="10">10 px</option>
            <option :value="20">20 px</option>
            <option :value="40">40 px</option>
          </select>
        </div>

        <!-- 运行 / 编辑 挂锁切换大胶囊 -->
        <button
          class="lock-toggle-pill"
          :class="{
            'is-locked': store.isLocked.value,
            'is-unlocked': !store.isLocked.value,
          }"
          @click="store.isLocked.value = !store.isLocked.value"
          :title="store.isLocked.value ? '当前【🔒 运行锁定】状态，点击解锁编辑' : '当前【🔓 编辑自由】状态，点击锁定运行'"
        >
          <span class="lock-icon">{{ store.isLocked.value ? '🔒' : '🔓' }}</span>
          <span class="lock-label">{{ store.isLocked.value ? '编辑布局' : '完成编辑' }}</span>
        </button>
      </div>
    </header>

    <!-- 100% 全自由拖拽画布视口 -->
    <div
      ref="canvasViewportRef"
      class="canvas-viewport"
      @wheel="handleCanvasWheel"
      @click="handleCanvasBgClick"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div
        class="canvas-grid-surface"
        :style="{
          width: `${store.activeTab.value?.canvas_w || 2400}px`,
          height: `${store.activeTab.value?.canvas_h || 1600}px`,
          backgroundSize: `${store.gridSize.value}px ${store.gridSize.value}px`,
          backgroundImage: store.isLocked.value ? 'none' : undefined,
        }"
      >
        <!-- 渲染当前激活 Tab 内的所有控件卡片 -->
        <CanvasWidgetWrapper
          v-for="widget in store.activeWidgets.value"
          :key="widget.id"
          :widget="widget"
          :is-selected="store.selectedWidgetId.value === widget.id"
          :locked="store.isLocked.value"
          :grid-size="store.gridSize.value"
          :canvas-w="store.activeTab.value?.canvas_w || 2400"
          :canvas-h="store.activeTab.value?.canvas_h || 1600"
          :is-connected="props.isRunning"
          @select="(id: string) => store.selectedWidgetId.value = id"
          @update-position="(id: string, x: number, y: number) => store.updateWidgetPosition(id, x, y)"
          @update-size="(id: string, w: number, h: number) => store.updateWidgetSize(id, w, h)"
          @update-geometry="(id: string, x: number, y: number, w: number, h: number) => store.updateWidgetGeometry(id, x, y, w, h)"
          @open-config="(w: CanvasWidgetInstance) => handleOpenConfig(w)"
          @delete="(id: string) => handleDeleteWidget(id)"
          @duplicate="(id: string) => handleDuplicateWidget(id)"
          @context-menu="handleWidgetContextMenu"
        />

        <!-- 拖放落点虚线幽灵框 (VOFA+ 原生交互) -->
        <div
          v-if="dragGhost.visible"
          class="drag-ghost-box"
          :style="{
            left: `${dragGhost.x}px`,
            top: `${dragGhost.y}px`,
            width: `${dragGhost.w}px`,
            height: `${dragGhost.h}px`,
          }"
        >
          <div class="ghost-inner">
            <span class="ghost-icon">{{ globalWidgetRegistry.get(dragGhost.type!)?.icon || '🧩' }}</span>
            <span class="ghost-name">{{ globalWidgetRegistry.get(dragGhost.type!)?.name || '新元器件' }}</span>
            <div class="ghost-meta">
              <span class="ghost-dims">{{ dragGhost.w }} × {{ dragGhost.h }}</span>
              <span class="ghost-coords">({{ dragGhost.x }}, {{ dragGhost.y }})</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VOFA+ 原生风格浮动右键上下文菜单 -->
    <div
      v-if="contextMenu.visible"
      class="vofa-context-menu"
      :style="{
        left: `${contextMenu.x}px`,
        top: `${contextMenu.y}px`,
      }"
      @click.stop
    >
      <div class="menu-header">
        <span class="menu-icon">{{ contextMenu.widgetIcon }}</span>
        <span class="menu-title" :title="contextMenu.widgetTitle">{{ contextMenu.widgetTitle }}</span>
      </div>
      <div class="menu-divider"></div>

      <!-- 📈 绑定通道 -> [当前通道] ▶ 级联菜单项 -->
      <div
        v-if="contextMenuTargetWidget && isChannelBindableWidget(contextMenuTargetWidget)"
        class="menu-item menu-item-has-submenu"
        :class="{ active: contextMenu.activeSubmenu === 'channel' }"
        @mouseenter="openChannelSubmenu"
        @click.stop="contextMenu.activeSubmenu === 'channel' ? closeChannelSubmenu() : openChannelSubmenu()"
      >
        <span class="item-icon">📈</span>
        <span class="item-label">绑定通道</span>
        <span class="item-arrow-divider">-&gt;</span>
        <span class="item-binding-badge font-mono" :title="currentBindingDisplay">
          {{ currentBindingDisplay }}
        </span>
        <span class="item-arrow">▶</span>
      </div>

      <div
        v-if="contextMenuTargetWidget && isChannelBindableWidget(contextMenuTargetWidget)"
        class="menu-divider"
      ></div>

      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('config')">
        <span class="item-icon">⚙️</span>
        <span class="item-label">配置属性</span>
        <kbd class="item-shortcut">Enter</kbd>
      </button>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('duplicate')">
        <span class="item-icon">📋</span>
        <span class="item-label">快速克隆</span>
        <kbd class="item-shortcut">Ctrl+D</kbd>
      </button>
      <div class="menu-divider"></div>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('fill_fullscreen')">
        <span class="item-icon">⛶</span>
        <span class="item-label">全屏填充视区</span>
      </button>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('fill_horizontal')">
        <span class="item-icon">↔️</span>
        <span class="item-label">横向撑满</span>
      </button>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('fill_vertical')">
        <span class="item-icon">↕️</span>
        <span class="item-label">纵向撑满</span>
      </button>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('reset_size')">
        <span class="item-icon">↩️</span>
        <span class="item-label">恢复默认尺寸</span>
      </button>
      <div class="menu-divider"></div>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('bringToFront')">
        <span class="item-icon">⬆️</span>
        <span class="item-label">置于顶层</span>
      </button>
      <button class="menu-item" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('sendToBack')">
        <span class="item-icon">⬇️</span>
        <span class="item-label">置于底层</span>
      </button>
      <div class="menu-divider"></div>
      <button class="menu-item item-danger" @mouseenter="closeChannelSubmenu" @click="handleContextMenuAction('delete')">
        <span class="item-icon">🗑️</span>
        <span class="item-label">删除控件</span>
        <kbd class="item-shortcut">Del</kbd>
      </button>
    </div>

    <!-- VOFA+ 原生风格二级级联子菜单 (绑定通道) -->
    <div
      v-if="contextMenu.visible && contextMenu.activeSubmenu === 'channel' && contextMenuTargetWidget"
      class="vofa-context-submenu"
      :style="{
        left: `${contextMenu.submenuX}px`,
        top: `${contextMenu.submenuY}px`,
      }"
      @click.stop
    >
      <div class="submenu-header">
        <span class="submenu-title">
          {{ contextMenuTargetWidget.type === 'chart' ? '📈 勾选波形通道 (多选)' : '📈 选择绑定通道' }}
        </span>
        <span class="submenu-count font-mono">{{ contextSubmenuChannels.length }} 个</span>
      </div>
      <div class="menu-divider"></div>

      <div class="submenu-scroll-list">
        <!-- 单值控件提供首项：清除绑定 -->
        <button
          v-if="contextMenuTargetWidget.type !== 'chart'"
          class="submenu-item item-clear"
          :class="{ selected: !getWidgetBoundChannel(contextMenuTargetWidget) }"
          @click="handleClearSubmenuChannel"
        >
          <span class="item-icon">🚫</span>
          <span class="item-name">未绑定 / 清除绑定</span>
          <span
            v-if="!getWidgetBoundChannel(contextMenuTargetWidget)"
            class="item-radio-mark"
          >
            ●
          </span>
        </button>

        <!-- 多通道控件 (波形图) 提供首项：一键清空曲线 -->
        <button
          v-else
          class="submenu-item item-clear"
          @click="handleClearChartChannels"
        >
          <span class="item-icon">🚫</span>
          <span class="item-name">清空全部波形曲线</span>
        </button>

        <div class="submenu-divider"></div>

        <!-- 通道项列表 -->
        <button
          v-for="ch in contextSubmenuChannels"
          :key="ch.id"
          class="submenu-item"
          :class="{
            selected:
              contextMenuTargetWidget.type === 'chart'
                ? isChannelInChartSeries(contextMenuTargetWidget, ch.id).visible
                : getWidgetBoundChannel(contextMenuTargetWidget) === ch.id,
            active: ch.isActive,
          }"
          @click="
            contextMenuTargetWidget.type === 'chart'
              ? handleToggleChartChannel(ch.id)
              : handleSelectSubmenuChannel(ch.id)
          "
        >
          <!-- 波形图：显示复选框 (☑️ / ⬜) -->
          <span
            v-if="contextMenuTargetWidget.type === 'chart'"
            class="item-checkbox"
          >
            {{ isChannelInChartSeries(contextMenuTargetWidget, ch.id).visible ? '☑️' : '⬜' }}
          </span>

          <!-- 通道颜色圆点 -->
          <span class="channel-dot" :style="{ backgroundColor: ch.color }"></span>

          <!-- 通道标识与别名 -->
          <span class="channel-id font-mono">{{ ch.id }}</span>
          <span v-if="ch.name && ch.name !== ch.id" class="channel-alias">
            ({{ ch.name }})
          </span>

          <!-- 右侧：6 位高精浮点实时值与微动效 -->
          <div class="item-right-meta">
            <span class="channel-realtime-val font-mono" :class="{ 'is-live': ch.isActive }">
              {{ ch.formattedValue }}
            </span>
            <span v-if="ch.isActive" class="pulse-indicator" title="数据流入中"></span>

            <!-- 单值控件：单选高亮圆点 -->
            <span
              v-if="contextMenuTargetWidget.type !== 'chart' && getWidgetBoundChannel(contextMenuTargetWidget) === ch.id"
              class="item-radio-mark"
            >
              ●
            </span>
          </div>
        </button>
      </div>
    </div>

    <!-- 控件参数配置模态弹窗 -->
    <CanvasWidgetConfigModal
      v-if="isConfigModalOpen && editingWidget"
      :is-open="isConfigModalOpen && Boolean(editingWidget)"
      :widget="editingWidget"
      @close="isConfigModalOpen = false"
      @save="handleSaveConfig"
    />
  </main>
</template>

<style scoped>
.unified-canvas-workbench {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-base, #1F1E1D);
  position: relative;
  overflow: hidden;
  transition: background-color 0.25s ease;
}

.workbench-tab-bar {
  height: 38px;
  background: var(--bg-surface, #272623);
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  user-select: none;
  z-index: 20;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

.tabs-scroll-container {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  max-width: 70%;
}

.tab-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.tab-chip:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
  border-color: var(--border-strong, #4A4843);
}

.tab-chip.active {
  background: var(--bg-surface, #272623);
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  box-shadow: 0 0 8px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.2));
}

.tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-rename-input {
  width: 90px;
  height: 20px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 3px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  padding: 0 4px;
  outline: none;
}

.tab-badge {
  font-size: 9px;
  color: var(--text-soft, #706E66);
  background: var(--bg-surface, #272623);
  padding: 0 4px;
  border-radius: 9999px;
  font-family: monospace;
}

.tab-chip.active .tab-badge {
  color: var(--accent-terracotta, #DA7756);
}

.tab-close-btn {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 3px;
}

.tab-close-btn:hover {
  color: #E06D85;
  background: rgba(224, 109, 133, 0.15);
}

.btn-new-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  background: transparent;
  border: 1px dashed var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-new-tab:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.canvas-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  background: var(--bg-surface, #272623);
}

.tool-btn svg {
  width: 13px;
  height: 13px;
  min-width: 13px;
  min-height: 13px;
  flex-shrink: 0;
}

.grid-size-selector {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 0 6px;
  height: 24px;
}

.grid-label {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

.grid-select {
  background: transparent;
  border: none;
  color: var(--text-main, #ECEAE4);
  font-size: 10px;
  outline: none;
  cursor: pointer;
}

.lock-toggle-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.lock-toggle-pill.is-locked {
  background: rgba(229, 158, 56, 0.12);
  border: 1px solid rgba(229, 158, 56, 0.4);
  color: #E59E38;
}

.lock-toggle-pill.is-locked:hover {
  background: rgba(229, 158, 56, 0.22);
  border-color: #E59E38;
}

.lock-toggle-pill.is-unlocked {
  background: rgba(122, 168, 155, 0.15);
  border: 1px solid rgba(122, 168, 155, 0.4);
  color: #7AA89B;
}

.lock-toggle-pill.is-unlocked:hover {
  background: rgba(122, 168, 155, 0.25);
  border-color: #7AA89B;
}

.canvas-viewport {
  flex: 1;
  overflow: auto;
  position: relative;
  background: var(--bg-base, #1F1E1D);
  transition: background-color 0.25s ease;
}

.canvas-grid-surface {
  position: relative;
  background-image: radial-gradient(circle, var(--grid-line, rgba(236, 234, 228, 0.06)) 1px, transparent 1px);
  min-width: 100%;
  min-height: 100%;
}

.drag-ghost-box {
  position: absolute;
  pointer-events: none;
  border: 2px dashed var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  box-shadow: 0 0 16px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25));
}

.ghost-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--accent-terracotta, #DA7756);
}

.ghost-icon {
  font-size: 24px;
}

.ghost-name {
  font-size: 12px;
  font-weight: 600;
}

.ghost-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.ghost-dims {
  font-size: 10px;
  font-family: monospace;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border: 1px solid var(--accent-terracotta, #DA7756);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--accent-terracotta, #DA7756);
  font-weight: 600;
}

.ghost-coords {
  font-size: 10px;
  font-family: monospace;
  opacity: 0.85;
  color: var(--text-muted, #9E9C94);
}

/* VOFA+ 原生右键菜单 */
.vofa-context-menu {
  position: fixed;
  z-index: 1000;
  width: 190px;
  background: var(--bg-surface, #272623);
  backdrop-filter: blur(12px);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  box-shadow: var(--card-shadow, 0 10px 25px -5px rgba(0, 0, 0, 0.45));
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  user-select: none;
  animation: contextMenuFadeIn 0.12s ease-out;
}

@keyframes contextMenuFadeIn {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(-2px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.menu-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px 8px;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle, #383633);
  margin-bottom: 2px;
}

.menu-header .menu-icon {
  font-size: 13px;
}

.menu-header .menu-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-main, #ECEAE4);
}

.menu-divider {
  height: 1px;
  background: var(--border-subtle, #383633);
  margin: 3px 0;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: all 0.12s ease;
  width: 100%;
}

.menu-item:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
}

.menu-item .item-icon {
  font-size: 12px;
  width: 16px;
  text-align: center;
  flex-shrink: 0;
}

.menu-item .item-label {
  flex: 1;
  white-space: nowrap;
}

.menu-item .item-shortcut {
  font-size: 9px;
  font-family: monospace;
  color: var(--text-soft, #706E66);
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  padding: 1px 4px;
  border-radius: 3px;
}

.menu-item:hover .item-shortcut {
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

.menu-item.item-danger:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.menu-item.item-danger:hover .item-shortcut {
  color: #f87171;
  border-color: rgba(239, 68, 68, 0.4);
}

/* 级联二级菜单支持 */
.menu-item-has-submenu {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  position: relative;
}

.menu-item-has-submenu:hover,
.menu-item-has-submenu.active {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
}

.item-arrow-divider {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  margin: 0 1px;
  user-select: none;
}

.item-binding-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  border: 1px solid var(--accent-terracotta, #DA7756);
  padding: 1px 6px;
  border-radius: 3px;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
}

.item-arrow {
  font-size: 9px;
  color: var(--text-muted, #9E9C94);
  margin-left: 2px;
}

/* VOFA+ 原生风格二级级联浮动子菜单 */
.vofa-context-submenu {
  position: fixed;
  z-index: 1005;
  width: 270px;
  background: var(--bg-surface, #272623);
  backdrop-filter: blur(14px);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  box-shadow: var(--card-shadow, 0 14px 32px rgba(0, 0, 0, 0.4));
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  user-select: none;
  animation: contextMenuFadeIn 0.12s ease-out;
}

.submenu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.submenu-title {
  color: var(--text-main, #ECEAE4);
}

.submenu-count {
  font-size: 10px;
  color: var(--text-soft, #706E66);
}

.submenu-scroll-list {
  max-height: 280px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-right: 2px;
}

.submenu-scroll-list::-webkit-scrollbar {
  width: 4px;
}

.submenu-scroll-list::-webkit-scrollbar-thumb {
  background-color: var(--border-subtle, #383633);
  border-radius: 2px;
}

.submenu-divider {
  height: 1px;
  background: var(--border-subtle, #383633);
  margin: 3px 0;
}

.submenu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
  transition: all 0.1s ease;
  width: 100%;
}

.submenu-item:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
}

.submenu-item.selected {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.14));
}

.submenu-item.item-clear {
  color: var(--text-muted, #9E9C94);
}

.submenu-item.item-clear:hover {
  color: #f87171;
  background: rgba(239, 68, 68, 0.12);
}

.item-checkbox {
  font-size: 12px;
  line-height: 1;
}

.channel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.channel-id {
  font-weight: 700;
  color: var(--accent-terracotta, #DA7756);
  font-size: 12px;
}

.channel-alias {
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-right-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.channel-realtime-val {
  font-size: 11px;
  color: var(--text-soft, #706E66);
}

.channel-realtime-val.is-live {
  color: #7AA89B;
  font-weight: 600;
}

.pulse-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #7AA89B;
  box-shadow: 0 0 6px #7AA89B;
  animation: pulseLight 1.5s infinite;
}

.item-radio-mark {
  color: var(--accent-terracotta, #DA7756);
  font-size: 11px;
}
</style>
