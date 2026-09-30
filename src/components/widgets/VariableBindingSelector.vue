<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useWidgetStore } from '../../stores/widgetStore';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import {
  getAvailableChannels,
  normalizeChannelId,
  formatChannelFloatValue,
  type ChannelSelectItem,
} from '../../utils/channelHelpers';

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null;
    placeholder?: string;
    disabled?: boolean;
    allowClear?: boolean;
    size?: 'sm' | 'md';
  }>(),
  {
    modelValue: null,
    placeholder: '请选择通道',
    disabled: false,
    allowClear: true,
    size: 'md',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | null): void;
  (e: 'change', value: string | null): void;
}>();

const store = useWidgetStore();

// 选单开启与检索状态
const isOpen = ref(false);
const searchQuery = ref('');
const selectorContainerRef = ref<HTMLElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const isDropdownAbove = ref(false);

// 实时可用通道列表
const channelList = ref<ChannelSelectItem[]>([]);
let liveUpdateTimer: number | null = null;

// 规范化当前选中的通道标识
const currentChannelId = computed<string | null>(() => {
  if (props.modelValue === null || props.modelValue === undefined || props.modelValue === '') {
    return null;
  }
  return normalizeChannelId(String(props.modelValue));
});

// 获取当前选中项的详细元数据
const currentSelectedItem = computed<ChannelSelectItem | null>(() => {
  if (!currentChannelId.value) return null;
  return (
    channelList.value.find((c) => c.id === currentChannelId.value) || {
      id: currentChannelId.value,
      name: currentChannelId.value,
      color: store.getChannelMeta(currentChannelId.value).color || '#DA7756',
      formattedValue: formatChannelFloatValue(globalChannelStore.latest(currentChannelId.value)?.v),
      isActive: Boolean(globalChannelStore.latest(currentChannelId.value)),
    }
  );
});

// 刷新全部通道及其 6 位浮点实时数值
function refreshChannels() {
  channelList.value = getAvailableChannels(store, globalChannelStore, currentChannelId.value);
}

// 检索过滤
const filteredChannels = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return channelList.value;
  return channelList.value.filter((item) => {
    return (
      item.id.toLowerCase().includes(query) ||
      (item.name && item.name.toLowerCase().includes(query))
    );
  });
});

// 开启 / 切换下拉
function toggleDropdown() {
  if (props.disabled) return;
  if (isOpen.value) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

function openDropdown() {
  if (props.disabled) return;
  searchQuery.value = '';
  refreshChannels();

  // 边界防溢出计算：如果容器离视口下边缘过近，向上翻转展开
  if (selectorContainerRef.value) {
    const rect = selectorContainerRef.value.getBoundingClientRect();
    const dropdownHeight = 280; // 预估高度
    const spaceBelow = window.innerHeight - rect.bottom;
    isDropdownAbove.value = spaceBelow < dropdownHeight && rect.top > dropdownHeight;
  }

  isOpen.value = true;
  startLiveTicker();
}

function closeDropdown() {
  isOpen.value = false;
  startLiveTicker();
}

// 选中某个通道
function selectChannel(id: string | null) {
  emit('update:modelValue', id);
  emit('change', id);
  closeDropdown();
}

// 一键清空绑定
function handleClear(e: MouseEvent) {
  e.stopPropagation();
  selectChannel(null);
}

// 实时值定时刷新机制 (下拉开启时 100ms 高速刷新，关闭时 250ms 保持触发器数值最新)
function startLiveTicker() {
  stopLiveTicker();
  const interval = isOpen.value ? 100 : 250;
  liveUpdateTimer = window.setInterval(() => {
    refreshChannels();
  }, interval);
}

function stopLiveTicker() {
  if (liveUpdateTimer !== null) {
    clearInterval(liveUpdateTimer);
    liveUpdateTimer = null;
  }
}

// 点击外部关闭下拉
function handleClickOutside(e: MouseEvent) {
  if (!isOpen.value) return;
  const container = selectorContainerRef.value;
  if (container && !container.contains(e.target as Node)) {
    closeDropdown();
  }
}

// 键盘 Escape 监听
function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    closeDropdown();
  }
}

watch(
  () => [props.modelValue, store.channelMetaMap.value],
  () => {
    refreshChannels();
  },
  { deep: true, immediate: true }
);

