<script setup lang="ts">
export interface SerialPortInfo {
  port_name: string;
  port_type: string;
  description?: string;
  manufacturer?: string;
}

const props = defineProps<{
  isRunning: boolean;
  connectionState: 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';
  mode: string;
  activeTab: string;
  selectedPort: string;
  selectedBaud: string;
  ports: SerialPortInfo[];
  isRefreshingPorts: boolean;
  totalSamples: number;
  sampleRate: number;
}>();

const emit = defineEmits<{
  (e: 'toggleConnect'): void;
  (e: 'reset'): void;
  (e: 'changeMode', mode: string): void;
  (e: 'changeActiveTab', tab: string): void;
  (e: 'changePort', port: string): void;
  (e: 'changeBaud', baud: string): void;
  (e: 'refreshPorts'): void;
}>();

const baudRates = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'];

function onModeChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  emit('changeMode', target.value);
}

function onPortChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  emit('changePort', target.value);
}

function onBaudChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  emit('changeBaud', target.value);
}
</script>

<template>
  <header class="topbar">
    <!-- 品牌与双模切换中枢 -->
    <div class="left-group">
      <div class="brand">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
        </div>
        <span class="logo-title">LLM 串口</span>
        <span class="version-tag">v0.2.0</span>
      </div>

      <!-- 核心双模切换器 (Step 2.5 核心) -->
      <div class="mode-switch-group">
        <button
          class="mode-switch-btn"
          :class="{ active: props.activeTab === 'debug' }"
          @click="emit('changeActiveTab', 'debug')"
          title="常规调试模式：串口收发、HEX/ASCII、快捷指令"
        >
          <svg class="mode-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"></polyline>
            <line x1="12" y1="19" x2="20" y2="19"></line>
          </svg>
          <span>常规调试模式</span>
        </button>
        <button
          class="mode-switch-btn"
          :class="{ active: props.activeTab === 'waveform' }"
          @click="emit('changeActiveTab', 'waveform')"
          title="AI波形调参模式：极速实时曲线、阶跃快照、PID自整定"
        >
          <svg class="mode-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          <span>AI波形调参模式</span>
        </button>
      </div>
    </div>

    <!-- 中部硬件控制区 -->
    <div class="controls-group">
      <!-- 数据源选择 -->
      <div class="control-item">
        <label class="control-label">数据源</label>
        <select class="control-select" :value="props.mode" @change="onModeChange" :disabled="props.isRunning">
          <option value="mock">Mock 仿真源 (100Hz)</option>
          <option value="serial">物理串口驱动</option>
        </select>
      </div>

      <!-- 端口选择与动态刷新 -->
      <div class="control-item">
        <label class="control-label">端口</label>
        <div class="port-select-wrapper">
          <select
            class="control-select port-select"
            :value="props.mode === 'mock' ? 'VIRTUAL_COM' : props.selectedPort"
            @change="onPortChange"
            :disabled="props.mode === 'mock' || props.isRunning"
          >
            <option v-if="props.mode === 'mock'" value="VIRTUAL_COM">VIRTUAL_COM (Mock 100Hz)</option>
            <template v-else>
              <option v-if="props.ports.length === 0 && !props.selectedPort" value="" disabled>无可用串口 (请插入)</option>
              <option
                v-if="props.selectedPort && !props.ports.some(p => p.port_name === props.selectedPort)"
                :value="props.selectedPort"
                disabled
              >
                {{ props.selectedPort }} (未连接)
              </option>
              <option
                v-for="p in props.ports"
                :key="p.port_name"
                :value="p.port_name"
              >
                {{ p.port_name }} {{ p.description ? `(${p.description})` : `(${p.port_type})` }}
              </option>
            </template>
          </select>
          <button
            v-if="props.mode === 'serial'"
            class="refresh-btn"
            :class="{ spinning: props.isRefreshingPorts }"
            @click="emit('refreshPorts')"
            :disabled="props.isRunning || props.isRefreshingPorts"
            title="刷新系统串口列表"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 波特率 -->
      <div class="control-item">
        <label class="control-label">波特率</label>
        <select
          class="control-select"
          :value="props.selectedBaud"
          @change="onBaudChange"
          :disabled="props.mode === 'mock' || props.isRunning"
        >
          <option v-if="!baudRates.includes(props.selectedBaud)" :value="props.selectedBaud">
            {{ props.selectedBaud }}
          </option>
          <option v-for="rate in baudRates" :key="rate" :value="rate">
            {{ rate }}
          </option>
        </select>
      </div>

      <!-- 连接/断开 状态机按钮 -->
      <button
        class="action-btn"
        :class="{
          'btn-disconnect': props.connectionState === 'connected',
          'btn-connect': props.connectionState === 'disconnected',
          'btn-connecting': props.connectionState === 'connecting' || props.connectionState === 'reconnecting',
          'btn-error': props.connectionState === 'error',
        }"
        :disabled="props.connectionState === 'connecting'"
        @click="emit('toggleConnect')"
      >
        <span
          class="btn-dot"
          :class="{
            'dot-active': props.connectionState === 'connected',
            'dot-connecting': props.connectionState === 'connecting',
            'dot-error': props.connectionState === 'error',
          }"
        ></span>
        <span>
          <template v-if="props.connectionState === 'connected'">
            {{ props.mode === 'serial' ? '关闭串口' : '停止仿真' }}
          </template>
          <template v-else-if="props.connectionState === 'connecting'">连接中...</template>
          <template v-else-if="props.connectionState === 'reconnecting'">重连中...</template>
          <template v-else-if="props.connectionState === 'error'">重新连接</template>
          <template v-else>
            {{ props.mode === 'serial' ? '打开串口' : '开始连接' }}
          </template>
        </span>
      </button>

      <!-- 重置波形 按钮 -->
      <button class="action-btn btn-secondary" @click="emit('reset')" title="清空波形与重置缓冲">
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
          <path d="M3 3v5h5"></path>
        </svg>
        <span>重置</span>
      </button>
    </div>

    <!-- 右侧状态监控 -->
    <div class="status-group">
      <div
        class="status-badge"
        :class="{
          'status-online': props.connectionState === 'connected',
          'status-error': props.connectionState === 'error',
        }"
      >
        <span class="pulse-light"></span>
        <span class="status-text">
          <template v-if="props.connectionState === 'connected'">
            {{ props.mode === 'serial' ? `${props.selectedPort} @ ${props.selectedBaud}` : '仿真数据流传输中' }}
          </template>
          <template v-else-if="props.connectionState === 'error'">连接异常 / 串口已拔出</template>
          <template v-else-if="props.connectionState === 'connecting'">正在建立连接...</template>
          <template v-else>空闲 / 未连接</template>
        </span>
      </div>
      <div class="metrics-pill">
        <span class="pill-label">采样率</span>
        <span class="pill-value font-mono">{{ props.sampleRate.toFixed(0) }} Hz</span>
      </div>
      <div class="metrics-pill">
        <span class="pill-label">点数</span>
        <span class="pill-value font-mono">{{ props.totalSamples.toLocaleString() }}</span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: 52px;
  background-color: var(--bg-panel);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  gap: 16px;
  flex-shrink: 0;
  user-select: none;
}

