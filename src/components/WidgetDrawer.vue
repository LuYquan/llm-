<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { globalWidgetRegistry, type WidgetCategory } from '../core/widget/registry';
import type { WidgetType } from '../types/widget';
import { useWidgetStore } from '../stores/widgetStore';

const props = defineProps<{
  isOpen: boolean;
  isLocked: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const store = useWidgetStore();
const searchQuery = ref('');
const activeCategory = ref<'all' | WidgetCategory>('all');

const categoryTabs: { key: 'all' | WidgetCategory; label: string; icon: string }[] = [
  { key: 'all', label: '全部', icon: '🌟' },
  { key: 'chart', label: '波形', icon: '📈' },
  { key: 'display', label: '显示', icon: '🧭' },
  { key: 'control', label: '控制', icon: '🎛️' },
  { key: 'analysis', label: '分析', icon: '📊' },
];

const allWidgets = computed(() => {
  return globalWidgetRegistry.list().map((w) => ({
    type: w.type,
    name: w.name,
    category: w.category,
    icon: w.icon,
    desc: w.desc,
    defaultW: w.defaultSize.w,
    defaultH: w.defaultSize.h,
    size: `${w.defaultSize.w} × ${w.defaultSize.h}`,
    minSize: `${w.defaultSize.min_w} × ${w.defaultSize.min_h}`,
  }));
});

const filteredWidgets = computed(() => {
  let list = allWidgets.value;
  if (activeCategory.value !== 'all') {
    list = list.filter((w) => w.category === activeCategory.value);
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    list = list.filter((w) => w.name.toLowerCase().includes(q) || w.desc.toLowerCase().includes(q));
  }
  return list;
});

// 指针级无感即拖即拽发起 (VOFA+ 原生交互)
function handleCardPointerDown(
  e: PointerEvent,
  widget: {
    type: WidgetType;
    name: string;
    icon: string;
    size: string;
    defaultW: number;
    defaultH: number;
  }
) {
  if (props.isLocked) return;
  // 仅限鼠标主按键（左键）
  if (e.button !== 0) return;

  const startX = e.clientX;
  const startY = e.clientY;
  let isDragging = false;

  const cleanup = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('blur', onBlur);
    if (typeof document !== 'undefined') {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  const onPointerMove = (moveEv: PointerEvent) => {
    const dx = moveEv.clientX - startX;
    const dy = moveEv.clientY - startY;
    if (!isDragging) {
      // 位移超过 4px 无感唤醒全局 1:1 投影拖拽
      if (Math.hypot(dx, dy) >= 4) {
        isDragging = true;
        if (typeof document !== 'undefined') {
          document.body.style.cursor = 'grabbing';
          document.body.style.userSelect = 'none';
        }
        store.startPointerDrag({
          widgetType: widget.type,
          pointerX: moveEv.clientX,
          pointerY: moveEv.clientY,
          previewW: widget.defaultW,
          previewH: widget.defaultH,
          icon: widget.icon,
          name: widget.name,
        });
      }
    } else {
      moveEv.preventDefault();
      store.updatePointerDrag(moveEv.clientX, moveEv.clientY);
    }
  };

  const onPointerUp = (upEv: PointerEvent) => {
    cleanup();
    if (isDragging) {
      store.endPointerDrag(upEv.clientX, upEv.clientY);
    }
  };

  const onPointerCancel = () => {
    cleanup();
    if (isDragging) {
      store.cancelPointerDrag();
    }
  };

  const onKeyDown = (keyEv: KeyboardEvent) => {
    if (keyEv.key === 'Escape') {
      cleanup();
      if (isDragging) {
        store.cancelPointerDrag();
      }
    }
  };

  const onBlur = () => {
    cleanup();
    if (isDragging) {
      store.cancelPointerDrag();
    }
  };

  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('blur', onBlur);
}

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
});
</script>

