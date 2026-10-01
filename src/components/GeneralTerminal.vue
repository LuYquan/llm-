<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import EventCapsule from './EventCapsule.vue';
import type { FirmwareAnomaly } from '../core/copilot/types';
import type { RxOrigin } from '../types/ipc';

export interface LogLine {
  id: number;
  time: string;
  /** Display/dispatch wall clock; never used as proof of raw receive order. */
  at?: number;
  rx_origin?: RxOrigin;
  tag: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const props = defineProps<{
  logs: LogLine[];
  isRunning: boolean;
  activeAnomaly?: FirmwareAnomaly | null;
}>();

const emit = defineEmits<{
  (e: 'send-data', data: string, isHex: boolean, appendNewline: boolean, escapeText?: boolean): void;
  (e: 'clear-logs'): void;
  (e: 'diagnose-log', log: LogLine): void;
  (e: 'wake-copilot-anomaly', anomaly: FirmwareAnomaly): void;
}>();

const sendText = ref('');
const sendAsHex = ref(false);
const appendNewline = ref(true);
const escapeText = ref(true);
const displayAsHex = ref(false);
const autoScroll = ref(true);
const isUserScrolledUp = ref(false);

// 日志过滤模式: text (仅文本日志) | all (全部原始流) | control (仅控制交互)
const filterMode = ref<'text' | 'all' | 'control'>('text');

const terminalBody = ref<HTMLDivElement | null>(null);

// 发送历史记录 (按上/下方向键切换)
const history = ref<string[]>([]);
const historyIndex = ref<number>(-1);

const sendNotice = ref('');
let noticeTimer: number | null = null;

function showNotice(msg: string) {
  sendNotice.value = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    sendNotice.value = '';
  }, 3500);
}

// 可手动拖拽调节接收与发送区域比例 (用户可自由上下拉伸)
const sendPanelHeight = ref(140);
const isResizing = ref(false);

const STORAGE_KEY_HEIGHT = 'llm_terminal_send_panel_height';
try {
  const saved = localStorage.getItem(STORAGE_KEY_HEIGHT);
  if (saved) {
    const parsed = parseInt(saved, 10);
    if (!isNaN(parsed) && parsed >= 80 && parsed <= 600) {
      sendPanelHeight.value = parsed;
    }
  }
} catch {
  // 忽略 localStorage 异常
}

