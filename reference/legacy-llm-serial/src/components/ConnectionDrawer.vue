<script setup lang="ts">
import type { SerialPortInfo } from './TopBar.vue';

const props = defineProps<{
  isOpen: boolean;
  isRunning: boolean;
  connectionState: 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';
  selectedPort: string;
  selectedBaud: string;
  ports: SerialPortInfo[];
  isRefreshingPorts: boolean;
  canRequestPort?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggle-connect'): void;
  (e: 'change-port', port: string): void;
  (e: 'change-baud', baud: string): void;
  (e: 'refresh-ports'): void;
  (e: 'request-port'): void;
}>();

const baudRates = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'];
</script>

<template>
  <aside v-if="props.isOpen" class="connection-drawer">
    <header class="drawer-header">
      <div class="header-title">
        <svg class="w-4 h-4 text-emerald-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
        <span>物理硬件连接</span>
      </div>
      <button class="btn-close" @click="emit('close')">✕</button>
    </header>

    <div class="drawer-body">
      <!-- 物理串口端口选择 -->
      <div class="form-group">
        <div class="label-row">
          <label class="form-label">物理串口号 (COM Port)</label>
          <button
            class="btn-refresh"
            :class="{ spinning: props.isRefreshingPorts }"
            :disabled="props.isRunning || props.isRefreshingPorts"
            @click="emit('refresh-ports')"
            title="重新扫描系统硬件端口"
          >
            <svg class="w-3.5 h-3.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>刷新</span>
          </button>
        </div>

        <select
          class="form-select"
          :value="props.selectedPort"
          :disabled="props.isRunning"
          @change="(e) => emit('change-port', (e.target as HTMLSelectElement).value)"
        >
          <option v-if="props.ports.length === 0 && !props.selectedPort" value="" disabled>未检测到物理串口</option>
          <option
            v-if="props.selectedPort && !props.ports.some((p) => p.port_name === props.selectedPort)"
            :value="props.selectedPort"
            disabled
          >
            {{ props.selectedPort }} (未检测到)
          </option>
          <option
            v-for="p in props.ports"
            :key="p.port_name"
            :value="p.port_name"
          >
            {{ p.port_name }} {{ p.description ? `(${p.description})` : '' }}
          </option>
        </select>

        <button
          v-if="props.canRequestPort"
          class="btn-webserial"
          :disabled="props.isRunning"
          @click="emit('request-port')"
        >
          + 授权外部 WebSerial 端口
        </button>
      </div>

      <!-- 波特率 -->
      <div class="form-group">
        <label class="form-label">波特率 (Baud Rate)</label>
        <select
          class="form-select"
          :value="props.selectedBaud"
          :disabled="props.isRunning"
          @change="(e) => emit('change-baud', (e.target as HTMLSelectElement).value)"
        >
          <option v-for="rate in baudRates" :key="rate" :value="rate">
            {{ rate }} bps
          </option>
        </select>
      </div>

      <!-- 打开 / 关闭连接大按钮 -->
      <div class="action-section">
        <button
          class="btn-toggle-connection"
          :class="{
            'btn-connected': props.connectionState === 'connected',
            'btn-disconnected': props.connectionState === 'disconnected',
            'btn-error': props.connectionState === 'error',
            'btn-busy': props.connectionState === 'connecting' || props.connectionState === 'reconnecting',
          }"
          :disabled="props.connectionState === 'connecting'"
          @click="emit('toggle-connect')"
        >
          <span class="btn-dot"></span>
          <span>
            <template v-if="props.connectionState === 'connected'">关闭串口连接</template>
            <template v-else-if="props.connectionState === 'connecting'">正在连接串口...</template>
            <template v-else-if="props.connectionState === 'reconnecting'">正在自动重连...</template>
            <template v-else-if="props.connectionState === 'error'">重试连接串口</template>
            <template v-else>打开物理串口</template>
          </span>
        </button>
      </div>

      <!-- 硬件提示说明 -->
      <div class="helper-note">
        <div class="note-title">⚡ 提示说明</div>
        <div class="note-text">
          - 采用 Rust 本地高性能异步串口驱动，支持最高 2,000,000 点/秒高吞吐。<br />
          - 支持 USB 热拔插自愈恢复。<br />
          - 任何时刻均可通过物理键盘 <kbd class="kbd-badge">Space</kbd> 空格键触发全局急停。
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.connection-drawer {
  position: absolute;
  top: 0;
  left: 44px;
  bottom: 0;
  width: 290px;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-subtle);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  z-index: 40;
  user-select: none;
  animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
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
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-base);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
  white-space: nowrap;
}

.header-title svg {
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  flex-shrink: 0;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 14px;
  border-radius: 4px;
}

.btn-close:hover {
  background: var(--bg-elevated);
  color: var(--text-main);
}

.drawer-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
}

.btn-refresh {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--accent-terracotta);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}

.btn-refresh:hover:not(:disabled) {
  background: rgba(218, 119, 86, 0.15);
}

.btn-refresh svg {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  flex-shrink: 0;
}

.btn-refresh.spinning svg {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  100% {
    transform: rotate(360deg);
  }
}

.form-select {
  height: 34px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--text-main);
  outline: none;
}

.form-select:focus {
  border-color: var(--accent-terracotta);
}

.btn-webserial {
  margin-top: 4px;
  padding: 6px 8px;
  background: rgba(218, 119, 86, 0.1);
  border: 1px dashed var(--accent-terracotta);
  border-radius: 6px;
  color: var(--accent-terracotta);
  font-size: 11px;
  cursor: pointer;
  text-align: center;
}

.btn-webserial:hover {
  background: rgba(218, 119, 86, 0.2);
}

.action-section {
  margin-top: 6px;
}

.btn-toggle-connection {
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-disconnected {
  background: var(--accent-terracotta);
  color: white;
}

.btn-disconnected:hover {
  background: #c4673d;
}

.btn-connected {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid #ef4444;
  color: #fca5a5;
}

.btn-connected:hover {
  background: rgba(239, 68, 68, 0.25);
}

.btn-error {
  background: #dc2626;
  color: white;
}

.btn-busy {
  background: #d97706;
  color: white;
}

.btn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.helper-note {
  margin-top: 8px;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 10px;
}

.note-title {
  font-size: 11px;
  font-weight: 600;
  color: #fbbf24;
  margin-bottom: 4px;
}

.note-text {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.kbd-badge {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  padding: 1px 4px;
  color: var(--text-main);
  font-size: 10px;
  font-family: monospace;
}
</style>
