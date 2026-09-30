<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import type { FirmwareAnomaly } from '../core/copilot/types';
import type { QuickCmd } from './QuickCommandPanel.vue';
import type { CommandLineEnding } from '../services/transport/command-encoder';
import { globalChannelStore } from '../core/channel/ChannelStore';
import { useWidgetStore } from '../stores/widgetStore';
import {
  formatBytes,
  calcTimeDiv,
  isScrubbingActive,
  CommandHistoryManager,
} from '../utils/terminalHelpers';

const props = defineProps<{
  isRunning: boolean;
  isPaused: boolean;
  totalSamples: number;
  sampleRate: number;
  droppedBytes?: number;
  activeAnomaly?: FirmwareAnomaly | null;
  phaseMargin?: number;
  quickCommands: QuickCmd[];
  unreadLogCount: number;
  isTerminalOpen: boolean;
  activeChannels?: string[];
  rxBytes?: number | null;
  txBytes?: number | null;
  sendCommand: (data: string, isHex: boolean, appendNewline: boolean, escapeText: boolean, lineEnding: CommandLineEnding) => Promise<void>;
}>();

const emit = defineEmits<{
  (e: 'toggle-pause'): void;
  (e: 'clear-buffer'): void;
  (e: 'auto-scale'): void;
  (e: 'scrub-history', ratio: number): void;
  (e: 'resume-live'): void;
  (e: 'wake-copilot', anomaly?: FirmwareAnomaly): void;
  (e: 'toggle-terminal'): void;
  (e: 'emergency-stop'): void;
  (e: 'send-quick-command', cmd: QuickCmd): void;
  (e: 'clear-terminal-logs'): void;
  (e: 'open-command-drawer'): void;
}>();

const widgetStore = useWidgetStore();

// ==================== 高级流控与时基回溯参数 ====================
const stepDeltaT = ref<number>(1); // ms
const bufferCapacity = ref<number>(50000); // 点/ch
const bufferCapacityNotice = ref('');
const bufferSummary = computed(() => {
  void props.totalSamples;
  return globalChannelStore.getBufferSummary();
});
const batchAlignPoints = ref<number>(100);
const THEME_STORAGE_KEY = 'llm-serial.theme-mode';
const currentTheme = ref<'dark' | 'light'>('dark');

if (typeof document !== 'undefined') {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    currentTheme.value = saved === 'light' ? 'light' : 'dark';
  } catch {
    currentTheme.value = 'dark';
  }
}

// 监听波形主题切换
watch(currentTheme, (theme) => {
  if (typeof document !== 'undefined') {
    if (theme === 'light') {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
});

// 气泡弹窗开关
const isFlowSettingsOpen = ref(false);
const popoverAnchorRef = ref<HTMLElement | null>(null);

// 监听缓冲容量设置变化
watch(bufferCapacity, (newCap) => {
  if (!Number.isFinite(newCap) || newCap < 1000) return;
  const result = globalChannelStore.setDefaultCapacity(newCap);
  if (bufferCapacity.value !== result.capacity) bufferCapacity.value = result.capacity;
  bufferCapacityNotice.value = result.droppedPoints > 0
    ? `容量调整丢弃了 ${result.droppedPoints.toLocaleString()} 个最旧显示点；已保留最近 ${result.capacity.toLocaleString()} 点/通道。`
    : `已将 ${bufferSummary.value.channelCount} 个活动通道的缓冲容量设为 ${result.capacity.toLocaleString()} 点/通道。`;
});

// Scrubber 进度条状态 (0 ~ 100%)
const scrubberPos = ref<number>(100);
const isScrubbing = ref<boolean>(false);

// 监听全局回溯状态 (例如图表内部双击或点击复位恢复实时)
watch(
  () => widgetStore.scrubState.value.isScrubbing,
  (active) => {
    if (!active) {
      scrubberPos.value = 100;
      isScrubbing.value = false;
    }
  }
);

function handleScrubberInput(e: Event) {
  const val = parseFloat((e.target as HTMLInputElement).value);
  scrubberPos.value = val;
  isScrubbing.value = isScrubbingActive(val);
  emit('scrub-history', val / 100);
}

function handleResumeLive() {
  scrubberPos.value = 100;
  isScrubbing.value = false;
  emit('resume-live');
}

// 自动跟随最新点数
watch(
  () => props.totalSamples,
  () => {
    if (!isScrubbing.value) {
      scrubberPos.value = 100;
    }
  }
);

// ==================== 终端控制参数与脉冲 ====================
const consoleFontSize = ref<number>(12); // px
const rxCount = ref<number | null>(props.rxBytes ?? null);
const txCount = ref<number | null>(props.txBytes ?? null);
const isPulseActive = ref(false);
let pulseTimer: number | null = null;

watch(
  () => props.rxBytes,
  (val) => {
    rxCount.value = val ?? null;
  }
);

watch(
  () => props.txBytes,
  (val) => {
    txCount.value = val ?? null;
  }
);

// 当采样率大于 0 或点数增加时触发微动效
watch(
  () => props.totalSamples,
  () => {
    if (props.isRunning) {
      isPulseActive.value = true;
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => {
        isPulseActive.value = false;
      }, 120);
    }
  }
);

function changeFontSize(delta: number) {
  consoleFontSize.value = Math.max(9, Math.min(20, consoleFontSize.value + delta));
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--terminal-font-size', `${consoleFontSize.value}px`);
  }
}

