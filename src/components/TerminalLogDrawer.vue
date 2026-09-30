<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { LogLine } from './GeneralTerminal.vue';
import type { FirmwareAnomaly } from '../core/copilot/types';

const props = defineProps<{
  isOpen: boolean;
  logs: LogLine[];
  isRunning: boolean;
  activeAnomaly?: FirmwareAnomaly | null;
  docked?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'clear-logs'): void;
  (e: 'diagnose-log', log: LogLine): void;
  (e: 'wake-copilot-anomaly', anomaly: FirmwareAnomaly): void;
}>();

const filterMode = ref<'text' | 'all' | 'control'>('text');
const displayAsHex = ref(false);
const autoScroll = ref(true);
const isUserScrolledUp = ref(false);
const searchQuery = ref('');
const drawerHeight = ref(props.docked ? 200 : 380);
const isResizing = ref(false);
const terminalBodyRef = ref<HTMLDivElement | null>(null);

const STORAGE_KEY_DRAWER_HEIGHT = 'vofa_terminal_drawer_height';
try {
  const saved = localStorage.getItem(STORAGE_KEY_DRAWER_HEIGHT);
  if (saved) {
    const val = parseInt(saved, 10);
    if (!props.docked && !isNaN(val) && val >= 200 && val <= 800) {
      drawerHeight.value = val;
    }
  }
} catch {}

function isWaveformData(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('>')) return true;
  if (t.includes(',')) {
    const parts = t.split(',');
    if (parts.length >= 2 && parts.every((p) => {
      const v = p.trim();
      return v !== '' && !isNaN(Number(v));
    })) {
      return true;
    }
  }
  return false;
}

const filteredLogs = computed(() => {
  let list = props.logs;
  if (filterMode.value === 'control') {
    list = list.filter((l) => l.tag.includes('TX') || l.tag.includes('RX') || l.tag.includes('控件'));
  } else if (filterMode.value === 'text') {
    list = list.filter((l) => !isWaveformData(l.text));
  }

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    list = list.filter((l) => l.text.toLowerCase().includes(q) || l.tag.toLowerCase().includes(q));
  }
  return list;
});

function scrollToBottom(force = false) {
  if (!force && isUserScrolledUp.value && autoScroll.value) {
    return;
  }
  nextTick(() => {
    if (terminalBodyRef.value) {
      terminalBodyRef.value.scrollTop = terminalBodyRef.value.scrollHeight;
    }
  });
}

