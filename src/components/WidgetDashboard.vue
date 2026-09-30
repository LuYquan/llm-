<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue';
import { useWidgetStore, createNewWidget } from '../stores/widgetStore';
import type { CanvasWidgetInstance, WidgetType, GridSize } from '../types/widget';
import { WIDGET_DEFAULT_SIZES } from '../types/widget';
import { globalWidgetRegistry } from '../core/widget/registry';
import { clientToCanvas } from '../utils/grid';
import CanvasWidgetWrapper from './widgets/CanvasWidgetWrapper.vue';
import CanvasWidgetConfigModal from './widgets/CanvasWidgetConfigModal.vue';

const props = defineProps<{
  isRunning: boolean;
}>();

defineEmits<{
  (e: 'open-serial-request'): void;
}>();

const store = useWidgetStore();

// 画布视口 DOM 引用
const canvasViewportRef = ref<HTMLElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// 配置弹窗状态
const isConfigModalOpen = ref(false);
const editingWidget = ref<CanvasWidgetInstance | null>(null);

// Tab 重命名状态
const editingTabId = ref<string | null>(null);
const editingTabName = ref('');

// ==================== 从左侧 Palette 拖拽元器件到画布 ====================
interface DragState {
  isDragging: boolean;
  type: WidgetType | null;
  pointerX: number;
  pointerY: number;
  // 幽灵预览框在画布中的坐标与尺寸
  ghostVisible: boolean;
  ghostX: number;
  ghostY: number;
  ghostW: number;
  ghostH: number;
}

const dragState = ref<DragState>({
  isDragging: false,
  type: null,
  pointerX: 0,
  pointerY: 0,
  ghostVisible: false,
  ghostX: 0,
  ghostY: 0,
  ghostW: 0,
  ghostH: 0,
});

let dragStartPos = { x: 0, y: 0 };
let pendingDragType: WidgetType | null = null;

// 元器件库卡片列表 (从注册表动态拉取所有 9 大元器件)
const paletteWidgets = computed(() => {
  return globalWidgetRegistry.list().map((def) => ({
    type: def.type,
    name: def.name,
    icon: def.icon,
    desc: def.desc,
    size: `${def.defaultSize.w} × ${def.defaultSize.h}`,
    category: def.category,
  }));
});

// JSON 导入导出
function triggerImport() {
  fileInputRef.value?.click();
}

function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target?.result as string;
    if (text) {
      const res = store.importDashboardJson(text);
      if (res.ok) {
        alert('工作台配置导入成功！');
      } else {
        alert(`导入失败: ${res.error}`);
      }
    }
    target.value = '';
  };
  reader.readAsText(file);
}