// ==================== 单行快速下发交互 ====================
const sendText = ref('');
const isHex = ref(false);
const escapeText = ref(true);
const newlineType = ref<'crlf' | 'lf' | 'cr' | 'none'>('crlf');
const historyManager = new CommandHistoryManager(50);
const isSendingCommand = ref(false);
const sendError = ref('');
let sendErrorTimer: number | null = null;

async function handleSend() {
  if (sendText.value.length === 0 || isSendingCommand.value) return;
  const content = sendText.value;
  isSendingCommand.value = true;
  sendError.value = '';
  if (sendErrorTimer !== null) window.clearTimeout(sendErrorTimer);
  try {
    await props.sendCommand(content, isHex.value, newlineType.value !== 'none' && !isHex.value, escapeText.value, newlineType.value);
    historyManager.push(content);
    sendText.value = '';
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error);
    sendErrorTimer = window.setTimeout(() => { sendError.value = ''; }, 6000);
  } finally {
    isSendingCommand.value = false;
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    sendText.value = historyManager.arrowUp(sendText.value);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    sendText.value = historyManager.arrowDown();
  }
}

// 全局 Alt+S 快捷下发监听
function handleGlobalAltS(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target?.closest('input,textarea,select,[contenteditable=true]') && !target.classList.contains('single-line-input')) return;
  if (e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    handleSend();
  }
}

// 点击气泡外部自动关闭
function handleDocumentPointerDown(e: MouseEvent) {
  if (isFlowSettingsOpen.value && popoverAnchorRef.value) {
    if (!popoverAnchorRef.value.contains(e.target as Node)) {
      isFlowSettingsOpen.value = false;
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalAltS);
  window.addEventListener('pointerdown', handleDocumentPointerDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalAltS);
  window.removeEventListener('pointerdown', handleDocumentPointerDown);
  if (pulseTimer) clearTimeout(pulseTimer);
  if (sendErrorTimer !== null) clearTimeout(sendErrorTimer);
});

function handleQuickCmdClick(cmd: QuickCmd) {
  if (cmd.danger) {
    emit('emergency-stop');
    return;
  }
  emit('send-quick-command', cmd);
}

function fillSendInput(text: string) {
  sendText.value = text;
}

function fillCommandDraft(draft: { input: string; encoding: 'text' | 'hex'; escapeText: boolean; lineEnding: CommandLineEnding }) {
  sendText.value = draft.input;
  isHex.value = draft.encoding === 'hex';
  escapeText.value = draft.escapeText;
  newlineType.value = draft.lineEnding;
}