function handleScroll() {
  if (!terminalBodyRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = terminalBodyRef.value;
  isUserScrolledUp.value = scrollHeight - (scrollTop + clientHeight) > 35;
}

watch(
  () => props.logs.length,
  () => {
    if (autoScroll.value) {
      scrollToBottom();
    }
  }
);

watch(
  () => props.isOpen,
  (val) => {
    if (val) {
      nextTick(() => scrollToBottom(true));
    }
  }
);

function formatDisplay(text: string, asHex: boolean): string {
  if (!asHex) return text;
  const trimmed = text.trim();
  if (/^[0-9A-Fa-f]{2}(\s+[0-9A-Fa-f]{2})*$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function handleExportLogs() {
  if (filteredLogs.value.length === 0) return;
  const lines = filteredLogs.value.map((l) => `[${l.time}] ${l.tag} ${l.text}`);
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `terminal_log_${dateStr}.log`;
  a.click();
  URL.revokeObjectURL(url);
}

// 顶部拖拽调整高度
function startResize(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startY = e.clientY;
  const startH = drawerHeight.value;

  function onMouseMove(me: MouseEvent) {
    const delta = startY - me.clientY;
    const newH = Math.max(200, Math.min(window.innerHeight * 0.85, startH + delta));
    drawerHeight.value = Math.round(newH);
  }

  function onMouseUp() {
    isResizing.value = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    try {
      localStorage.setItem(STORAGE_KEY_DRAWER_HEIGHT, String(drawerHeight.value));
    } catch {}
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

// 快捷键支持
function handleGlobalKeyDown(e: KeyboardEvent) {
  if (!props.isOpen) return;
  if (e.key === 'Escape') {
    emit('close');
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown);
});
</script>

<template>
  <div
    v-if="props.isOpen"
    class="terminal-log-drawer"
    :class="{ docked: props.docked }"
    :style="{ height: `${drawerHeight}px` }"
  >
    <!-- 上边缘拖动手柄 -->
    <div class="resize-handle" @mousedown="startResize">
      <div class="handle-bar"></div>
    </div>

    <!-- 抽屉顶部工具栏 -->
    <header class="drawer-header">
      <div class="header-left">
        <div class="title-wrap">
          <svg class="w-4 h-4 text-sky-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          <span class="title-text">串口终端</span>
          <span class="count-pill">{{ filteredLogs.length }} / {{ props.logs.length }} 行</span>
        </div>

        <!-- 过滤分流胶囊 -->
        <div class="filter-capsules">
          <button
            class="filter-btn"
            :class="{ active: filterMode === 'text' }"
            @click="filterMode = 'text'"
            title="仅显示文本日志，过滤纯波形数值"
          >
            仅文本日志
          </button>
          <button
            class="filter-btn"
            :class="{ active: filterMode === 'all' }"
            @click="filterMode = 'all'"
            title="显示全部日志；原始字节以记录文件为准"
          >
            全部日志
          </button>
          <button
            class="filter-btn"
            :class="{ active: filterMode === 'control' }"
            @click="filterMode = 'control'"
            title="仅显示指令发送与硬件回显"
          >
            仅控制交互
          </button>
        </div>
      </div>

      <div class="header-right">
        <!-- 搜索过滤 -->
        <div class="search-wrap">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索日志关键字..."
            aria-label="搜索日志"
            class="search-input"
          />
          <button v-if="searchQuery" class="clear-search" @click="searchQuery = ''">✕</button>
        </div>

        <!-- HEX 视图切换 -->
        <button
          class="tool-btn"
          :class="{ active: displayAsHex }"
          @click="displayAsHex = !displayAsHex"
          title="以十六进制 HEX 格式查看日志文本"
        >
          HEX
        </button>

        <!-- 自动滚动 -->
        <button
          class="tool-btn"
          :class="{ active: autoScroll }"
          @click="autoScroll = !autoScroll"
          title="新日志到达时自动滚至底部"
        >
          滚屏
        </button>

        <!-- 导出日志 -->
        <button class="tool-btn" @click="handleExportLogs" title="导出日志到本地 .log 文件">
          导出
        </button>

        <!-- 清屏 -->
        <button class="tool-btn text-amber-400" @click="emit('clear-logs')" title="清空当前所有屏幕日志">
          清屏
        </button>

        <!-- 收起抽屉按钮 -->
        <button class="btn-collapse" @click="emit('close')" title="收起抽屉 (Esc 或 Ctrl + ~)">
          <span>▼ 收起</span>
          <kbd class="kbd-esc">Esc</kbd>
        </button>
      </div>
    </header>

    <!-- 日志流渲染区域 -->
    <div
      ref="terminalBodyRef"
      class="terminal-log-body"
      @scroll="handleScroll"
    >
      <div v-if="filteredLogs.length === 0" class="empty-log-state">
        <span>暂无匹配的串口日志</span>
      </div>

      <div
        v-for="log in filteredLogs"
        :key="log.id"
        class="log-row"
        :class="`log-level-${log.level}`"
      >
        <span class="log-time">{{ log.time }}</span>
        <span class="log-tag" :class="`tag-${log.tag.replace(/[^a-zA-Z0-9]/g, '')}`">{{ log.tag }}</span>
        <span class="log-text font-mono">{{ formatDisplay(log.text, displayAsHex) }}</span>

        <button
          class="btn-diagnose"
          @click="emit('diagnose-log', log)"
          title="选择此日志供 AI 分析；不会立即请求模型"
        >
          选择给 AI
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-log-drawer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 38px; /* 位于底部控制条之上 */
  background: var(--bg-surface, #272623);
  border-top: 2px solid var(--accent-terracotta, #DA7756);
  box-shadow: var(--card-shadow, 0 -8px 30px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  z-index: 35;
  user-select: text;
  animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background-color 0.25s ease, border-color 0.25s ease;
}
.terminal-log-drawer.docked { position:relative; bottom:auto; flex:none; height:200px; max-height:35vh; min-height:120px; box-shadow:none; border-top:1px solid var(--border-strong); animation:none; }
.docked .drawer-header { flex-wrap:wrap; height:auto; min-height:38px; gap:8px; padding:6px 12px; }
.docked .header-left,.docked .header-right { flex-wrap:wrap; gap:8px; }
.docked .terminal-log-body { font-size:var(--terminal-font-size,12px); }
.docked .kbd-esc { display:none; }

@keyframes slideUp {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.resize-handle {
  height: 8px;
  width: 100%;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  margin-top: -4px;
}

.handle-bar {
  width: 48px;
  height: 3px;
  background: var(--border-strong, #4A4843);
  border-radius: 9999px;
  transition: background 0.15s;
}

.resize-handle:hover .handle-bar {
  background: var(--accent-terracotta, #DA7756);
}

.drawer-header {
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-elevated, #2F2E2A);
  user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.title-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.title-wrap svg {
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  flex-shrink: 0;
}

.title-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.count-pill {
  font-size: 10px;
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  padding: 1px 6px;
  border-radius: 9999px;
  font-family: var(--font-mono, monospace);
  font-weight: 600;
}

.filter-capsules {
  display: flex;
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  overflow: hidden;
}

.filter-btn {
  background: var(--bg-surface, #272623);
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  padding: 3px 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.filter-btn:hover {
  color: var(--text-main, #ECEAE4);
}

.filter-btn.active {
  background: var(--accent-terracotta, #DA7756);
  color: white;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.search-input {
  width: 140px;
  height: 24px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 0 20px 0 6px;
  font-size: 10px;
  color: var(--text-main, #ECEAE4);
  outline: none;
  transition: all 0.15s ease;
}

.search-input:focus {
  border-color: var(--accent-terracotta, #DA7756);
  width: 180px;
}

.clear-search {
  position: absolute;
  right: 4px;
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 10px;
}

.tool-btn {
  height: 24px;
  padding: 0 8px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.tool-btn.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.btn-collapse {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  background: rgba(224, 109, 133, 0.12);
  border: 1px solid rgba(224, 109, 133, 0.3);
  border-radius: 4px;
  color: #E06D85;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-collapse:hover {
  background: rgba(224, 109, 133, 0.22);
  border-color: #E06D85;
}

.kbd-esc {
  font-size: 9px;
  background: rgba(0, 0, 0, 0.2);
  padding: 0 3px;
  border-radius: 2px;
}

.terminal-log-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 12px;
  background: var(--bg-base, #1F1E1D);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.empty-log-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
}

.log-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--terminal-font-size, 11px);
  line-height: 1.45;
  padding: 1px 4px;
  border-radius: 3px;
}

.log-row:hover {
  background: var(--bg-surface, #272623);
}

.log-time {
  color: var(--text-soft, #706E66);
  font-size: 10px;
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
}

.log-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  flex-shrink: 0;
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-muted, #9E9C94);
}

.tag-RX {
  color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
}

.tag-TX {
  color: #9D6CF0;
  background: rgba(157, 108, 240, 0.12);
}

.log-level-info .log-text {
  color: var(--text-main, #ECEAE4);
}

.log-level-warn {
  background: rgba(229, 158, 56, 0.08);
}
.log-level-warn .log-tag {
  color: #E59E38;
  background: rgba(229, 158, 56, 0.2);
}
.log-level-warn .log-text {
  color: #E59E38;
}

.log-level-error {
  background: rgba(224, 109, 133, 0.1);
}
.log-level-error .log-tag {
  color: #E06D85;
  background: rgba(224, 109, 133, 0.2);
}
.log-level-error .log-text {
  color: #E06D85;
  font-weight: 500;
}

.log-text {
  flex: 1;
  font-size: var(--terminal-font-size, 11px);
  word-break: break-all;
  white-space: pre-wrap;
  font-family: var(--font-mono, monospace);
}

.btn-diagnose {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  border-radius: 3px;
  padding: 0 5px;
  font-size: 10px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.btn-diagnose:hover {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
}
</style>