onMounted(() => {
  refreshChannels();
  startLiveTicker();
  window.addEventListener('click', handleClickOutside, true);
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  stopLiveTicker();
  window.removeEventListener('click', handleClickOutside, true);
  window.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <div
    ref="selectorContainerRef"
    class="vofa-variable-selector"
    :class="[
      `size-${size}`,
      {
        'is-open': isOpen,
        'is-disabled': disabled,
        'has-value': Boolean(currentChannelId),
      },
    ]"
    @click.stop
  >
    <!-- 触发器框体 -->
    <div class="selector-trigger" @click="toggleDropdown">
      <!-- 色彩圆点 -->
      <span
        class="channel-color-dot"
        :style="{
          backgroundColor: currentSelectedItem ? currentSelectedItem.color : 'transparent',
          borderColor: currentSelectedItem ? currentSelectedItem.color : 'var(--text-muted, #9E9C94)',
        }"
      ></span>

      <!-- 选中标签 / 占位符 -->
      <div class="trigger-label">
        <template v-if="currentSelectedItem">
          <span class="selected-id font-mono">{{ currentSelectedItem.id }}</span>
          <span
            v-if="currentSelectedItem.name && currentSelectedItem.name !== currentSelectedItem.id"
            class="selected-alias"
          >
            ({{ currentSelectedItem.name }})
          </span>
          <!-- 实时读数徽章 -->
          <span
            v-if="currentSelectedItem.isActive"
            class="live-value-pill font-mono"
            title="实时数据流数值"
          >
            {{ currentSelectedItem.formattedValue }}
          </span>
        </template>
        <span v-else class="placeholder-text">{{ placeholder }}</span>
      </div>

      <!-- 右侧操作区：清除按钮 + 下拉指示箭头 -->
      <div class="trigger-actions">
        <button
          v-if="allowClear && currentChannelId && !disabled"
          class="btn-clear"
          title="清除绑定"
          @click="handleClear"
        >
          ✕
        </button>
        <span class="arrow-indicator" :class="{ 'is-flipped': isOpen }">▾</span>
      </div>
    </div>

    <!-- 浮动下拉弹窗 -->
    <div
      v-if="isOpen"
      ref="dropdownRef"
      class="selector-dropdown"
      :class="{ 'direction-above': isDropdownAbove }"
    >
      <!-- 搜索过滤条 -->
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input
          v-model="searchQuery"
          type="text"
          class="search-input font-mono"
          placeholder="快速搜索通道编号或别名..."
          autofocus
          @click.stop
        />
        <button
          v-if="searchQuery"
          class="btn-clear-search"
          @click="searchQuery = ''"
        >
          ✕
        </button>
      </div>

      <!-- 下拉通道列表 -->
      <div class="channel-dropdown-list">
        <!-- 首项：未绑定 / 清除绑定 -->
        <div
          v-if="allowClear && (!searchQuery || '未绑定 / 清除绑定'.toLowerCase().includes(searchQuery.toLowerCase()) || 'clear'.includes(searchQuery.toLowerCase()))"
          class="dropdown-item item-clear"
          :class="{ selected: !currentChannelId }"
          @click="selectChannel(null)"
        >
          <span class="item-icon">🚫</span>
          <span class="item-id">未绑定 / 清除绑定</span>
          <span v-if="!currentChannelId" class="check-mark">✓</span>
        </div>

        <div v-if="allowClear && (!searchQuery || '未绑定 / 清除绑定'.toLowerCase().includes(searchQuery.toLowerCase()) || 'clear'.includes(searchQuery.toLowerCase()))" class="list-divider"></div>

        <!-- 过滤后的可用通道条目 -->
        <template v-if="filteredChannels.length > 0">
          <div
            v-for="ch in filteredChannels"
            :key="ch.id"
            class="dropdown-item"
            :class="{
              selected: currentChannelId === ch.id,
              active: ch.isActive,
            }"
            @click="selectChannel(ch.id)"
          >
            <!-- 颜色圆点 -->
            <span class="channel-color-dot" :style="{ backgroundColor: ch.color }"></span>

            <!-- 通道编号与用户别名 -->
            <div class="channel-info">
              <span class="channel-id font-mono">{{ ch.id }}</span>
              <span v-if="ch.name && ch.name !== ch.id" class="channel-alias">
                {{ ch.name }}
              </span>
            </div>

            <!-- 右侧 6 位高精浮点实时值与状态指示灯 -->
            <div class="channel-meta-right">
              <span
                class="realtime-val font-mono"
                :class="{ 'is-active': ch.isActive }"
              >
                {{ ch.formattedValue }}
              </span>
              <span
                v-if="ch.isActive"
                class="active-pulse"
                title="数据流活跃"
              ></span>
              <span v-if="currentChannelId === ch.id" class="check-mark">✓</span>
            </div>
          </div>
        </template>
        <div v-else class="empty-hint">
          无匹配的通道变量
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vofa-variable-selector {
  position: relative;
  width: 100%;
  user-select: none;
  font-size: 13px;
}