function clearSendInput() {
  sendText.value = '';
  historyManager.resetNavigation();
}

defineExpose({
  fillSendInput,
  fillCommandDraft,
});
</script>

<template>
  <footer class="docked-terminal-strip">
    <!-- 单行极简控制条 (高度 38px) -->
    <div class="strip-main-bar">
      <!-- 1. 左侧区：终端日志抽屉开关 + 紧凑 Copilot 胶囊 -->
      <div class="bar-left-zone">
        <!-- 终端日志抽屉开关 [▲ 终端日志] 带未读徽标 -->
        <button
          class="btn-toggle-terminal-drawer"
          :class="{ active: props.isTerminalOpen }"
          @click="emit('toggle-terminal')"
          title="展开/隐藏终端系统日志抽屉 (快捷键: Ctrl + ~)"
        >
          <span class="drawer-arrow">{{ props.isTerminalOpen ? '▼' : '▲' }}</span>
          <span class="drawer-label">{{ props.isTerminalOpen ? '收起终端' : '终端日志' }}</span>
          <span v-if="!props.isTerminalOpen && props.unreadLogCount > 0" class="badge-unread">
            {{ props.unreadLogCount > 99 ? '99+' : props.unreadLogCount }}
          </span>
        </button>

        <!-- Copilot 极简状态胶囊 -->
        <button
          v-if="props.activeAnomaly"
          type="button"
          class="copilot-capsule anomaly-capsule"
          @click="emit('wake-copilot', props.activeAnomaly)"
          title="日志中发现异常线索，选择后交给 AI 分析"
        >
          <svg class="anomaly-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/></svg>
          <span class="capsule-text font-bold">[{{ props.activeAnomaly.type }}]</span>
          <svg class="arrow-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>
        </button>
        <button
          v-else
          type="button"
          class="copilot-capsule normal-capsule"
          @click="emit('wake-copilot')"
          title="打开任务型 AI 调试助手"
        >
          <svg class="agent-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z"/><path d="M8 9h8m-8 3h5"/></svg>
          <span class="capsule-text">
            解读日志
          </span>
        </button>
      </div>

      <!-- 2. 中间区：主发送链路 (格式/输入/命令簿/快捷胶囊/换行符/发送) -->
      <div class="bar-center-zone">
        <!-- 格式切换 [Abc/HEX] -->
        <button
          class="btn-input-fmt"
          :class="{ active: isHex }"
          @click="isHex = !isHex"
          title="点击切换输入格式 (UTF-8 文本 / HEX 字节)"
        >
          {{ isHex ? 'HEX' : '文本' }}
        </button>
        <button
          v-if="!isHex"
          class="btn-input-fmt escape-toggle"
          :class="{ active: escapeText }"
          @click="escapeText = !escapeText"
          :aria-pressed="escapeText"
          title="控制 \r、\n、\t 与 \\ 是否转换为转义字节"
        >转义</button>

        <!-- 单行命令输入框 -->
        <div class="dispatch-input-wrapper">
          <input
            v-model="sendText"
            type="text"
            class="single-line-input font-mono"
            aria-label="发送内容"
            :placeholder="isHex ? '输入 HEX 字节 (如 AA 01 55)，↑/↓ 历史，Enter 发送...' : '输入控制命令 (↑/↓ 历史召回，Enter 发送)...'"
            @keydown="handleKeyDown"
          />
          <button v-if="sendText" class="btn-clear-input" @click="clearSendInput" title="清空输入框内容">
            ✕
          </button>
        </div>

        <!-- 常用指令簿呼出按钮 (📋) -->
        <button
          class="strip-btn btn-cmd-book"
          @click="emit('open-command-drawer')"
          title="打开常用命令列表抽屉"
          aria-label="打开命令簿"
        >
          📋
        </button>

        <!-- 快捷指令横向紧凑微胶囊 -->
        <div class="quick-commands-belt" v-if="props.quickCommands && props.quickCommands.length > 0">
          <button
            v-for="cmd in props.quickCommands"
            :key="cmd.id"
            class="quick-cmd-pill"
            :class="{ 'pill-danger': cmd.danger }"
            @click="handleQuickCmdClick(cmd)"
            :title="`${cmd.name}: ${cmd.command}`"
          >
            <span>{{ cmd.name }}</span>
          </button>
        </div>

        <!-- 换行符选单 -->
        <select v-model="newlineType" class="newline-select" title="末尾自动填充换行符" aria-label="末尾换行符">
          <option value="crlf">\r\n (CRLF)</option>
          <option value="lf">\n (LF)</option>
          <option value="cr">\r (CR)</option>
          <option value="none">无换行</option>
        </select>

        <!-- Claude 标志性陶土色实心圆形发送按键 (↵) -->
        <button
          class="btn-dispatch-send"
          :disabled="sendText.length === 0 || isSendingCommand"
          @click="handleSend"
          title="发送命令 (快捷键: Alt + S 或 Enter)"
        >
          <svg v-if="!isSendingCommand" class="claude-send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
          </svg>
          <span>{{ isSendingCommand ? '发送中' : '发送' }}</span>
        </button>
        <span v-if="sendError" class="send-error" role="alert">{{ sendError }}</span>
      </div>

      <!-- 3. 右侧区：解析数据速率与数据脉冲 + [⚙️ 流控与回溯] 气泡按钮 -->
      <div class="bar-right-zone">
        <div class="rate-pulse-group" title="实时通信数据帧率与脉冲波形指示">
          <span class="metric-rate font-mono" :title="props.sampleRate > 0 ? '按解析完成的样本估算，不等同于设备采样时钟' : '暂无有效解析样本'">{{ props.sampleRate > 0 ? `${props.sampleRate.toFixed(0)} Hz` : '—' }}</span>
          <div class="pulse-indicator-box" :class="{ 'is-active': isPulseActive }">
            <span class="pulse-icon">📈</span>
          </div>
        </div>

        <!-- [⚙️ 流控与回溯] 气泡按钮及弹出卡片 -->
        <div class="popover-anchor" ref="popoverAnchorRef">
          <button
            class="strip-btn btn-flow-settings"
            :class="{ active: isFlowSettingsOpen }"
            @click="isFlowSettingsOpen = !isFlowSettingsOpen"
            aria-label="流控与回溯"
            :aria-expanded="isFlowSettingsOpen"
            title="展开高级流控、时基步进、缓冲区容量与历史回溯控制面板"
          >
            <svg class="flow-settings-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4"/></svg>
            <span class="flow-settings-label">流控与回溯</span>
            <span class="arrow-indicator">{{ isFlowSettingsOpen ? '▼' : '▲' }}</span>
          </button>

          <!-- 向上展开的半透明毛玻璃气泡弹窗 -->
          <transition name="popover-fade">
            <div v-if="isFlowSettingsOpen" class="flow-control-popover" @click.stop>
              <!-- 头部 -->
              <div class="popover-header">
                <div class="popover-header-title">
                  <span class="icon">⚙️</span>
                  <span>高级流控与时基回溯</span>
                </div>
                <button class="btn-popover-close" @click="isFlowSettingsOpen = false" title="关闭面板">✕</button>
              </div>

              <!-- 第 1 块：采样与环形缓冲参数 -->
              <div class="popover-section">
                <div class="section-title">采样与缓冲设置</div>
                <div class="section-row params-grid">
                  <div class="param-input-item" title="推算时间轴物理步进 (Δt)">
                    <span class="param-label">Δt:</span>
                    <input v-model.number="stepDeltaT" type="number" min="0.1" step="0.5" class="param-input font-mono" />
                    <span class="param-unit">ms</span>
                  </div>
                  <div class="param-input-item" title="单通道环形缓冲区深度 (RingBuffer 容量)">
                    <span class="param-label">缓冲:</span>
                    <input v-model.number="bufferCapacity" type="number" min="1000" max="50000" step="5000" class="param-input input-wide font-mono" />
                    <span class="param-unit">/ch</span>
                  </div>
                  <div class="param-input-item" title="图表批量对齐重绘粒度">
                    <span class="param-label">对齐:</span>
                    <input v-model.number="batchAlignPoints" type="number" min="10" step="50" class="param-input font-mono" />
                    <span class="param-unit">点</span>
                  </div>
                </div>

                <div class="section-row actions-row">
                  <button class="strip-btn btn-auto-scale" @click="emit('auto-scale')" title="点击对波形图执行 Y 轴与时基全自动缩放">
                    <svg class="w-3 h-3" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="15 3 21 3 21 9"></polyline>
                      <polyline points="9 21 3 21 3 15"></polyline>
                      <line x1="21" y1="3" x2="14" y2="10"></line>
                      <line x1="3" y1="21" x2="10" y2="14"></line>
                    </svg>
                    <span>Auto 量程</span>
                  </button>

                  <button class="strip-btn btn-icon-trash" @click="emit('clear-buffer')" title="清空全部通道历史缓冲数据并复位图表">
                    🗑️ 清空缓冲
                  </button>

                  <div class="buffer-status-text font-mono" title="实际保留的显示点数、活动通道数量和每通道容量">
                    {{ bufferSummary.totalPoints.toLocaleString() }} 点 · {{ bufferSummary.channelCount }} 通道 · {{ bufferCapacity.toLocaleString() }} 点/通道
                  </div>

                  <div class="div-status-text font-mono" title="横坐标时间分度值">
                    {{ calcTimeDiv(stepDeltaT) }}
                  </div>
                </div>
                <p v-if="bufferCapacityNotice" class="buffer-capacity-notice" role="status">{{ bufferCapacityNotice }}</p>
              </div>

              <!-- 第 2 块：核心 Scrubber 历史回溯滑动轴 -->
              <div class="popover-section scrubber-section">
                <div class="section-header-row">
                  <span class="section-title">时间轴历史回溯</span>
                  <span v-if="isScrubbing" class="scrub-badge" @click="handleResumeLive">
                    🔍 回溯中: {{ Math.round((scrubberPos / 100) * props.totalSamples) }} 点
                    <strong class="btn-return-live">返回实时 ➔</strong>
                  </span>
                  <span v-else class="live-badge">
                    <span class="live-dot animate-pulse"></span> 实时流跟随
                  </span>
                </div>
                <div class="scrubber-track-wrap">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    :value="scrubberPos"
                    class="scrubber-slider"
                    @input="handleScrubberInput"
                  />
                </div>
              </div>

              <!-- 第 3 块：终端控制、编码与通信统计 -->
              <div class="popover-section">
                <div class="section-title">终端控制与通信统计</div>
                <div class="section-row terminal-tools-row">
                  <!-- 文本路径的实际编码；不呈现尚未接入收发的选项 -->
                  <div class="tool-subgroup">
                    <span class="tool-sublabel">编码:</span>
                    <span class="encoding-value" title="文本收发使用 UTF-8；其他字节可用 HEX 发送或查看原始字节。">UTF-8</span>
                  </div>

                  <!-- 字体缩放 -->
                  <div class="tool-subgroup font-zoom-group">
                    <span class="tool-sublabel">字号:</span>
                    <button class="btn-zoom" @click="changeFontSize(1)" title="放大终端字体">+</button>
                    <button class="btn-zoom" @click="changeFontSize(-1)" title="缩小终端字体">-</button>
                  </div>

                  <!-- 清屏 -->
                  <button class="strip-btn btn-clear-screen" @click="emit('clear-terminal-logs')" title="清空终端控制台打印历史">
                    🧹 清屏
                  </button>

                  <!-- 波形主题选择 -->
                  <div class="tool-subgroup theme-group">
                    <span class="tool-sublabel">主题:</span>
                    <div class="theme-buttons">
                      <button class="theme-btn" :class="{ active: currentTheme === 'dark' }" @click="currentTheme = 'dark'">🌙 暖黑</button>
                      <button class="theme-btn" :class="{ active: currentTheme === 'light' }" @click="currentTheme = 'light'">☀️ 暖白</button>
                    </div>
                  </div>
                </div>

                <!-- 流量统计 -->
                <div class="section-row stats-row">
                  <span class="stat-rx font-mono" title="接收总字节数；— 表示当前传输层没有提供原始字节计数">Rx: {{ rxCount === null ? '—' : formatBytes(rxCount) }}</span>
                  <span class="stat-tx font-mono" title="驱动写入完成的发送字节数；— 表示当前传输层没有提供写入回执">Tx: {{ txCount === null ? '—' : formatBytes(txCount) }}</span>
                </div>
              </div>
            </div>
          </transition>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.docked-terminal-strip {
  width: 100%;
  height: auto;
  min-height: 48px;
  max-height: none;
  flex-shrink: 0;
  container-type: inline-size;
  background: var(--bg-base, #1F1E1D);
  user-select: none;
  z-index: 45;
  display: flex;
  align-items: center;
  position: relative;
  box-sizing: border-box;
  padding: 4px 12px 6px 12px;
  transition: background-color 0.25s ease;
}

.strip-main-bar {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 10px;
  gap: 8px;
  box-sizing: border-box;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background-color 0.25s ease;
}

.strip-main-bar:focus-within {
  border-color: var(--accent-terracotta, #DA7756);
  box-shadow: 0 0 0 2px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.18));
}

