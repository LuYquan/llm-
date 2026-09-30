<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useWidgetStore, DEFAULT_CHANNEL_PALETTE } from '../stores/widgetStore';
import { globalChannelStore } from '../core/channel/ChannelStore';
import type { ChannelMeta } from '../types/widget';

defineProps<{
  isRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'channel-drag-start', channelId: string): void;
  (e: 'channel-drag-end'): void;
}>();

const store = useWidgetStore();
const isCollapsed = ref(true);

// 通道列表与实时读数
const knownChannels = ref<string[]>([]);
const latestValues = ref<Record<string, number>>({});
const pulseMap = ref<Record<string, boolean>>({});

// 就地重命名状态
const editingChannelId = ref<string | null>(null);
const editingChannelName = ref('');

// 通道配置弹窗
const configModalOpen = ref(false);
const activeConfigChannel = ref<ChannelMeta | null>(null);

// 头部更多操作菜单
const isMenuOpen = ref(false);

// 拾色器弹窗
const activeColorPickerChannel = ref<string | null>(null);

// 监听 ChannelStore 中的通道发现
let unsubChannels: (() => void) | null = null;
let pollTimer: number | null = null;

function refreshChannels() {
  const list = globalChannelStore.listChannels();
  if (list.length === 0) {
    // 默认展示至少 !0 ~ !7 供开箱即用观察与拖拽
    knownChannels.value = ['0', '1', '2', '3', '4', '5', '6', '7'];
  } else {
    knownChannels.value = list;
  }

  // 保证 store 中元数据初始化
  for (const ch of knownChannels.value) {
    store.getChannelMeta(ch);
  }
}

function updateLatestValues() {
  for (const ch of knownChannels.value) {
    const pt = globalChannelStore.latest(ch);
    if (pt) {
      const meta = store.getChannelMeta(ch);
      const transformed = pt.v * meta.scale + meta.yOffset;
      if (latestValues.value[ch] !== transformed) {
        latestValues.value[ch] = transformed;
        // 触发微脉冲动效
        pulseMap.value[ch] = true;
        setTimeout(() => {
          pulseMap.value[ch] = false;
        }, 150);
      }
    }
  }
}

onMounted(() => {
  refreshChannels();
  unsubChannels = globalChannelStore.onChannelsChanged(() => {
    refreshChannels();
  });
  // 30Hz 刷新侧边栏实时翻滚数值
  pollTimer = window.setInterval(() => {
    updateLatestValues();
  }, 33);
});

onUnmounted(() => {
  if (unsubChannels) unsubChannels();
  if (pollTimer) clearInterval(pollTimer);
});

function toggleCollapse() {
  isCollapsed.value = !isCollapsed.value;
}

function handleGlobalEyeClick() {
  store.toggleChannelVisibility();
}

function handleEyeClick(ch: string, e: MouseEvent) {
  e.stopPropagation();
  store.toggleChannelVisibility(ch);
}

function startRename(ch: string, e: MouseEvent) {
  e.stopPropagation();
  const meta = store.getChannelMeta(ch);
  editingChannelId.value = ch;
  editingChannelName.value = meta.name;
  nextTick(() => {
    const input = document.getElementById(`rename-input-${ch}`) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  });
}

function commitRename(ch: string) {
  if (editingChannelId.value === ch && editingChannelName.value.trim()) {
    store.renameChannel(ch, editingChannelName.value.trim());
  }
  editingChannelId.value = null;
}

function cancelRename() {
  editingChannelId.value = null;
}

function openChannelConfig(ch: string, e: MouseEvent) {
  e.stopPropagation();
  activeConfigChannel.value = JSON.parse(JSON.stringify(store.getChannelMeta(ch)));
  configModalOpen.value = true;
}

function saveChannelConfig() {
  if (activeConfigChannel.value) {
    store.updateChannelMeta(activeConfigChannel.value.id, {
      scale: activeConfigChannel.value.scale,
      yOffset: activeConfigChannel.value.yOffset,
      xOffset: activeConfigChannel.value.xOffset,
      decimal: activeConfigChannel.value.decimal,
      color: activeConfigChannel.value.color,
    });
  }
  configModalOpen.value = false;
}

function openColorPicker(ch: string, e: MouseEvent) {
  e.stopPropagation();
  activeColorPickerChannel.value = activeColorPickerChannel.value === ch ? null : ch;
}

function selectColor(ch: string, color: string) {
  store.updateChannelMeta(ch, { color });
  activeColorPickerChannel.value = null;
}