function handleExport() {
  const jsonStr = store.exportDashboardJson();
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `vofa_dashboard_${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

onMounted(() => {
  store.loadDashboard();
  store.sendGate.setPortConnected(props.isRunning);
});

watch(
  () => props.isRunning,
  (val) => {
    store.sendGate.setPortConnected(val);
  }
);

// ==================== Pointer Events 拖拽发起 ====================
function onPalettePointerDown(e: PointerEvent, type: WidgetType) {
  if (store.isLocked.value) return; // 锁定态禁止拖拽

  pendingDragType = type;
  dragStartPos = { x: e.clientX, y: e.clientY };

  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
}

function onPalettePointerMove(e: PointerEvent) {
  if (!pendingDragType) return;

  const dx = e.clientX - dragStartPos.x;
  const dy = e.clientY - dragStartPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // 移动超过 4px 才激活拖拽
  if (!dragState.value.isDragging && dist > 4) {
    const size = WIDGET_DEFAULT_SIZES[pendingDragType];
    dragState.value = {
      isDragging: true,
      type: pendingDragType,
      pointerX: e.clientX,
      pointerY: e.clientY,
      ghostVisible: false,
      ghostX: 0,
      ghostY: 0,
      ghostW: size.w,
      ghostH: size.h,
    };
  }

  if (dragState.value.isDragging) {
    dragState.value.pointerX = e.clientX;
    dragState.value.pointerY = e.clientY;

    // 检查光标是否在画布视口内
    const viewport = canvasViewportRef.value;
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      const inCanvas =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (inCanvas) {
        const size = WIDGET_DEFAULT_SIZES[dragState.value.type!];
        // 计算吸附后的落点
        const canvasCoords = clientToCanvas(
          e.clientX,
          e.clientY,
          rect,
          viewport.scrollLeft,
          viewport.scrollTop,
          size.w / 2, // 抓取中心偏移
          size.h / 2,
          store.gridSize.value
        );

        dragState.value.ghostVisible = true;
        dragState.value.ghostX = canvasCoords.x;
        dragState.value.ghostY = canvasCoords.y;
      } else {
        dragState.value.ghostVisible = false;
      }
    }
  }
}

function onPalettePointerUp(e: PointerEvent) {
  if (!pendingDragType) return;

  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {}

  if (dragState.value.isDragging && dragState.value.ghostVisible && dragState.value.type) {
    // 成功落入画布，创建新控件
    const newWidget = createNewWidget(
      dragState.value.type,
      dragState.value.ghostX,
      dragState.value.ghostY
    );
    store.addWidget(newWidget);
  }

  // 重置拖拽状态
  pendingDragType = null;
  dragState.value = {
    isDragging: false,
    type: null,
    pointerX: 0,
    pointerY: 0,
    ghostVisible: false,
    ghostX: 0,
    ghostY: 0,
    ghostW: 0,
    ghostH: 0,
  };
}

// ==================== 画布滚轮横移与背景点击 ====================
function handleCanvasWheel(e: WheelEvent) {
  const viewport = canvasViewportRef.value;
  if (!viewport) return;

  // Shift + 滚轮横向平移
  if (e.shiftKey && e.deltaY !== 0) {
    e.preventDefault();
    viewport.scrollLeft += e.deltaY;
  }
}

function handleCanvasBgClick(e: MouseEvent) {
  if (e.target === canvasViewportRef.value || (e.target as HTMLElement).classList.contains('canvas-grid-surface')) {
    store.selectedWidgetId.value = null;
  }
}

// ==================== Tab 操作 ====================
function startRenameTab(tab: { id: string; name: string }) {
  editingTabId.value = tab.id;
  editingTabName.value = tab.name;
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

// 键盘快捷键监听 (Delete 删除，Ctrl+D 复制)
function handleGlobalKeyDown(e: KeyboardEvent) {
  if (store.isLocked.value) return; // 锁定态不触发编辑快捷键
  if (!store.selectedWidgetId.value) return;

  // 如果当前焦点在输入框中，不拦截快捷键
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.deleteWidget(store.selectedWidgetId.value);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    store.duplicateWidget(store.selectedWidgetId.value);
  }
}

function handleResetPreset() {
  if (confirm('确定要重置当前工作台为官方默认预设吗？这会覆盖当前所有控件。')) {
    store.resetToDefault();
  }
}
</script>

<template>
  <div class="vofa-workbench" @keydown="handleGlobalKeyDown" tabindex="-1">
    <!-- ================= 顶部综合栏 (Tabs & 挂锁工具条) ================= -->
    <header class="workbench-topbar">
      <!-- 多工作台 Tab 列表 -->
      <div class="tabs-container">
        <div
          v-for="tab in store.dashboardState.value.tabs"
          :key="tab.id"
          class="tab-item"
          :class="{ 'is-active': tab.id === store.dashboardState.value.active_tab_id }"
          @click="store.switchTab(tab.id)"
          @dblclick="startRenameTab(tab)"
        >
          <template v-if="editingTabId === tab.id">
            <input
              type="text"
              class="tab-rename-input"
              v-model="editingTabName"
              @blur="commitRenameTab(tab.id)"
              @keydown.enter="commitRenameTab(tab.id)"
              @keydown.esc="editingTabId = null"
              autofocus
            />
          </template>
          <template v-else>
            <span class="tab-title">{{ tab.name }}</span>
            <span class="tab-count">({{ tab.widgets.length }})</span>
            <button
              v-if="store.dashboardState.value.tabs.length > 1"
              class="btn-tab-close"
              title="关闭标签页"
              @click.stop="handleCloseTab(tab.id, tab.name)"
            >
              ✕
            </button>
          </template>
        </div>

        <!-- 新建 Tab 按钮 -->
        <button class="btn-add-tab" title="新建工作台标签页" @click="store.addTab()">
          +
        </button>
      </div>

      <!-- 右侧工作台工具栏 -->
      <div class="toolbar-actions">
        <!-- 网格步长切换 -->
        <div class="grid-size-selector" title="画布网格吸附步长">
          <span class="label">网格:</span>
          <button
            v-for="sz in [10, 20, 40]"
            :key="sz"
            class="btn-grid-opt"
            :class="{ 'is-selected': store.gridSize.value === sz }"
            @click="store.gridSize.value = (sz as GridSize)"
          >
            {{ sz }}px
          </button>
        </div>

        <!-- 导入/导出配置 -->
        <input
          ref="fileInputRef"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="handleFileChange"
        />
        <button class="btn-tool-outline" title="从 JSON 文件导入工作台配置" @click="triggerImport">
          📥 导入
        </button>
        <button class="btn-tool-outline" title="将当前所有工作台导出为 JSON 文件" @click="handleExport">
          📤 导出
        </button>

        <!-- 重置默认预设 -->
        <button class="btn-tool-outline" title="重置工作台为默认预设" @click="handleResetPreset">
          ↺ 默认预设
        </button>

        <!-- 核心挂锁切换开关 (🔒 锁定运行 / 🔓 解锁编辑) -->
        <button
          class="btn-lock-toggle"
          :class="store.isLocked.value ? 'lock-active' : 'edit-active'"
          :title="store.isLocked.value ? '当前已锁定运行 (控件可下发，禁止拖拽平移)；点击解锁' : '当前处于编辑态 (可拖拽调整，禁止下发)；点击锁定运行'"
          @click="store.isLocked.value = !store.isLocked.value"
        >
          <span class="lock-icon">{{ store.isLocked.value ? '🔒' : '🔓' }}</span>
          <span class="lock-text">{{ store.isLocked.value ? '运行锁定' : '编辑中' }}</span>
        </button>
      </div>
    </header>

    <!-- ================= 下方主工作区 (左侧 Palette + 右侧 Canvas) ================= -->
    <div class="workbench-main">
      <!-- 1. 左侧控件库 (Widget Palette) -->
      <aside class="widget-palette" :class="{ 'is-locked-palette': store.isLocked.value }">
        <div class="palette-header">
          <span class="palette-title">控件库</span>
          <span class="palette-tip">{{ store.isLocked.value ? '🔒 已锁定' : '按住拖入画布' }}</span>
        </div>

        <div class="palette-list">
          <div
            v-for="w in paletteWidgets"
            :key="w.type"
            class="palette-card"
            :class="{ 'card-disabled': store.isLocked.value }"
            :title="store.isLocked.value ? '工作台已锁定运行，请先点击右上角挂锁解锁' : `按住拖入画布 (${w.size})`"
            @pointerdown="(e) => onPalettePointerDown(e, w.type)"
            @pointermove="onPalettePointerMove"
            @pointerup="onPalettePointerUp"
            @pointercancel="onPalettePointerUp"
          >
            <div class="card-icon">{{ w.icon }}</div>
            <div class="card-info">
              <div class="card-name">{{ w.name }}</div>
              <div class="card-desc">{{ w.desc }}</div>
              <div class="card-size">{{ w.size }}</div>
            </div>
          </div>
        </div>

        <!-- 锁定状态下的醒目指引提示 -->
        <div class="locked-mask-hint" v-if="store.isLocked.value">
          <span class="mask-icon">🔒</span>
          <span class="mask-txt">工作台处于运行保护态</span>
          <span class="mask-sub">按键与滑块已启用<br />点击右上角挂锁可编辑排布</span>
        </div>
      </aside>

      <!-- 2. 右侧自由网格画布视区 (Free Canvas Viewport) -->
      <main
        class="canvas-viewport"
        ref="canvasViewportRef"
        @wheel="handleCanvasWheel"
        @click="handleCanvasBgClick"
      >
        <div
          class="canvas-grid-surface"
          :style="{
            width: `${store.activeTab.value?.canvas_w || 2400}px`,
            height: `${store.activeTab.value?.canvas_h || 1600}px`,
            backgroundSize: `${store.gridSize.value}px ${store.gridSize.value}px`,
          }"
        >
          <!-- 渲染当前 Tab 的所有控件卡片 -->
          <CanvasWidgetWrapper
            v-for="widget in store.activeWidgets.value"
            :key="widget.id"
            :widget="widget"
            :locked="store.isLocked.value"
            :isSelected="store.selectedWidgetId.value === widget.id"
            :gridSize="store.gridSize.value"
            :canvasW="store.activeTab.value?.canvas_w || 2400"
            :canvasH="store.activeTab.value?.canvas_h || 1600"
            :isConnected="isRunning"
            :tabId="store.activeTab.value?.id"
            @select="(id) => store.bringToFront(id)"
            @update-position="(id, x, y) => store.updateWidgetPosition(id, x, y)"
            @update-size="(id, w, h) => store.updateWidgetSize(id, w, h)"
            @open-config="handleOpenConfig"
            @delete="handleDeleteWidget"
            @duplicate="handleDuplicateWidget"
          />

          <!-- 拖拽中的幽灵预览框 (Ghost Box) -->
          <div
            class="ghost-box"
            v-if="dragState.isDragging && dragState.ghostVisible"
            :style="{
              left: `${dragState.ghostX}px`,
              top: `${dragState.ghostY}px`,
              width: `${dragState.ghostW}px`,
              height: `${dragState.ghostH}px`,
            }"
          >
            <div class="ghost-inner">
              <span class="ghost-badge">放置在 ({{ dragState.ghostX }}, {{ dragState.ghostY }})</span>
            </div>
          </div>
        </div>
      </main>
    </div>

    <!-- 跟随鼠标光标的半透明投影 (微缩抓手跟随) -->
    <div
      class="drag-cursor-proxy"
      v-if="dragState.isDragging"
      :style="{
        left: `${dragState.pointerX}px`,
        top: `${dragState.pointerY}px`,
      }"
    >
      <div class="proxy-badge">
        <span>📦 {{ dragState.type }}</span>
      </div>
    </div>

    <!-- 属性配置模态框 -->
    <CanvasWidgetConfigModal
      :isOpen="isConfigModalOpen"
      :widget="editingWidget"
      @close="isConfigModalOpen = false"
      @save="handleSaveConfig"
    />
  </div>
</template>

<style scoped>
.vofa-workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--bg-base, #1F1E1D);
  color: var(--text-main, #ECEAE4);
  overflow: hidden;
  user-select: none;
  position: relative;
  outline: none;
}

/* ================= 顶部综合栏 ================= */
.workbench-topbar {
  height: 44px;
  min-height: 44px;
  background: var(--bg-surface, #272623);
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  box-sizing: border-box;
}

.tabs-container {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 100%;
  overflow-x: auto;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px 6px 0 0;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid transparent;
  border-bottom: none;
  font-size: 13px;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  transition: all 0.15s ease;
  height: 32px;
  box-sizing: border-box;
}

.tab-item:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.tab-item.is-active {
  background: var(--bg-surface, #272623);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--border-subtle, #383633);
  font-weight: 600;
}

.tab-title {
  white-space: nowrap;
}

.tab-count {
  font-size: 10px;
  opacity: 0.6;
}

.btn-tab-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
}

.btn-tab-close:hover {
  background: #dc2626;
  color: white;
}

.tab-rename-input {
  width: 90px;
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: var(--text-main, #ECEAE4);
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 3px;
  outline: none;
}

.btn-add-tab {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px dashed var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 16px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.btn-add-tab:hover {
  background: var(--bg-surface, #272623);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.grid-size-selector {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-elevated, #2F2E2A);
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle, #383633);
}

.grid-size-selector .label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.btn-grid-opt {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-grid-opt.is-selected {
  background: var(--accent-terracotta, #DA7756);
  color: white;
  font-weight: 600;
}

.btn-tool-outline {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-main, #ECEAE4);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.btn-tool-outline:hover {
  background: var(--border-subtle, #383633);
  border-color: var(--border-strong, #4A4843);
}

/* 核心挂锁切换大按钮 */
.btn-lock-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s ease;
}

.btn-lock-toggle.edit-active {
  background: linear-gradient(180deg, #ea580c 0%, #c2410c 100%);
  color: #fff;
  border-color: #f97316;
  box-shadow: 0 0 12px rgba(249, 115, 22, 0.4);
}

.btn-lock-toggle.edit-active:hover {
  background: linear-gradient(180deg, #f97316 0%, #ea580c 100%);
}

.btn-lock-toggle.lock-active {
  background: linear-gradient(180deg, #059669 0%, #047857 100%);
  color: #fff;
  border-color: #10b981;
  box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
}

.btn-lock-toggle.lock-active:hover {
  background: linear-gradient(180deg, #10b981 0%, #059669 100%);
}

/* ================= 下方主工作区 ================= */
.workbench-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* 1. 左侧控件库 (Widget Palette) */
.widget-palette {
  width: 220px;
  min-width: 220px;
  background: var(--bg-surface, #272623);
  border-right: 1px solid var(--border-subtle, #383633);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow-y: auto;
  box-sizing: border-box;
}

.widget-palette.is-locked-palette {
  filter: grayscale(40%);
}

.palette-header {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.palette-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-main, #ECEAE4);
}

.palette-tip {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

.palette-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.palette-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: all 0.15s ease;
}

.palette-card:hover:not(.card-disabled) {
  border-color: var(--accent-terracotta, #DA7756);
  background: var(--bg-surface, #272623);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(218, 119, 86, 0.15);
}

.palette-card:active:not(.card-disabled) {
  cursor: grabbing;
}

.palette-card.card-disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.card-icon {
  font-size: 24px;
  line-height: 1;
}

.card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.card-desc {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-size {
  font-size: 9px;
  color: var(--text-soft, #706E66);
  font-family: monospace;
}

/* 锁定遮罩提示 */
.locked-mask-hint {
  position: absolute;
  bottom: 16px;
  left: 12px;
  right: 12px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 4px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
}

.mask-icon {
  font-size: 20px;
}

.mask-txt {
  font-size: 12px;
  font-weight: bold;
  color: var(--accent-terracotta, #DA7756);
}

.mask-sub {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  line-height: 1.4;
}

/* 2. 右侧自由网格画布视区 */
.canvas-viewport {
  flex: 1;
  position: relative;
  overflow: auto;
  background: var(--bg-base, #1F1E1D);
}

/* 网格背景图层 */
.canvas-grid-surface {
  position: relative;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
}

/* 拖拽幽灵框 (Ghost Box) */
.ghost-box {
  position: absolute;
  border: 2px dashed var(--accent-terracotta, #DA7756);
  background: rgba(218, 119, 86, 0.12);
  border-radius: 8px;
  pointer-events: none;
  z-index: 999;
  box-sizing: border-box;
}

.ghost-inner {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ghost-badge {
  background: var(--bg-surface, #272623);
  color: var(--accent-terracotta, #DA7756);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--accent-terracotta, #DA7756);
}

/* 跟随鼠标的光标投影代理 */
.drag-cursor-proxy {
  position: fixed;
  pointer-events: none;
  z-index: 9999;
  transform: translate(12px, 12px);
}

.proxy-badge {
  background: rgba(14, 165, 233, 0.9);
  color: white;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
}
</style>