/* ==================== 1. 左侧区 ==================== */
.bar-left-zone {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn-toggle-terminal-drawer {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  color: var(--text-muted, #9E9C94);
  padding: 3px 8px;
  font-size: 12px;
  min-height: 32px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn-toggle-terminal-drawer.active,
.btn-toggle-terminal-drawer:hover {
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
}

.drawer-arrow {
  font-size: 9px;
}

.drawer-label {
  font-weight: 500;
}

.badge-unread {
  background: #ef4444;
  color: #ffffff;
  font-size: 9px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 8px;
  line-height: 14px;
}

/* Copilot 极简状态胶囊 */
.copilot-capsule {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 12px;
  cursor: pointer;
  font-size: 12px;
  min-height: 32px;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.normal-capsule {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
}

.normal-capsule:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--text-main, #ECEAE4);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
}

.anomaly-capsule {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid #ef4444;
  color: #fca5a5;
}

.anomaly-capsule:hover {
  background: rgba(239, 68, 68, 0.25);
}

/* ==================== 2. 中间区 ==================== */
.bar-center-zone {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  max-width: none;
  margin: 0;
}

.btn-input-fmt {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  border-radius: 6px;
  font-size: 12px;
  min-height: 32px;
  white-space: nowrap;
  font-weight: 600;
  padding: 2px 7px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.btn-input-fmt:hover {
  color: var(--text-main, #ECEAE4);
  border-color: var(--border-strong, #4A4843);
}

.btn-input-fmt.active {
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
}

.dispatch-input-wrapper {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  min-width: 120px;
}

.single-line-input {
  width: 100%;
  height: 32px;
  background: transparent;
  border: none;
  color: var(--text-main, #ECEAE4);
  font-size: 12px;
  padding: 0 22px 0 8px;
  outline: none;
}

.single-line-input::placeholder {
  color: var(--text-soft, #706E66);
}

.btn-clear-input {
  position: absolute;
  right: 6px;
  background: transparent;
  border: none;
  color: var(--text-soft, #706E66);
  cursor: pointer;
  font-size: 12px;
  width: 24px;
  height: 32px;
  padding: 0;
  line-height: 1;
}

.btn-clear-input:hover {
  color: var(--text-main, #ECEAE4);
}

.btn-cmd-book {
  font-size: 12px;
  padding: 2px 6px;
  height: 32px;
  min-width: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  transition: all 0.15s;
}

.btn-cmd-book:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
}

.quick-commands-belt {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  overflow-x: auto;
  flex-shrink: 1;
}

.quick-cmd-pill {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  border-radius: 9999px;
  font-size: 12px;
  min-height: 32px;
  padding: 2px 8px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.15s;
}

.quick-cmd-pill:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
  border-color: var(--accent-terracotta, #DA7756);
}

.quick-cmd-pill.pill-danger {
  border-color: rgba(239, 68, 68, 0.4);
  color: #fca5a5;
}

.quick-cmd-pill.pill-danger:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.newline-select {
  height: 32px;
  width: 100px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
  padding: 0 4px;
  outline: none;
  flex-shrink: 0;
}

.btn-dispatch-send {
  min-width: 64px;
  min-height: 32px;
  border-radius: 5px;
  background: var(--accent-action);
  border: none;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  padding: 6px 8px;
  gap: 6px;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.btn-dispatch-send:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-action) 90%, white);
}

.btn-dispatch-send:active:not(:disabled) {
  background: var(--accent-action);
}

.btn-dispatch-send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  background: var(--border-strong, #4A4843);
  box-shadow: none;
}

.claude-send-icon {
  width: 14px;
  height: 14px;
}

.sending-spinner {
  font-size: 11px;
  line-height: 1;
}

.send-error {
  color: var(--accent-rose);
  font-size: 12px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ==================== 3. 右侧区 ==================== */
.bar-right-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.rate-pulse-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.metric-rate {
  color: #10b981;
  font-weight: 600;
  font-size: 11px;
}

.pulse-indicator-box {
  display: flex;
  align-items: center;
  font-size: 11px;
  color: #64748b;
  transition: all 0.1s;
}

.pulse-indicator-box.is-active {
  color: var(--accent-terracotta, #DA7756);
  transform: scale(1.15);
}

/* 通用小按钮 */
.strip-btn {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
  min-height: 32px;
  padding: 2px 7px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.strip-btn:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
  border-color: var(--accent-terracotta, #DA7756);
}

.btn-flow-settings {
  font-size: 12px;
  min-width: 32px;
  font-weight: 500;
  color: var(--text-muted, #9E9C94);
  padding: 3px 8px;
}

.btn-flow-settings.active,
.btn-flow-settings:hover {
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
}

.gear-icon {
  font-size: 11px;
}

.flow-settings-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.arrow-indicator {
  font-size: 8px;
  opacity: 0.7;
}

/* ==================== 4. 向上弹出的流控气泡弹窗 ==================== */
.popover-anchor {
  position: relative;
}

.flow-control-popover {
  position: absolute;
  right: 0;
  bottom: 46px;
  width: 450px;
  max-width: 90vw;
  background: var(--bg-surface, #272623);
  backdrop-filter: blur(16px);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 14px;
  box-shadow: var(--card-shadow, 0 -12px 36px rgba(0, 0, 0, 0.45));
  padding: 12px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
  color: var(--text-main, #ECEAE4);
  transition: all 0.2s ease;
}

.popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-subtle, #383633);
  padding-bottom: 6px;
}

.popover-header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.popover-header-title .icon {
  font-size: 13px;
}

.btn-popover-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 3px;
}

.btn-popover-close:hover {
  color: var(--text-main, #ECEAE4);
  background: var(--bg-elevated, #2F2E2A);
}

.popover-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  padding: 8px 10px;
}

.section-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted, #9E9C94);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.section-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.params-grid {
  display: flex;
  align-items: center;
  gap: 12px;
}

.param-input-item {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--text-main, #ECEAE4);
}

.param-label {
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
}

.param-input {
  width: 44px;
  height: 22px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  padding: 0 4px;
  text-align: center;
  outline: none;
}

.param-input.input-wide {
  width: 60px;
}

.param-input:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.param-unit {
  color: var(--text-soft, #706E66);
  font-size: 10px;
}

.actions-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-subtle, #383633);
  padding-top: 6px;
  margin-top: 2px;
}

.btn-auto-scale {
  color: var(--accent-terracotta, #DA7756);
  font-weight: 600;
}

.btn-icon-trash {
  font-size: 10px;
}

.buffer-status-text {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

.buffer-capacity-notice {
  margin-top: 7px;
  color: #E59E38;
  font-size: 10px;
  line-height: 1.45;
}

.div-status-text {
  font-size: 10px;
  color: var(--text-soft, #706E66);
}

/* Scrubber 部分 */
.scrubber-section {
  gap: 6px;
}

.section-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.scrub-badge {
  font-size: 10px;
  color: #E59E38;
  white-space: nowrap;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-return-live {
  color: var(--accent-terracotta, #DA7756);
  text-decoration: underline;
  margin-left: 2px;
}

.live-badge {
  font-size: 10px;
  color: #7AA89B;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}

.live-dot {
  width: 6px;
  height: 6px;
  background: #7AA89B;
  border-radius: 50%;
}

.scrubber-track-wrap {
  width: 100%;
  display: flex;
  align-items: center;
}

.scrubber-slider {
  width: 100%;
  height: 6px;
  accent-color: var(--accent-terracotta, #DA7756);
  cursor: pointer;
}

/* 终端控制与流量部分 */
.terminal-tools-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.tool-subgroup {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tool-sublabel {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

.encoding-value {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  font-size: 12px;
  padding: 0 6px;
}

.font-zoom-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.btn-zoom {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}

.btn-zoom:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
}

.btn-clear-screen {
  font-size: 10px;
}

.theme-buttons {
  display: flex;
  gap: 2px;
}

.theme-btn {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-muted, #9E9C94);
  font-size: 9px;
  padding: 2px 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.theme-btn:hover {
  color: var(--text-main, #ECEAE4);
}

.theme-btn.active {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
  border-color: var(--accent-terracotta, #DA7756);
}

.stats-row {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  font-size: 10px;
  border-top: 1px solid var(--border-subtle, #383633);
  padding-top: 4px;
  margin-top: 2px;
}

.stat-rx { color: var(--accent-terracotta, #DA7756); }
.stat-tx { color: #E59E38; }

/* 气泡弹窗动画 */
.popover-fade-enter-active,
.popover-fade-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.popover-fade-enter-from,
.popover-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* The sending controls respond to their workspace width, including an open AI panel. */
.docked-terminal-strip :is(button, input, select):focus-visible {
  outline: 2px solid var(--accent-terracotta);
  outline-offset: 2px;
}

.send-error {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 12px;
  right: 12px;
  max-width: none;
  padding: 6px 8px;
  border: 1px solid var(--accent-rose);
  border-radius: 5px;
  background: var(--bg-surface);
  white-space: normal;
  overflow-wrap: anywhere;
}

@container (max-width: 1000px) {
  .quick-commands-belt, .rate-pulse-group { display: none; }
}

@container (max-width: 760px) {
  .copilot-capsule, .btn-cmd-book { display: none; }
  .flow-settings-label, .btn-flow-settings .arrow-indicator { display: none; }
  .btn-flow-settings { padding: 6px 7px; }
  .bar-center-zone { gap: 6px; }
  .bar-right-zone { gap: 0; }
}

@container (max-width: 560px) {
  .strip-main-bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 8px;
    padding: 6px 8px;
  }
  .bar-center-zone { grid-column: 1 / -1; grid-row: 1; }
  .bar-left-zone { grid-column: 1; grid-row: 2; }
  .bar-right-zone { grid-column: 2; grid-row: 2; }
  .flow-settings-label { display: inline; }
  .flow-control-popover { max-width: calc(100cqw - 16px); }
}

@container (max-width: 440px) {
  .bar-center-zone { flex-wrap: wrap; }
  .dispatch-input-wrapper { order: 0; flex-basis: calc(100% - 70px); }
  .btn-dispatch-send { order: 1; }
  .btn-input-fmt { order: 2; }
  .escape-toggle { order: 3; }
  .newline-select { order: 4; }
}
</style>
