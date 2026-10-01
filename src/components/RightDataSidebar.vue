<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useWidgetStore, DEFAULT_CHANNEL_PALETTE } from '../stores/widgetStore';
import { globalChannelStore } from '../core/channel/ChannelStore';
import type { ChannelMeta } from '../types/widget';
import { CHANNEL_UNIT_MAX_LENGTH, normalizeChannelUnitMetadata, presentChannel } from '../core/channel/channelPresentation';
import { formatSidebarValue, projectSidebarChannels, sidebarSampleStatus, widgetChannelBindings, type SidebarChannelRow } from '../core/channel/sidebarProjection';

const props = defineProps<{
  isRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'channel-drag-start', channelId: string): void;
  (e: 'channel-drag-end'): void;
}>();

const store = useWidgetStore();
const isCollapsed = ref(true);

const channelRows = ref<SidebarChannelRow[]>([]);
const waitingExpanded = ref(false);
const rowGroups = computed(() => [
  { key: 'received', rows: channelRows.value.filter((row) => row.hasSamples) },
  { key: 'waiting', rows: channelRows.value.filter((row) => !row.hasSamples) },
]);
const knownChannels = computed(() => channelRows.value.filter((row) => row.hasSamples).map((row) => row.id));

// 就地重命名状态
const editingChannelId = ref<string | null>(null);
const editingChannelName = ref('');

// 通道配置弹窗
const configModalOpen = ref(false);
const activeConfigChannel = ref<ChannelMeta | null>(null);
const rawUnitInput = ref('');
const rawUnitConfirmed = ref(false);
const configError = ref('');
const configDialog = ref<HTMLDivElement | null>(null);
const rawUnitField = ref<HTMLInputElement | null>(null);
let configReturnFocus: HTMLElement | null = null;

// 拾色器弹窗
const activeColorPickerChannel = ref<string | null>(null);

// 监听 ChannelStore 中的通道发现
let unsubChannels: (() => void) | null = null;
let unsubCleared: (() => void) | null = null;
let pollTimer: number | null = null;

function refreshChannels() {
  const dashboard = store.dashboardState.value;
  const tab = dashboard.tabs.find((entry) => entry.id === dashboard.active_tab_id);
  const rows = projectSidebarChannels(globalChannelStore, widgetChannelBindings(tab?.widgets ?? []), dashboard.channels);
  const previous = channelRows.value;
  if (rows.length !== previous.length || rows.some((row, index) =>
    row.id !== previous[index].id || row.hasSamples !== previous[index].hasSamples || !Object.is(row.value, previous[index].value))) {
    channelRows.value = rows;
  }
}

// Rendering must not create persisted metadata or register aliases.
function channelMeta(id: string): ChannelMeta {
  const metadata = store.dashboardState.value.channels;
  const saved = metadata && Object.prototype.hasOwnProperty.call(metadata, id) ? metadata[id] : undefined;
  if (saved) return saved;
  let colorIndex = 0;
  for (const char of id) colorIndex = (colorIndex + char.charCodeAt(0)) % DEFAULT_CHANNEL_PALETTE.length;
  return { id, name: id, color: DEFAULT_CHANNEL_PALETTE[colorIndex], visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 6 };
}

watch(() => store.dashboardState.value, refreshChannels, { deep: true });
onMounted(() => {
  refreshChannels();
  unsubChannels = globalChannelStore.onChannelsChanged(refreshChannels);
  unsubCleared = globalChannelStore.onCleared(refreshChannels);
  // Discovery runs before insertion; this bounded refresh sees even a single batch.
  pollTimer = window.setInterval(refreshChannels, 33);
});

onUnmounted(() => {
  if (unsubChannels) unsubChannels();
  if (unsubCleared) unsubCleared();
  if (pollTimer) clearInterval(pollTimer);
  removeConfigFocusGuard();
});

function toggleCollapse() {
  isCollapsed.value = !isCollapsed.value;
}

function handleGlobalEyeClick() {
  // This is an explicit edit gesture; rendering and polling stay read-only.
  for (const row of channelRows.value) store.getChannelMeta(row.id);
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
  configReturnFocus = e.currentTarget instanceof HTMLElement ? e.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  activeConfigChannel.value = JSON.parse(JSON.stringify(store.getChannelMeta(ch)));
  rawUnitInput.value = activeConfigChannel.value?.unit ?? '';
  rawUnitConfirmed.value = false;
  configError.value = '';
  configModalOpen.value = true;
  document.addEventListener('keydown', handleConfigKeydown, true);
  document.addEventListener('focusin', containConfigFocus, true);
  nextTick(() => {
    if (configModalOpen.value) rawUnitField.value?.focus();
  });
}

