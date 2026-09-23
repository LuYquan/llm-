<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

export interface LogLine {
  id: number;
  time: string;
  tag: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const props = defineProps<{
  logs: LogLine[];
  isRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'send-data', data: string, isHex: boolean, appendNewline: boolean): void;
  (e: 'clear-logs'): void;
  (e: 'diagnose-log', log: LogLine): void;
}>();

const sendText = ref('');
const sendAsHex = ref(false);
const appendNewline = ref(true);
const displayAsHex = ref(false);
const autoScroll = ref(true);

const terminalBody = ref<HTMLDivElement | null>(null);

// 发送历史记录 (按上/下方向键切换)
const history = ref<string[]>([]);
const historyIndex = ref<number>(-1);

function handleSend() {
  if (!sendText.value.trim() || !props.isRunning) return;

  const content = sendText.value;
  emit('send-data', content, sendAsHex.value, appendNewline.value);

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

function scrollToBottom() {
  nextTick(() => {
    if (terminalBody.value) {
      terminalBody.value.scrollTop = terminalBody.value.scrollHeight;
    }
  });
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

defineExpose({
  appendPreset,
});
</script>

<template>
  <div class="general-terminal">
    <!-- 终端顶部状态栏 -->
    <div class="terminal-toolbar">
      <div class="toolbar-left">
        <span class="terminal-title">常规串口调试视窗</span>
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
        <button class="btn-tool" @click="emit('clear-logs')" title="清屏">
          <span>🧹 清屏</span>
        </button>
      </div>
    </div>

    <!-- 终端日志内容区 -->
    <div class="terminal-body font-mono" ref="terminalBody">
      <div
        v-for="log in logs"
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

      <div v-if="logs.length === 0" class="empty-terminal">
        <span>终端空闲，等待数据交互...</span>
      </div>
    </div>

    <!-- 终端发送区 -->
    <div class="terminal-send-panel">
      <div class="send-options-bar">
        <label class="send-opt">
          <input type="checkbox" v-model="sendAsHex" />
          <span>HEX 发送</span>
        </label>
        <label class="send-opt">
          <input type="checkbox" v-model="appendNewline" />
          <span>自动附加新行 (\r\n)</span>
        </label>
        <span class="history-hint" v-if="history.length > 0">
          ↑/↓ 键切换发送历史 ({{ history.length }})
        </span>
      </div>

      <div class="send-input-group">
        <textarea
          class="send-textarea font-mono"
          v-model="sendText"
          :placeholder="sendAsHex ? '输入十六进制字节 (如 01 03 00 00 00 02 C4 0B)...' : '输入指令文本，回车或点击发送...'"
          rows="2"
          @keydown="handleKeyDown"
          :disabled="!isRunning"
        ></textarea>
        <button
          class="btn-submit-send"
          :disabled="!isRunning || !sendText.trim()"
          @click="handleSend"
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
  background-color: #080c14;
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

.terminal-send-panel {
  background-color: var(--bg-panel);
  border-top: 1px solid var(--border-color);
  padding: 8px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
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

.history-hint {
  color: var(--text-muted);
  font-size: 10px;
  margin-left: auto;
}

.send-input-group {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.send-textarea {
  flex: 1;
  background-color: rgba(11, 15, 23, 0.8);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
  resize: none;
}

.send-textarea:focus {
  border-color: var(--accent-cyan);
}

.btn-submit-send {
  padding: 0 18px;
  background-color: #0284c7;
  border: 1px solid #0ea5e9;
  border-radius: 4px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.btn-submit-send:hover:not(:disabled) {
  background-color: #0369a1;
}

.btn-submit-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
