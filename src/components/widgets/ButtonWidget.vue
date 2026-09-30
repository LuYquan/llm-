<script setup lang="ts">
import { ref } from 'vue';
import type { ButtonConfig } from '../../types/widget';
import { globalSendGate } from '../../core/widget/sendGate';

const props = defineProps<{
  config: ButtonConfig;
  title: string;
  locked: boolean;      // true 运行锁定(可下发) / false 编辑中(禁止下发)
  isConnected: boolean; // 串口打开状态
  widgetId?: string;
}>();

const isConfirming = ref(false);
const confirmCountdown = ref(1);
let countdownTimer: number | null = null;
let lastClickTime = 0;

// 交互与反馈状态
const status = ref<'idle' | 'sending' | 'ok' | 'error'>('idle');
const feedbackMsg = ref('');
let feedbackTimer: number | null = null;

function showFeedback(type: 'ok' | 'error', msg: string) {
  status.value = type;
  feedbackMsg.value = msg;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    status.value = 'idle';
    feedbackMsg.value = '';
  }, 2000);
}

// 点动 / 寸动状态
const isJogActive = ref(false);

// 点击按钮触发下发逻辑 (Click 模式)
async function handleClick() {
  if (props.config.mode === 'jog') return; // 点动模式交由 pointer 事件处理

  if (props.config.enabled === false || !props.config.command_template?.trim()) {
    showFeedback('error', '控件尚未绑定设备指令，请先配置内容并启用。');
    return;
  }

  if (!props.locked) {
    showFeedback('error', '编辑态已锁定下发');
    return;
  }

  if (!props.isConnected) {
    showFeedback('error', '串口未连接，指令未发送');
    return;
  }

  const now = Date.now();
  if (now - lastClickTime < 300) return; // 300ms 防连击
  lastClickTime = now;

  if (props.config.is_danger) {
    // 危险操作二次防误触：立即弹窗，确认按钮 1s 倒计时
    isConfirming.value = true;
    confirmCountdown.value = 1;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = window.setTimeout(() => {
      confirmCountdown.value = 0;
    }, 1000);
    return;
  }

  await executeSend();
}

async function executeSendCommand(cmd: string) {
  if (!cmd) return;
  status.value = 'sending';
  const result = await globalSendGate.dispatch(
    {
      id: props.widgetId || 'btn_send',
      type: 'button',
      title: props.title,
      command_template: cmd,
      encoding: props.config.encoding,
      is_danger: false,
    } as any,
    ''
  );

  if (result.ok) {
    showFeedback('ok', '已发送');
  } else {
    showFeedback('error', result.message || '发送失败');
  }
}

async function handleJogDown(_e?: PointerEvent) {
  if (props.config.mode !== 'jog') return;
  if (props.config.enabled === false || (!props.config.press_command?.trim() && !props.config.command_template?.trim())) {
    showFeedback('error', '点动控件尚未绑定按下指令，请先配置并启用。');
    return;
  }
  if (!props.locked) {
    showFeedback('error', '编辑态已锁定下发');
    return;
  }
  if (!props.isConnected) {
    showFeedback('error', '串口未连接');
    return;
  }
  isJogActive.value = true;
  const pressCmd = props.config.press_command || props.config.command_template || '';
  await executeSendCommand(pressCmd);
}

async function handleJogUp(_e?: PointerEvent) {
  if (props.config.mode !== 'jog' || !isJogActive.value) return;
  isJogActive.value = false;
  if (!props.locked || !props.isConnected) return;
  const relCmd = props.config.release_command || '';
  if (relCmd) {
    await executeSendCommand(relCmd);
  }
}

async function executeSend() {
  isConfirming.value = false;
  if (countdownTimer) clearTimeout(countdownTimer);

  status.value = 'sending';
  const result = await globalSendGate.dispatch(
    {
      id: props.widgetId || 'btn_send',
      type: 'button',
      title: props.title,
      command_template: props.config.command_template,
      encoding: props.config.encoding,
      is_danger: props.config.is_danger,
    } as any,
    ''
  );

  if (result.ok) {
    showFeedback('ok', '已发送');
  } else {
    showFeedback('error', result.message || '发送失败');
  }
}

function cancelConfirm() {
  isConfirming.value = false;
  if (countdownTimer) clearTimeout(countdownTimer);
}
</script>