function removeConfigFocusGuard() {
  document.removeEventListener('keydown', handleConfigKeydown, true);
  document.removeEventListener('focusin', containConfigFocus, true);
}

function closeChannelConfig() {
  configModalOpen.value = false;
  removeConfigFocusGuard();
  const returnFocus = configReturnFocus;
  configReturnFocus = null;
  nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus();
  });
}

function containConfigFocus(event: FocusEvent) {
  if (!configModalOpen.value || !configDialog.value || !(event.target instanceof Node)) return;
  if (!configDialog.value.contains(event.target)) (rawUnitField.value ?? configDialog.value).focus();
}

function handleConfigKeydown(event: KeyboardEvent) {
  if (!configModalOpen.value || !configDialog.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeChannelConfig();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(configDialog.value.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
    .filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
    configDialog.value.focus();
    return;
  }
  const active = document.activeElement;
  if (!configDialog.value.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

function unitInputChanged() {
  rawUnitConfirmed.value = false;
  configError.value = '';
}

function channelLabel(id: string): string {
  return presentChannel(id, channelMeta(id)).label;
}

function saveChannelConfig() {
  if (!activeConfigChannel.value) return;
  try {
    const unitMetadata = rawUnitInput.value === '' ? {} : normalizeChannelUnitMetadata({ unit: rawUnitInput.value, unitSource: 'user' });
    const name = activeConfigChannel.value.name.trim();
    if (!name || name.length > 128 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) throw new Error('请输入不超过 128 个字符、无控制字符的通道名称。');
    if (![activeConfigChannel.value.scale, activeConfigChannel.value.yOffset, activeConfigChannel.value.xOffset].every(Number.isFinite)
      || !Number.isInteger(activeConfigChannel.value.decimal) || activeConfigChannel.value.decimal < 0 || activeConfigChannel.value.decimal > 6) {
      throw new Error('倍率和偏置必须是有限数值；显示精度必须是 0–6 的整数。');
    }
    if (unitMetadata.unit && !rawUnitConfirmed.value) throw new Error('保存前请确认这是固件原始数据的单位，尚未进行显示缩放。');
    store.updateChannelMeta(activeConfigChannel.value.id, {
      name,
      scale: activeConfigChannel.value.scale,
      yOffset: activeConfigChannel.value.yOffset,
      xOffset: activeConfigChannel.value.xOffset,
      decimal: activeConfigChannel.value.decimal,
      color: activeConfigChannel.value.color,
      unit: unitMetadata.unit,
      unitSource: unitMetadata.unitSource,
    });
    closeChannelConfig();
  } catch (error) {
    configError.value = error instanceof Error ? error.message : String(error);
  }
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
  return formatSidebarValue(channelRows.value.find((row) => row.id === ch)?.value, channelMeta(ch).decimal);
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

function resetAllChannelScales() {
  for (const ch of knownChannels.value) {
    store.updateChannelMeta(ch, {
      scale: 1.0,
      yOffset: 0.0,
      xOffset: 0.0,
      decimal: 6,
    });
  }
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
      :aria-label="isCollapsed ? '展开数据通道栏' : '折叠数据通道栏'"
      :aria-expanded="!isCollapsed"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path :d="isCollapsed ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'" /></svg>
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

        <button class="btn-reset-display" :disabled="knownChannels.length === 0" @click="resetAllChannelScales" title="将已收到样本的通道恢复为倍率 1、偏置 0 和六位小数">重置显示</button>
      </header>

      <p class="sidebar-note">读数来自本机缓冲区；缩放只影响显示。</p>
      <p v-if="store.channelAliasConflicts.value.length" class="alias-warning" role="status">{{ store.channelAliasConflicts.value.length }} 个名称存在绑定冲突。请在通道配置中使用唯一名称，或按原始通道 ID 绑定。</p>
      <div class="channel-list custom-scrollbar">
        <p v-if="knownChannels.length === 0" class="channel-empty">尚未收到通道样本。连接设备或体验演示后，核对协议与通道绑定。</p>
        <section v-for="group in rowGroups" :key="group.key" class="channel-group">
        <button v-if="group.key === 'waiting' && group.rows.length" class="waiting-toggle" :aria-expanded="waitingExpanded" @click="waitingExpanded = !waitingExpanded">已配置，等待数据（{{ group.rows.length }}）<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path :d="waitingExpanded ? 'm5 15 7-7 7 7' : 'm5 9 7 7 7-7'" /></svg></button>
        <div v-if="group.key !== 'waiting' || waitingExpanded" class="group-rows">
        <div
          v-for="row in group.rows"
          :key="row.id"
          class="channel-item"
          :class="{ 'is-hidden': !channelMeta(row.id).visible, 'is-waiting': !row.hasSamples }"
          :data-channel-id="row.id"
          :data-sample-state="row.hasSamples ? row.value === null ? 'invalid' : 'received' : 'waiting'"
          draggable="true"
          @dragstart="onDragStart($event, row.id)"
          @dragend="onDragEnd"
          :title="`拖拽至画布绑定 [${channelLabel(row.id)}]；双击名称重命名`"
        >
          <!-- 1. 眼睛可见性切换 -->
          <button
            class="btn-channel-eye"
            @click="handleEyeClick(row.id, $event)"
            :title="channelMeta(row.id).visible ? '隐藏该通道曲线' : '显示该通道曲线'"
            :aria-label="`${channelLabel(row.id)}：${channelMeta(row.id).visible ? '隐藏' : '显示'}曲线`"
          >
            <svg
              v-if="channelMeta(row.id).visible"
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
            <button
              class="channel-color-badge"
              :style="{ '--channel-color': channelMeta(row.id).color }"
              @click="openColorPicker(row.id, $event)"
              title="点击自定义曲线与标牌色彩"
              :aria-label="`${channelLabel(row.id)}：修改曲线颜色`"
            ></button>

            <!-- 拾色浮窗 -->
            <div
              v-if="activeColorPickerChannel === row.id"
              class="color-palette-popover"
              @click.stop
            >
              <button
                v-for="color in DEFAULT_CHANNEL_PALETTE"
                :key="color"
                class="palette-item"
                :style="{ backgroundColor: color }"
                @click="selectColor(row.id, color)"
                :aria-label="`曲线颜色 ${color}`"
              ></button>
            </div>
          </div>

          <!-- 3. 通道标识/名称 (双击就地重命名) -->
          <div class="channel-name-wrapper" @dblclick="startRename(row.id, $event)">
            <input
              v-if="editingChannelId === row.id"
              :id="`rename-input-${row.id}`"
              v-model="editingChannelName"
              type="text"
              class="rename-input"
              @blur="commitRename(row.id)"
              @keydown.enter="commitRename(row.id)"
              @keydown.esc="cancelRename"
              @click.stop
            />
            <span v-else class="channel-name" :title="channelLabel(row.id)">
              {{ channelLabel(row.id) }}
            </span>
            <div class="channel-value-wrapper"><span class="channel-value font-mono">{{ formatChannelValue(row.id) }}</span></div>
            <span class="channel-sample-status">{{ sidebarSampleStatus(row, props.isRunning) }}</span>
          </div>

          <!-- 5. 拖拽手柄与精细设置齿轮 -->
          <button
            class="btn-channel-gear"
            @click="openChannelConfig(row.id, $event)"
            title="原始单位与显示缩放配置"
            :aria-label="`${channelLabel(row.id)}：原始单位与显示缩放配置`"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        </div>
        </section>
      </div>
    </div>

    <!-- 通道精细配置模态弹窗 -->
    <Teleport to="body">
    <div v-if="configModalOpen && activeConfigChannel" class="modal-mask" @click.self="closeChannelConfig">
      <div ref="configDialog" class="config-modal-box" data-channel-config-dialog role="dialog" aria-modal="true" aria-labelledby="channel-config-title" tabindex="-1" @click.stop>
        <header class="modal-header">
          <h4 id="channel-config-title">通道 {{ presentChannel(activeConfigChannel.id, activeConfigChannel).label }}</h4>
          <button class="btn-close" aria-label="关闭通道配置" @click="closeChannelConfig">✕</button>
        </header>

        <div class="modal-body">
          <div class="form-row">
            <label for="channel-display-name">通道名称:</label>
            <input id="channel-display-name" v-model="activeConfigChannel.name" type="text" maxlength="128" class="form-input" />
          </div>
          <div class="form-row">
            <label for="channel-raw-unit">原始数据单位（可留空）:</label>
            <input id="channel-raw-unit" ref="rawUnitField" v-model="rawUnitInput" type="text" :maxlength="CHANNEL_UNIT_MAX_LENGTH" class="form-input" placeholder="待用户确认" @input="unitInputChanged" />
          </div>
          <label v-if="rawUnitInput !== ''" class="unit-confirmation"><input v-model="rawUnitConfirmed" type="checkbox" />我已核对固件原始数据单位；这是用户提供的声明。</label>
          <p class="unit-note">单位描述收到的原始数值。下方缩放和偏置只影响显示，不修改原始数据、调参执行数值或单位；换设备或协议后应重新核对。</p>
          <p v-if="configError" class="unit-error" role="alert">{{ configError }}</p>
          <div class="form-row">
            <label for="channel-display-scale">Scale 线性缩放倍率:</label>
            <input id="channel-display-scale" v-model.number="activeConfigChannel.scale" type="number" step="0.001" class="form-input" />
          </div>
          <div class="form-row">
            <label for="channel-display-y-offset">Y-Offset 垂直偏置:</label>
            <input id="channel-display-y-offset" v-model.number="activeConfigChannel.yOffset" type="number" step="0.1" class="form-input" />
          </div>
          <div class="form-row">
            <label for="channel-display-x-offset">X-Offset 相位时滞偏置:</label>
            <input id="channel-display-x-offset" v-model.number="activeConfigChannel.xOffset" type="number" step="0.01" class="form-input" />
          </div>
          <div class="form-row">
            <label for="channel-display-decimal">Decimal 显示精度 (0~6位):</label>
            <input id="channel-display-decimal" v-model.number="activeConfigChannel.decimal" type="number" min="0" max="6" class="form-input" />
          </div>
        </div>

        <footer class="modal-footer">
          <button class="btn-secondary" @click="closeChannelConfig">取消</button>
          <button class="btn-primary" @click="saveChannelConfig">保存配置</button>
        </footer>
      </div>
    </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.right-data-sidebar {
  width: 270px;
  min-width: 270px;
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
  left: -32px;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
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
  min-height: 44px;
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
  min-width: 32px;
  min-height: 32px;
  justify-content: center;
}

.btn-global-eye:hover {
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
}

.sidebar-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  margin: 0;
}

.btn-reset-display {
  background: transparent;
  border: none;
  color: var(--text-main, #ECEAE4);
  font: inherit;
  font-size: 12px;
  min-height: 32px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
}

.btn-reset-display:hover:not(:disabled) {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
}
.btn-reset-display:disabled { color: var(--text-muted); cursor: default; }
.sidebar-note, .channel-empty { font-size: 12px; line-height: 1.5; color: var(--text-muted); }
.sidebar-note { margin: 12px 12px 4px; }
.alias-warning { margin: 8px 12px; font-size: 12px; line-height: 1.5; color: var(--text-main); overflow-wrap: anywhere; }
.channel-empty { margin: 8px 4px 16px; }
.channel-group { min-width: 0; }
.group-rows { display: flex; flex-direction: column; }
.waiting-toggle { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 4px; min-height: 40px; padding: 8px 4px; margin-top: 8px; background: transparent; border: none; border-top: 1px solid var(--border-subtle); color: var(--text-main); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.channel-sample-status { display: block; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
button:focus-visible { outline: 2px solid var(--accent-terracotta); outline-offset: 2px; }

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.channel-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 76px;
  flex-shrink: 0;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle, #383633);
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
  color: var(--text-muted);
}

.btn-channel-eye {
  background: transparent;
  border: none;
  color: var(--accent-terracotta, #DA7756);
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
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
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  cursor: pointer;
  border: none;
  background: transparent;
  display: grid;
  place-items: center;
}
.channel-color-badge::after { content: ''; width: 12px; height: 12px; border-radius: 2px; background: var(--channel-color); }

.color-palette-popover {
  position: absolute;
  left: 14px;
  top: -10px;
  width: 140px;
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
  width: 32px;
  height: 32px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  cursor: pointer;
}

.channel-name-wrapper {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-name {
  display: block;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.rename-input {
  width: 100%;
  height: 32px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 2px;
  color: var(--text-main, #ECEAE4);
  font-size: 13px;
  padding: 0 4px;
  outline: none;
}

.channel-value-wrapper {
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-main);
  font-variant-numeric: tabular-nums;
  user-select: text;
}

.btn-channel-gear {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  min-width: 32px;
  min-height: 32px;
  display: grid;
  place-items: center;
}

.channel-item:hover .btn-channel-gear {
  color: var(--text-main);
}

/* 模态弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 16px;
  box-sizing: border-box;
}

.config-modal-box {
  width: min(360px, 100%);
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
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
  flex-shrink: 0;
  gap: 8px;
}

.modal-header h4 {
  margin: 0;
  font-size: 16px;
  color: var(--text-main, #ECEAE4);
  overflow-wrap: anywhere;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 14px;
  min-width: 32px;
  min-height: 32px;
  flex-shrink: 0;
}

.btn-close:hover {
  color: var(--text-main, #ECEAE4);
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}

.unit-confirmation, .unit-note, .unit-error { font-size: 12px; line-height: 1.5; }
.unit-confirmation { display: flex; align-items: flex-start; gap: 6px; color: var(--text-main); }
.unit-note { margin: 0; color: var(--text-muted); }
.unit-error { margin: 0; color: var(--accent-rose, #fb8292); }

.form-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-main, #ECEAE4);
}

.form-input {
  width: 90px;
  height: 32px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  padding: 0 6px;
  font-size: 12px;
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
  flex-shrink: 0;
}

.modal-footer button { min-height: 32px; font-size: 12px; }

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