.left-group {
  display: flex;
  align-items: center;
  gap: 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo-icon {
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, #0284c7, #0ea5e9);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.logo-icon svg {
  width: 18px;
  height: 18px;
}

.logo-title {
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.5px;
  color: var(--text-primary);
  white-space: nowrap;
}

.version-tag {
  font-size: 11px;
  padding: 2px 6px;
  background-color: #1e293b;
  color: var(--accent-cyan);
  border-radius: 4px;
  border: 1px solid #334155;
  font-family: var(--font-mono);
}

/* 核心双模切换器样式 */
.mode-switch-group {
  display: flex;
  background-color: #0f172a;
  padding: 3px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  gap: 2px;
}

.mode-switch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.mode-switch-btn:hover {
  color: var(--text-primary);
  background-color: rgba(255, 255, 255, 0.05);
}

.mode-switch-btn.active {
  background-color: #1e293b;
  color: #38bdf8;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.mode-btn-icon {
  width: 14px;
  height: 14px;
}

.controls-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.control-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.control-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.port-select-wrapper {
  display: flex;
  align-items: center;
  gap: 4px;
}

.control-select {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.2s;
}

.port-select {
  max-width: 180px;
}

.control-select:focus {
  border-color: var(--accent-cyan);
}

.control-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.refresh-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.refresh-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--accent-cyan);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-btn svg {
  width: 13px;
  height: 13px;
}

.refresh-btn.spinning svg {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn-connect {
  background-color: #0369a1;
  color: #ffffff;
  border-color: #0284c7;
}

.btn-connect:hover {
  background-color: #0284c7;
}

.btn-disconnect {
  background-color: #be123c;
  color: #ffffff;
  border-color: #e11d48;
}

.btn-disconnect:hover {
  background-color: #e11d48;
}

.btn-connecting {
  background-color: #d97706;
  color: #ffffff;
  border-color: #f59e0b;
  cursor: wait;
}

.btn-error {
  background-color: #991b1b;
  color: #ffffff;
  border-color: #dc2626;
}

.btn-secondary {
  background-color: var(--bg-card);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.btn-secondary:hover {
  background-color: var(--bg-card-hover);
  color: var(--text-primary);
}

.btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #94a3b8;
}

.dot-active {
  background-color: #34d399;
  box-shadow: 0 0 8px #34d399;
}

.dot-connecting {
  background-color: #fbbf24;
  animation: pulse 1s infinite;
}

.dot-error {
  background-color: #f87171;
  box-shadow: 0 0 6px #f87171;
}

.btn-icon {
  width: 14px;
  height: 14px;
}

.status-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

.pulse-light {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: #64748b;
}

.status-online {
  color: var(--accent-emerald);
  border-color: rgba(52, 211, 153, 0.3);
}

.status-online .pulse-light {
  background-color: var(--accent-emerald);
  box-shadow: 0 0 6px var(--accent-emerald);
  animation: pulse 1.8s infinite;
}

.status-error {
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.3);
}

.status-error .pulse-light {
  background-color: #f87171;
  box-shadow: 0 0 6px #f87171;
}

@keyframes pulse {
  0% { transform: scale(0.95); opacity: 0.8; }
  50% { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(0.95); opacity: 0.8; }
}

.metrics-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 3px 8px;
  background-color: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  white-space: nowrap;
}

.pill-label {
  color: var(--text-muted);
}

.pill-value {
  color: var(--text-primary);
  font-weight: 600;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