<template>
  <aside v-if="props.isOpen" class="widget-drawer">
    <!-- 抽屉头部 -->
    <header class="drawer-header">
      <div class="header-title">
        <svg class="w-4 h-4 text-sky-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
          <line x1="12" y1="22.08" x2="12" y2="12"></line>
        </svg>
        <span>元器件仓库</span>
        <span class="count-tag">{{ filteredWidgets.length }}</span>
      </div>
      <button class="btn-close" @click="emit('close')" title="收起抽屉">✕</button>
    </header>

    <!-- 挂锁告警提示 -->
    <div v-if="props.isLocked" class="lock-banner">
      <span class="lock-icon">🔒</span>
      <div class="lock-text">
        <div class="lock-title">当前处于【运行锁定】状态</div>
        <div class="lock-desc">为防止调试误触已禁止拖放元器件。请点击右上角或左侧挂锁解锁。</div>
      </div>
    </div>

    <!-- 搜索框 -->
    <div class="search-section">
      <div class="search-input-wrap">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="搜索元器件 (如 波形/滑块/PID)..."
        />
        <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">✕</button>
      </div>
    </div>

    <!-- 分类胶囊标签 -->
    <div class="category-tabs">
      <button
        v-for="cat in categoryTabs"
        :key="cat.key"
        class="category-btn"
        :class="{ active: activeCategory === cat.key }"
        @click="activeCategory = cat.key"
      >
        <span>{{ cat.icon }}</span>
        <span>{{ cat.label }}</span>
      </button>
    </div>

    <!-- 仿 VOFA+ 原生双列紧凑卡片网格 -->
    <div class="widget-list-scroll">
      <div class="widget-grid">
        <div
          v-for="w in filteredWidgets"
          :key="w.type"
          class="widget-card"
          :class="{
            'card-locked': props.isLocked,
            'card-dragging': store.pointerDragState.value.active && store.pointerDragState.value.widgetType === w.type,
          }"
          :title="props.isLocked ? '当前处于【运行锁定】状态，请先解锁后再拖入元器件' : `按住「${w.name}」拖拽至主画布网格`"
          draggable="false"
          @pointerdown="handleCardPointerDown($event, w)"
        >
          <!-- 顶部大图标 -->
          <div class="card-icon-area">
            <span class="card-icon">{{ w.icon }}</span>
          </div>

          <!-- 控件名称 -->
          <div class="card-title">{{ w.name }}</div>

          <!-- 默认尺寸标签 -->
          <div class="card-size-tag">{{ w.size }}</div>

          <!-- 底部微抓手点状修饰 -->
          <div class="card-grip-dots">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </div>

          <!-- 锁定态遮罩 -->
          <div v-if="props.isLocked" class="card-lock-overlay">
            <span class="lock-mini-icon">🔒</span>
          </div>
        </div>
      </div>

      <div v-if="filteredWidgets.length === 0" class="empty-hint">
        <div class="empty-icon">🔍</div>
        <div>未找到匹配的元器件</div>
      </div>
    </div>

    <!-- 底部操作提示 -->
    <footer class="drawer-footer">
      <div class="footer-tip">
        <span>💡 提示：按住卡片</span>
        <span class="text-sky-400 font-medium">直接拖入主画布</span>
        <span>网格吸附松开即成</span>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.widget-drawer {
  position: absolute;
  top: 0;
  left: 44px;
  bottom: 0;
  width: 320px;
  background: var(--bg-surface, #272623);
  border-right: 1px solid var(--border-subtle, #383633);
  box-shadow: var(--card-shadow, 4px 0 24px rgba(0, 0, 0, 0.3));
  display: flex;
  flex-direction: column;
  z-index: 40;
  user-select: none;
  animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

@keyframes slideIn {
  from {
    transform: translateX(-12px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.drawer-header {
  height: 44px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-elevated, #2F2E2A);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  white-space: nowrap;
}

.header-title svg {
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  flex-shrink: 0;
}

.count-tag {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.18));
  color: var(--accent-terracotta, #DA7756);
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 9999px;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 14px;
  border-radius: 4px;
  transition: all 0.15s;
}

.btn-close:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.lock-banner {
  margin: 10px 12px 2px 12px;
  padding: 8px 10px;
  background: rgba(229, 158, 56, 0.12);
  border: 1px solid rgba(229, 158, 56, 0.3);
  border-radius: 6px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.lock-icon {
  font-size: 16px;
}

.lock-title {
  font-size: 11px;
  font-weight: 600;
  color: #E59E38;
}

.lock-desc {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  line-height: 1.3;
  margin-top: 2px;
}

.search-section {
  padding: 10px 12px 6px 12px;
}

.search-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  flex-shrink: 0;
  color: var(--text-muted, #9E9C94);
  pointer-events: none;
}

.search-input {
  width: 100%;
  height: 32px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 0 28px;
  font-size: 12px;
  color: var(--text-main, #ECEAE4);
  outline: none;
  transition: border-color 0.15s;
}

.search-input:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.search-clear {
  position: absolute;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 12px;
}

.category-tabs {
  display: flex;
  gap: 4px;
  padding: 4px 12px 10px 12px;
  overflow-x: auto;
}

.category-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.category-btn:hover {
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
}

.category-btn.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.widget-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 12px 12px 12px;
}

.widget-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.widget-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 6px 10px 6px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  cursor: grab;
  position: relative;
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
  touch-action: none;
  user-select: none;
}

.widget-card:hover:not(.card-locked) {
  background: var(--bg-surface, #272623);
  border-color: var(--accent-terracotta, #DA7756);
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25), 0 0 10px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
}

.widget-card:active:not(.card-locked) {
  cursor: grabbing;
}

.widget-card.card-dragging {
  opacity: 0.45;
  border-style: dashed;
  border-color: var(--accent-terracotta, #DA7756);
  cursor: grabbing;
}

.widget-card.card-locked {
  opacity: 0.45;
  cursor: not-allowed !important;
  filter: grayscale(0.6);
  background: var(--bg-surface, #272623);
}

.card-icon-area {
  width: 44px;
  height: 44px;
  background: var(--bg-surface, #272623);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-subtle, #383633);
  margin-bottom: 8px;
  transition: transform 0.15s ease;
}

.widget-card:hover:not(.card-locked) .card-icon-area {
  transform: scale(1.06);
  border-color: var(--accent-terracotta, #DA7756);
}

.card-icon {
  font-size: 24px;
  line-height: 1;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.card-size-tag {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted, #9E9C94);
  margin-top: 3px;
  background: var(--bg-surface, #272623);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle, #383633);
}

.card-grip-dots {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 6px;
  opacity: 0.4;
  transition: opacity 0.15s;
}

.widget-card:hover:not(.card-locked) .card-grip-dots {
  opacity: 0.85;
}

.card-grip-dots .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-muted, #9E9C94);
}

.card-lock-overlay {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 11px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
  gap: 8px;
}

.empty-icon {
  font-size: 24px;
}

.drawer-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle, #383633);
  background: var(--bg-elevated, #2F2E2A);
}

.footer-tip {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: center;
}
</style>