// 格式化输出浮点数值
function formatChannelValue(ch: string): string {
  const v = latestValues.value[ch];
  if (v == null || isNaN(v)) return '0.000000';
  const meta = store.getChannelMeta(ch);
  const dec = meta.decimal != null ? meta.decimal : 6;
  return v.toFixed(dec);
}

// 拖拽发起：传递通道 ID 与元信息
function onDragStart(e: DragEvent, ch: string) {
  const meta = store.getChannelMeta(ch);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', meta.name);
    e.dataTransfer.setData('application/x-vofa-channel', ch);
    e.dataTransfer.setData('application/x-vofa-channel-meta', JSON.stringify(meta));
  }
  store.setDraggingChannelId(ch);
  emit('channel-drag-start', ch);
}

function onDragEnd() {
  store.setDraggingChannelId(null);
  emit('channel-drag-end');
}

// 菜单功能
function addVirtualChannel() {
  const nextIdx = knownChannels.value.length;
  const newId = `v_${nextIdx}`;
  globalChannelStore.push(newId, Date.now() / 1000, 0);
  refreshChannels();
  isMenuOpen.value = false;
}

function clearInactiveChannels() {
  const list = globalChannelStore.listChannels();
  for (const ch of list) {
    const pt = globalChannelStore.latest(ch);
    if (!pt) {
      globalChannelStore.clear(ch);
    }
  }
  refreshChannels();
  isMenuOpen.value = false;
}