function startResize(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startY = e.clientY;
  const startH = sendPanelHeight.value;

  function onMouseMove(moveEvent: MouseEvent) {
    const delta = startY - moveEvent.clientY;
    const newH = Math.max(80, Math.min(window.innerHeight * 0.7, startH + delta));
    sendPanelHeight.value = Math.round(newH);
  }

  function onMouseUp() {
    isResizing.value = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    try {
      localStorage.setItem(STORAGE_KEY_HEIGHT, String(sendPanelHeight.value));
    } catch {
      // ignore
    }
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function handleSend() {
  if (sendText.value.length === 0) return;

  if (!props.isRunning) {
    showNotice('⚠️ 串口未打开，请先点击顶部“打开串口”后再发送数据');
    return;
  }

  const content = sendText.value;
  emit('send-data', content, sendAsHex.value, appendNewline.value, escapeText.value);

  // 记录到历史
  if (history.value.length === 0 || history.value[history.value.length - 1] !== content) {
    history.value.push(content);
    if (history.value.length > 50) history.value.shift();
  }
  historyIndex.value = -1;
  sendText.value = '';

  if (autoScroll.value) {
    scrollToBottom();
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  } else if (e.key === 'ArrowUp') {
    if (history.value.length === 0) return;
    e.preventDefault();
    if (historyIndex.value === -1) {
      historyIndex.value = history.value.length - 1;
    } else if (historyIndex.value > 0) {
      historyIndex.value--;
    }
    sendText.value = history.value[historyIndex.value] || '';
  } else if (e.key === 'ArrowDown') {
    if (history.value.length === 0 || historyIndex.value === -1) return;
    e.preventDefault();
    if (historyIndex.value < history.value.length - 1) {
      historyIndex.value++;
      sendText.value = history.value[historyIndex.value] || '';
    } else {
      historyIndex.value = -1;
      sendText.value = '';
    }
  }
}

function handleScroll() {
  if (!terminalBody.value) return;
  const { scrollTop, scrollHeight, clientHeight } = terminalBody.value;
  // 距离底部超过 35px 判定为用户在翻阅历史
  isUserScrolledUp.value = scrollHeight - (scrollTop + clientHeight) > 35;
}

function scrollToBottom(force = false) {
  if (!force && isUserScrolledUp.value && autoScroll.value) {
    // 用户正在向上翻看历史日志，暂停强制拉底
    return;
  }
  nextTick(() => {
    if (terminalBody.value) {
      terminalBody.value.scrollTop = terminalBody.value.scrollHeight;
    }
  });
}

function isWaveformData(text: string): boolean {
  const t = text.trim();
  // Teleplot 格式 (>name:val)
  if (t.startsWith('>')) return true;
  // CSV 纯数字格式 (包含逗号且各段均为数字)
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

const displayLogs = computed(() => {
  if (filterMode.value === 'all') return props.logs;
  if (filterMode.value === 'control') {
    return props.logs.filter((l) => l.tag.includes('TX') || l.tag.includes('RX') || l.tag.includes('控件'));
  }
  // 'text': 仅文本日志，过滤纯波形
  return props.logs.filter((l) => !isWaveformData(l.text));
});

function handleExportLogs() {
  if (displayLogs.value.length === 0) {
    showNotice('⚠️ 当前暂无可导出的日志');
    return;
  }
  const lines = displayLogs.value.map((l) => `[${l.time}] ${l.tag} ${l.text}`);
  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `serial-logs-${dateStr}.log`;
  a.click();
  URL.revokeObjectURL(url);
  showNotice('✅ 屏幕日志已导出为本地文件');
}

watch(
  () => props.logs.length,
  () => {
    if (autoScroll.value) {
      scrollToBottom();
    }
  }
);

function formatDisplay(text: string, asHex: boolean): string {
  if (!asHex) return text;
  // 若本身已经是空格分隔的 HEX 字节串 (如 TX 记录的 01 03 00 ...)，直接展示
  const trimmed = text.trim();
  if (/^[0-9A-Fa-f]{2}(\s+[0-9A-Fa-f]{2})*$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  // 否则转为 HEX 字节展示
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function appendPreset(str: string) {
  sendText.value = (sendText.value + ' ' + str).trim();
}

const isCapsuleVisible = ref(true);
watch(
  () => props.activeAnomaly,
  (newVal) => {
    if (newVal) {
      isCapsuleVisible.value = true;
    }
  }
);

function handleCapsuleClick(anomaly: FirmwareAnomaly) {
  emit('wake-copilot-anomaly', anomaly);
}

function fillSendText(text: string) {
  sendText.value = text.trim();
  nextTick(() => {
    const el = document.querySelector('.send-textarea') as HTMLTextAreaElement | null;
    el?.focus();
  });
}

defineExpose({
  appendPreset,
  fillSendText,
});
</script>

<template>
  <div class="general-terminal" :class="{ 'user-resizing': isResizing }">
    <!-- 终端顶部状态栏 -->
    <div class="terminal-toolbar">
      <div class="toolbar-left">
        <span class="terminal-title">常规调试中枢</span>

        <!-- 日志分流过滤胶囊 -->
        <div class="filter-capsules">
          <button
            type="button"
            class="filter-capsule-btn"
            :class="{ active: filterMode === 'text' }"
            @click="filterMode = 'text'"
            title="仅显示文本日志与控制回显，过滤高频波形纯数值"
          >
            仅文本日志
          </button>
          <button
            type="button"
            class="filter-capsule-btn"
            :class="{ active: filterMode === 'all' }"
            @click="filterMode = 'all'"
            title="全量显示所有原始数据流（包含纯数值波形帧）"
          >
            全部原始流
          </button>
          <button
            type="button"
            class="filter-capsule-btn"
            :class="{ active: filterMode === 'control' }"
            @click="filterMode = 'control'"
            title="仅显示指令发送 [TX] 与应答 [RX]"
          >
            仅控制交互
          </button>
        </div>

        <label class="view-opt">
          <input type="checkbox" v-model="displayAsHex" />
          <span>HEX 显示</span>
        </label>
        <label class="view-opt">
          <input type="checkbox" v-model="autoScroll" />
          <span>自动滚屏</span>
        </label>
      </div>

      <div class="toolbar-right">
        <button class="btn-tool" @click="handleExportLogs" title="导出当前屏幕日志为本地文件">
          <span>💾 导出</span>
        </button>
        <button class="btn-tool" @click="emit('clear-logs')" title="清空接收区">
          <span>🧹 清屏</span>
        </button>
      </div>
    </div>

    <!-- 终端日志内容区 -->
    <div class="terminal-body font-mono" ref="terminalBody" @scroll="handleScroll">
      <div
        v-for="log in displayLogs"
        :key="log.id"
        class="terminal-row"
        :class="[log.level, log.tag.includes('TX') ? 'tx-row' : 'rx-row']"
      >
        <span class="col-time">[{{ log.time }}]</span>
        <span class="col-tag">{{ log.tag }}</span>
        <span class="col-content">{{ formatDisplay(log.text, displayAsHex) }}</span>
        <button
          v-if="log.level === 'error' || log.level === 'warn'"
          class="btn-diagnose"
          title="点击请求 AI 智能诊断此错误"
          @click="emit('diagnose-log', log)"
        >
          💡AI 诊断
        </button>
      </div>

      <div v-if="displayLogs.length === 0" class="empty-terminal">
        <span>{{ filterMode === 'text' ? '无文本日志 (高频波形流正在后台全速绘制中)' : '终端空闲，等待数据交互...' }}</span>
      </div>

      <!-- 向上滚动时浮现的快速回到最新徽标 -->
      <transition name="fade">
        <button
          v-if="isUserScrolledUp"
          type="button"
          class="scroll-bottom-floating-badge"
          @click="isUserScrolledUp = false; scrollToBottom(true)"
          title="点击瞬间滚动至最新实时数据"
        >
          <span>↓ 发现新数据 (点击回到底部)</span>
        </button>
      </transition>
    </div>

    <!-- 接收区与发送区垂直比例拖拽手柄条 -->
    <div
      class="terminal-splitter"
      :class="{ active: isResizing }"
      @mousedown="startResize"
      title="按住鼠标上下拖拽，调整接收窗口与发送输入框比例"
    >
      <div class="splitter-handle"></div>
    </div>

    <!-- 终端发送区 (高度由 sendPanelHeight 动态控制) -->
    <div class="terminal-send-panel" :style="{ height: sendPanelHeight + 'px' }">
      <!-- 事件胶囊：固件/通道异常唤醒 Copilot (任务 2.1) -->
      <EventCapsule
        :anomaly="props.activeAnomaly || null"
        :visible="isCapsuleVisible && !!props.activeAnomaly"
        @click="handleCapsuleClick"
        @dismiss="isCapsuleVisible = false"
      />

      <div class="send-options-bar">
        <label class="send-opt">
          <input type="checkbox" v-model="sendAsHex" />
          <span>HEX 发送</span>
        </label>
        <label class="send-opt">
          <input type="checkbox" v-model="appendNewline" />
          <span>自动附加新行 (\r\n)</span>
        </label>
        <label class="send-opt" :class="{ disabled: sendAsHex }" title="将文本中的 \r、\n、\t 和 \\ 转为对应字节">
          <input type="checkbox" v-model="escapeText" :disabled="sendAsHex" />
          <span>解析转义</span>
        </label>
        <transition name="fade">
          <span class="send-warn-msg" v-if="sendNotice">
            {{ sendNotice }}
          </span>
        </transition>
        <span class="history-hint" v-if="history.length > 0">
          ↑/↓ 键切换发送历史 ({{ history.length }})
        </span>
      </div>

      <div class="send-input-group">
        <textarea
          class="send-textarea font-mono"
          v-model="sendText"
          :placeholder="sendAsHex ? '输入十六进制字节 (如 01 03 00 00 00 02 C4 0B)...' : '输入指令文本，回车或点击发送...'"
          @keydown="handleKeyDown"
        ></textarea>
        <button
          class="btn-submit-send"
          :class="{ 'btn-not-connected': !isRunning }"
          :disabled="!sendText.trim()"
          @click="handleSend"
          :title="isRunning ? '发送指令 (Enter)' : '串口尚未打开，点击将提示'"
        >
          <span>发送 (Enter)</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.general-terminal {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-base);
  overflow: hidden;
}

.terminal-toolbar {
  height: 38px;
  background-color: var(--bg-panel);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.terminal-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.filter-capsules {
  display: flex;
  align-items: center;
  gap: 2px;
  background-color: rgba(0, 0, 0, 0.3);
  padding: 2px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.filter-capsule-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.filter-capsule-btn:hover {
  color: var(--text-main);
}

.filter-capsule-btn.active {
  background-color: var(--bg-elevated);
  color: var(--accent-terracotta);
  border-color: rgba(218, 119, 86, 0.3);
  font-weight: 500;
}

.scroll-bottom-floating-badge {
  position: absolute;
  bottom: 16px;
  right: 20px;
  background: var(--accent-terracotta);
  color: #ffffff;
  border: 1px solid rgba(218, 119, 86, 0.6);
  border-radius: 20px;
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 10;
  transition: all 0.2s ease;
  animation: bounce 1.5s infinite;
}

.scroll-bottom-floating-badge:hover {
  background: #0369a1;
  transform: translateY(-2px);
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

.view-opt {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-tool {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: 3px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-tool:hover {
  background-color: var(--bg-card-hover);
  color: var(--text-primary);
}

.terminal-body {
  flex: 1;
  padding: 10px 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  line-height: 1.6;
}

.terminal-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  position: relative;
}

.col-time {
  color: var(--text-muted);
  flex-shrink: 0;
  user-select: none;
}

.col-tag {
  font-weight: 600;
  flex-shrink: 0;
}

.rx-row .col-tag {
  color: var(--accent-emerald);
}

.tx-row .col-tag {
  color: var(--accent-cyan);
}

.terminal-row.warn .col-tag {
  color: var(--accent-amber);
}

.terminal-row.error .col-tag {
  color: var(--accent-rose);
}

.col-content {
  color: var(--text-primary);
  word-break: break-all;
  flex: 1;
}

.btn-diagnose {
  padding: 1px 6px;
  font-size: 10px;
  background-color: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--accent-amber);
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s;
}

.btn-diagnose:hover {
  background-color: rgba(245, 158, 11, 0.3);
}

.empty-terminal {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
}

.general-terminal.user-resizing {
  user-select: none;
  cursor: row-resize;
}

/* 接收区与发送区垂直比例拖拽分割线 */
.terminal-splitter {
  height: 8px;
  background-color: var(--bg-panel);
  border-top: 1px solid var(--border-color);
  border-bottom: 1px solid rgba(0, 0, 0, 0.4);
  cursor: row-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 10;
  transition: background-color 0.2s, border-color 0.2s;
}

.terminal-splitter:hover,
.terminal-splitter.active {
  background-color: rgba(14, 165, 233, 0.2);
  border-top-color: var(--accent-cyan);
}

.splitter-handle {
  width: 36px;
  height: 3px;
  background-color: rgba(255, 255, 255, 0.25);
  border-radius: 2px;
  transition: all 0.2s;
}

.terminal-splitter:hover .splitter-handle,
.terminal-splitter.active .splitter-handle {
  width: 48px;
  height: 4px;
  background-color: var(--accent-cyan);
  box-shadow: 0 0 6px rgba(14, 165, 233, 0.8);
}

.terminal-send-panel {
  background-color: var(--bg-panel);
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
  box-sizing: border-box;
}

.send-options-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 11px;
}

.send-opt {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}

.send-warn-msg {
  color: var(--accent-amber);
  font-size: 11px;
  font-weight: 500;
  background-color: rgba(245, 158, 11, 0.12);
  padding: 1px 8px;
  border-radius: 3px;
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.history-hint {
  color: var(--text-muted);
  font-size: 10px;
  margin-left: auto;
}

.send-input-group {
  display: flex;
  gap: 8px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
}

.send-textarea {
  flex: 1;
  height: 100%;
  min-height: 40px;
  background-color: var(--bg-base);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
  resize: none;
  box-sizing: border-box;
}

.send-textarea:focus {
  border-color: var(--accent-terracotta);
}

.btn-submit-send {
  padding: 0 18px;
  background-color: var(--accent-terracotta);
  border: 1px solid rgba(218, 119, 86, 0.6);
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-submit-send:hover:not(:disabled) {
  background-color: #c4673d;
}

.btn-submit-send.btn-not-connected {
  background-color: var(--bg-elevated);
  border-color: var(--border-subtle);
}

.btn-submit-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