/* 尺寸差异 */
.vofa-variable-selector.size-sm .selector-trigger {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
}

.vofa-variable-selector.size-md .selector-trigger {
  height: 34px;
  padding: 0 10px;
}

/* 触发器外观 */
.selector-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  background-color: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  cursor: pointer;
  transition: all 0.15s ease-in-out;
}

.selector-trigger:hover {
  border-color: var(--border-strong, #4A4843);
  background-color: var(--bg-elevated, #2F2E2A);
}

.vofa-variable-selector.is-open .selector-trigger {
  border-color: var(--accent-terracotta, #DA7756);
  box-shadow: 0 0 0 1px var(--accent-terracotta, #DA7756);
}

.vofa-variable-selector.is-disabled .selector-trigger {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

/* 颜色小圆点 */
.channel-color-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1.5px solid transparent;
}

/* 标签信息 */
.trigger-label {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.selected-id {
  font-weight: 700;
  color: var(--accent-terracotta, #DA7756);
}

.selected-alias {
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
}

.live-value-pill {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background-color: rgba(34, 197, 94, 0.15);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.placeholder-text {
  color: var(--text-muted);
}

/* 右侧按钮区 */
.trigger-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.btn-clear {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
}

.btn-clear:hover {
  color: #f43f5e;
  background-color: rgba(244, 63, 94, 0.15);
}

.arrow-indicator {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.arrow-indicator.is-flipped {
  transform: rotate(180deg);
}

/* 下拉浮动面板 */
.selector-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 1050;
  background-color: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.7);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: dropdownFadeIn 0.12s ease-out;
}

.selector-dropdown.direction-above {
  top: auto;
  bottom: calc(100% + 4px);
}

@keyframes dropdownFadeIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 搜索条 */
.search-bar {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 6px;
  background-color: var(--bg-elevated);
  border-bottom: 1px solid var(--border-subtle);
}

.search-icon {
  font-size: 11px;
  opacity: 0.7;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-main);
  font-size: 12px;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.btn-clear-search {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 0 4px;
}

/* 通道列表区 */
.channel-dropdown-list {
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
}

.channel-dropdown-list::-webkit-scrollbar {
  width: 4px;
}

.channel-dropdown-list::-webkit-scrollbar-thumb {
  background-color: var(--border-subtle);
  border-radius: 2px;
}

.list-divider {
  height: 1px;
  background-color: var(--border-subtle);
  margin: 4px 6px;
}

/* 条目样式 */
.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.dropdown-item:hover {
  background-color: var(--bg-elevated);
}

.dropdown-item.selected {
  background-color: rgba(218, 119, 86, 0.15);
}

.dropdown-item.item-clear {
  color: var(--text-muted);
}

.dropdown-item.item-clear:hover {
  color: var(--text-main);
  background-color: rgba(244, 63, 94, 0.12);
}

.channel-info {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  overflow: hidden;
}

.channel-id {
  font-weight: 700;
  color: var(--accent-terracotta, #DA7756);
  font-size: 12px;
}

.channel-alias {
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-meta-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.realtime-val {
  font-size: 11px;
  color: var(--text-soft, #706E66);
}

.realtime-val.is-active {
  color: #7AA89B;
  font-weight: 600;
}

.active-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #7AA89B;
  box-shadow: 0 0 6px #7AA89B;
  animation: pulseLight 1.5s infinite;
}

@keyframes pulseLight {
  0% {
    transform: scale(0.9);
    opacity: 0.6;
  }
  50% {
    transform: scale(1.3);
    opacity: 1;
  }
  100% {
    transform: scale(0.9);
    opacity: 0.6;
  }
}

.check-mark {
  color: var(--accent-terracotta, #DA7756);
  font-weight: bold;
  font-size: 12px;
}

.empty-hint {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