function exportAllChannelsCsv() {
  const channels = knownChannels.value;
  if (channels.length === 0) return;

  const header = ['Timestamp(s)', ...channels.map((c) => store.getChannelMeta(c).name)];
  const rows: string[] = [header.join(',')];

  // 找参考通道取时间
  let refSnap = null;
  for (const ch of channels) {
    const s = globalChannelStore.snapshot(ch);
    if (s.count > 0) {
      refSnap = s;
      break;
    }
  }

  if (refSnap && refSnap.count > 0) {
    const count = refSnap.count;
    for (let i = 0; i < count; i++) {
      const t = refSnap.timestamps[i];
      const r = [t.toFixed(4)];
      for (const ch of channels) {
        const snap = globalChannelStore.snapshot(ch);
        const val = snap.values[i];
        r.push(val != null && !isNaN(val) ? val.toFixed(4) : '');
      }
      rows.push(r.join(','));
    }
  }

  const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(rows.join('\n'));
  const link = document.createElement('a');
  link.setAttribute('href', csvContent);
  link.setAttribute('download', `channels_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  isMenuOpen.value = false;
}

function resetAllChannelScales() {
  for (const ch of knownChannels.value) {
    store.updateChannelMeta(ch, {
      scale: 1.0,
      yOffset: 0.0,
      xOffset: 0.0,
      decimal: 6,
    });
  }
  isMenuOpen.value = false;
}

function collapse() {
  isCollapsed.value = true;
}

function expand() {
  isCollapsed.value = false;
}

defineExpose({
  collapse,
  expand,
  isCollapsed,
});
</script>

<template>
  <aside
    class="right-data-sidebar"
    :class="{ collapsed: isCollapsed }"
    aria-label="多通道数据监控与绑定侧边栏"
  >
    <!-- 折叠把手 -->
    <button
      class="sidebar-collapse-toggle"
      @click="toggleCollapse"
      :title="isCollapsed ? '展开数据通道栏' : '折叠数据通道栏'"
    >
      <span class="toggle-icon">{{ isCollapsed ? '◀' : '▶' }}</span>
    </button>

    <div v-show="!isCollapsed" class="sidebar-inner">
      <!-- 头部：全局眼睛开关、标题、更多菜单 -->
      <header class="sidebar-header">
        <button
          class="btn-global-eye"
          @click="handleGlobalEyeClick"
          title="一键全部显示/全部隐藏所有通道曲线"
        >
          <svg class="w-4 h-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>

        <h3 class="sidebar-title">数据</h3>

        <div class="header-menu-anchor">
          <button
            class="btn-menu-trigger"
            @click="isMenuOpen = !isMenuOpen"
            title="数据通道高级操作"
          >
            ···
          </button>

          <!-- 头部下拉菜单 -->
          <div v-if="isMenuOpen" class="dropdown-menu">
            <button class="menu-item" @click="addVirtualChannel">➕ 手动添加通道</button>
            <button class="menu-item" @click="clearInactiveChannels">🧹 清理无数据通道</button>
            <button class="menu-item" @click="exportAllChannelsCsv">💾 批量导出 CSV</button>
            <button class="menu-item" @click="resetAllChannelScales">⟲ 重置比例/偏置</button>
          </div>
        </div>
      </header>

      <!-- 通道列表 (带拖拽手柄与 6 位浮点实时翻滚数值) -->
      <div class="channel-list custom-scrollbar">
        <div
          v-for="ch in knownChannels"
          :key="ch"
          class="channel-item"
          :class="{ 'is-hidden': !store.getChannelMeta(ch).visible, 'is-pulsing': pulseMap[ch] }"
          draggable="true"
          @dragstart="onDragStart($event, ch)"
          @dragend="onDragEnd"
          :title="`按住向左拖拽至画布控件绑定通道 [${store.getChannelMeta(ch).name}]；双击重命名`"
        >
          <!-- 1. 眼睛可见性切换 -->
          <button
            class="btn-channel-eye"
            @click="handleEyeClick(ch, $event)"
            :title="store.getChannelMeta(ch).visible ? '隐藏该通道曲线' : '显示该通道曲线'"
          >
            <svg
              v-if="store.getChannelMeta(ch).visible"
              class="w-3.5 h-3.5"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <svg
              v-else
              class="w-3.5 h-3.5 eye-off"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
              <line x1="1" y1="1" x2="23" y2="23"></line>
            </svg>
          </button>

          <!-- 2. 色块标牌 (点击弹出调色板) -->
          <div class="color-badge-wrapper">
            <span
              class="channel-color-badge"
              :style="{ backgroundColor: store.getChannelMeta(ch).color }"
              @click="openColorPicker(ch, $event)"
              title="点击自定义曲线与标牌色彩"
            ></span>

            <!-- 拾色浮窗 -->
            <div
              v-if="activeColorPickerChannel === ch"
              class="color-palette-popover"
              @click.stop
            >
              <button
                v-for="color in DEFAULT_CHANNEL_PALETTE"
                :key="color"
                class="palette-item"
                :style="{ backgroundColor: color }"
                @click="selectColor(ch, color)"
              ></button>
            </div>
          </div>

          <!-- 3. 通道标识/名称 (双击就地重命名) -->
          <div class="channel-name-wrapper" @dblclick="startRename(ch, $event)">
            <input
              v-if="editingChannelId === ch"
              :id="`rename-input-${ch}`"
              v-model="editingChannelName"
              type="text"
              class="rename-input"
              @blur="commitRename(ch)"
              @keydown.enter="commitRename(ch)"
              @keydown.esc="cancelRename"
              @click.stop
            />
            <span v-else class="channel-name font-mono">
              {{ store.getChannelMeta(ch).name }}
            </span>
          </div>

          <!-- 4. 6 位高精浮点实时翻滚数值 -->
          <div class="channel-value-wrapper">
            <span
              class="channel-value font-mono"
              :style="{ color: store.getChannelMeta(ch).visible ? store.getChannelMeta(ch).color : '#64748b' }"
            >
              {{ formatChannelValue(ch) }}
            </span>
          </div>

          <!-- 5. 拖拽手柄与精细设置齿轮 -->
          <button
            class="btn-channel-gear"
            @click="openChannelConfig(ch, $event)"
            title="精细预处理配置 (Scale/Offset/Decimal)"
          >
            ⚙️
          </button>
        </div>
      </div>
    </div>

    <!-- 通道精细配置模态弹窗 -->
    <div v-if="configModalOpen && activeConfigChannel" class="modal-mask" @click="configModalOpen = false">
      <div class="config-modal-box" @click.stop>
        <header class="modal-header">
          <h4>通道 [{{ activeConfigChannel.name }}] 高级属性配置</h4>
          <button class="btn-close" @click="configModalOpen = false">✕</button>
        </header>

        <div class="modal-body">
          <div class="form-row">
            <label>Scale 线性缩放倍率:</label>
            <input v-model.number="activeConfigChannel.scale" type="number" step="0.001" class="form-input" />
          </div>
          <div class="form-row">
            <label>Y-Offset 垂直偏置:</label>
            <input v-model.number="activeConfigChannel.yOffset" type="number" step="0.1" class="form-input" />
          </div>
          <div class="form-row">
            <label>X-Offset 相位时滞偏置:</label>
            <input v-model.number="activeConfigChannel.xOffset" type="number" step="0.01" class="form-input" />
          </div>
          <div class="form-row">
            <label>Decimal 显示精度 (0~6位):</label>
            <input v-model.number="activeConfigChannel.decimal" type="number" min="0" max="6" class="form-input" />
          </div>
        </div>

        <footer class="modal-footer">
          <button class="btn-secondary" @click="configModalOpen = false">取消</button>
          <button class="btn-primary" @click="saveChannelConfig">保存配置</button>
        </footer>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.right-data-sidebar {
  width: 210px;
  min-width: 210px;
  height: 100%;
  background: var(--bg-surface, #272623);
  border-left: 1px solid var(--border-subtle, #383633);
  display: flex;
  flex-direction: column;
  position: relative;
  user-select: none;
  z-index: 25;
  transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.22s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.25s ease, border-color 0.25s ease;
}

.right-data-sidebar.collapsed {
  width: 0px;
  min-width: 0px;
  border-left: 1px solid transparent;
}

.sidebar-collapse-toggle {
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 54px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-right: none;
  border-radius: 4px 0 0 4px;
  color: var(--text-muted, #9E9C94);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 30;
  padding: 0;
  transition: all 0.2s ease;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.25);
}

.sidebar-collapse-toggle:hover {
  background: var(--bg-surface, #272623);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
  box-shadow: -3px 0 12px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25));
}

.toggle-icon {
  font-size: 9px;
}

.sidebar-inner {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
  flex-shrink: 0;
}

.btn-global-eye {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  border-radius: 3px;
}

.btn-global-eye:hover {
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
}

.sidebar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  margin: 0;
}

.header-menu-anchor {
  position: relative;
}

.btn-menu-trigger {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 3px;
}

.btn-menu-trigger:hover {
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
}

.dropdown-menu {
  position: absolute;
  right: 0;
  top: 24px;
  width: 140px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  box-shadow: var(--card-shadow, 0 10px 25px rgba(0, 0, 0, 0.35));
  display: flex;
  flex-direction: column;
  padding: 4px;
  z-index: 50;
}

.menu-item {
  background: transparent;
  border: none;
  color: var(--text-main, #ECEAE4);
  text-align: left;
  font-size: 11px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
}

.menu-item:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
}

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.channel-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 6px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  cursor: grab;
  transition: background 0.15s, border-color 0.15s;
}

.channel-item:hover {
  background: var(--bg-surface, #272623);
  border-color: var(--border-strong, #4A4843);
}

.channel-item:active {
  cursor: grabbing;
}

.channel-item.is-hidden {
  opacity: 0.45;
}

.channel-item.is-pulsing {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.18));
}

.btn-channel-eye {
  background: transparent;
  border: none;
  color: var(--accent-terracotta, #DA7756);
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
}

.btn-channel-eye .eye-off {
  color: var(--text-soft, #706E66);
}

.color-badge-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.channel-color-badge {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.color-palette-popover {
  position: absolute;
  left: 14px;
  top: -10px;
  width: 96px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 6px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  box-shadow: var(--card-shadow, 0 8px 20px rgba(0, 0, 0, 0.4));
  z-index: 60;
}

.palette-item {
  width: 16px;
  height: 16px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  cursor: pointer;
}

.channel-name-wrapper {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.rename-input {
  width: 100%;
  height: 20px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 2px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  padding: 0 4px;
  outline: none;
}

.channel-value-wrapper {
  width: 72px;
  text-align: right;
  flex-shrink: 0;
}

.channel-value {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: -0.2px;
}

.btn-channel-gear {
  background: transparent;
  border: none;
  font-size: 10px;
  cursor: pointer;
  padding: 0;
  opacity: 0.4;
  transition: opacity 0.2s;
}

.channel-item:hover .btn-channel-gear {
  opacity: 1;
}

/* 模态弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.config-modal-box {
  width: 320px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  box-shadow: var(--card-shadow, 0 20px 40px rgba(0, 0, 0, 0.45));
  padding: 16px;
  color: var(--text-main, #ECEAE4);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle, #383633);
  padding-bottom: 8px;
  margin-bottom: 12px;
}

.modal-header h4 {
  margin: 0;
  font-size: 13px;
  color: var(--text-main, #ECEAE4);
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 14px;
}

.btn-close:hover {
  color: var(--text-main, #ECEAE4);
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--text-main, #ECEAE4);
}

.form-input {
  width: 90px;
  height: 24px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  padding: 0 6px;
  font-size: 11px;
  font-family: monospace;
}

.form-input:focus {
  border-color: var(--accent-terracotta, #DA7756);
  outline: none;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle, #383633);
}

.btn-secondary {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-secondary:hover {
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
}

.btn-primary {
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: #ffffff;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-primary:hover {
  background: var(--accent-terracotta-hover, #E58565);
}

</style>