<template>
  <div class="button-widget-root">
    <!-- 危险操作确认弹窗 -->
    <div class="danger-confirm-modal" v-if="isConfirming">
      <div class="danger-box">
        <span class="danger-warn-icon">⚠️</span>
        <div class="danger-text">
          <div class="danger-title">确认执行危险操作？</div>
          <div class="danger-sub">即将下发：<code>{{ config.command_template }}</code></div>
        </div>
        <div class="danger-actions">
          <button
            class="btn-confirm-action"
            :disabled="confirmCountdown > 0"
            @click="executeSend"
          >
            {{ confirmCountdown > 0 ? `确认 (${confirmCountdown}s)` : '确认下发' }}
          </button>
          <button class="btn-cancel-action" @click="cancelConfirm">取消</button>
        </div>
      </div>
    </div>

    <!-- 主按钮主体 -->
    <button
      class="vofa-btn"
      :class="{
        'is-danger': config.is_danger,
        'is-locked-out': !locked,
        'is-jog-active': isJogActive,
        'pulse-success': status === 'ok',
        'pulse-error': status === 'error',
      }"
      :title="!locked ? '编辑态下禁止下发，请先点击右上角挂锁' : ''"
      @click="handleClick"
      @pointerdown="handleJogDown"
      @pointerup="handleJogUp"
      @pointercancel="handleJogUp"
      @pointerleave="handleJogUp"
    >
      <span class="btn-text">{{ config.button_text || title || '按键' }}</span>
      <span class="hex-flag" v-if="config.encoding === 'hex'">HEX</span>
      <span class="jog-flag" v-if="config.mode === 'jog'">JOG</span>
    </button>

    <!-- 反馈提示条 -->
    <div class="status-tip" v-if="feedbackMsg" :class="`tip-${status}`">
      {{ feedbackMsg }}
    </div>
  </div>
</template>

<style scoped>
.button-widget-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  justify-content: center;
  align-items: center;
  padding: 8px;
  box-sizing: border-box;
}

.vofa-btn {
  width: 100%;
  height: 100%;
  min-height: 40px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-main, #ECEAE4);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.15s ease;
  user-select: none;
  box-shadow: var(--card-shadow, 0 1px 3px rgba(0, 0, 0, 0.2));
}

.vofa-btn:hover:not(.is-locked-out) {
  background: var(--bg-elevated, #2F2E2A);
  border-color: var(--accent-terracotta, #DA7756);
  box-shadow: 0 0 10px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.25));
}

.vofa-btn:active:not(.is-locked-out) {
  transform: translateY(1px);
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
}

.vofa-btn.is-danger {
  border-color: #f43f5e;
  color: #fda4af;
  background: linear-gradient(180deg, #2a1215 0%, #170709 100%);
}

.vofa-btn.is-danger:hover:not(.is-locked-out) {
  background: linear-gradient(180deg, #4c111a 0%, #2a1215 100%);
  border-color: #fb7185;
  box-shadow: 0 0 12px rgba(244, 63, 94, 0.35);
}

.vofa-btn.is-locked-out {
  opacity: 0.6;
  cursor: not-allowed;
  filter: grayscale(40%);
}

.vofa-btn.pulse-success {
  border-color: #10b981 !important;
  box-shadow: 0 0 12px rgba(16, 185, 129, 0.6) !important;
}

.vofa-btn.pulse-error {
  border-color: #ef4444 !important;
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.6) !important;
}

.vofa-btn.is-jog-active {
  background: var(--accent-terracotta, #DA7756) !important;
  border-color: var(--accent-terracotta-hover, #E58565) !important;
  color: #ffffff !important;
  box-shadow: 0 0 14px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.6)) !important;
  transform: translateY(1px);
}

.jog-flag {
  font-size: 10px;
  background: var(--accent-terracotta, #DA7756);
  color: white;
  padding: 1px 4px;
  border-radius: 3px;
  font-family: monospace;
}

.hex-flag {
  font-size: 10px;
  background: #3b82f6;
  color: white;
  padding: 1px 4px;
  border-radius: 3px;
  font-family: monospace;
}

.status-tip {
  position: absolute;
  bottom: 2px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  pointer-events: none;
  z-index: 10;
}

.tip-ok {
  background: rgba(16, 185, 129, 0.9);
  color: #fff;
}

.tip-error {
  background: rgba(239, 68, 68, 0.9);
  color: #fff;
}

/* 危险确认弹层 */
.danger-confirm-modal {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.92);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  backdrop-filter: blur(2px);
  padding: 8px;
}

.danger-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
}

.danger-warn-icon {
  font-size: 20px;
}

.danger-title {
  font-size: 12px;
  font-weight: bold;
  color: #fda4af;
}

.danger-sub code {
  font-size: 10px;
  background: #000;
  color: #fbbf24;
  padding: 1px 4px;
  border-radius: 2px;
}

.danger-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.btn-confirm-action {
  font-size: 11px;
  background: #e11d48;
  color: white;
  border: none;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-confirm-action:disabled {
  background: var(--bg-elevated);
  cursor: not-allowed;
}

.btn-cancel-action {
  font-size: 11px;
  background: var(--bg-elevated);
  color: var(--text-muted);
  border: none;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}
</style>
