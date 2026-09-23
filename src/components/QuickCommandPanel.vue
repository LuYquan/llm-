<script setup lang="ts">
import { ref, onUnmounted, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

export interface QuickCmd {
  id: string;
  name: string;
  command: string;
  is_hex: boolean;
  danger?: boolean;
}

const props = defineProps<{
  commands: QuickCmd[];
  isRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'send-command', cmd: QuickCmd): void;
  (e: 'update-commands', list: QuickCmd[]): void;
  (e: 'emergency-stop'): void;
}>();

// 循环发送状态管理 (PR-001: 由 Rust tokio::time 高精度调度)
const loopTimer = ref<number | null>(null);
const loopIntervalMs = ref<number>(1000);
const activeLoopId = ref<string | null>(null);

// 新增/编辑指令状态
const showAddModal = ref(false);
const newCmdName = ref('');
const newCmdText = ref('');
const newCmdIsHex = ref(false);

function handleSend(cmd: QuickCmd) {
  if (cmd.danger) {
    emit('emergency-stop');
    return;
  }
  emit('send-command', cmd);
}

async function toggleLoop(cmd: QuickCmd) {
  if (activeLoopId.value === cmd.id) {
    await stopLoop();
  } else {
    await stopLoop();
    activeLoopId.value = cmd.id;
    try {
      await invoke('start_periodic_send', {
        data: cmd.command,
        intervalMs: loopIntervalMs.value,
        isHex: cmd.is_hex,
      });
    } catch (err) {
      console.warn('Backend periodic send failed, falling back to frontend timer:', err);
      // 降级前端定时器
      loopTimer.value = window.setInterval(() => {
        if (!props.isRunning) {
          stopLoop();
          return;
        }
        handleSend(cmd);
      }, loopIntervalMs.value);
    }
  }
}

async function stopLoop() {
  if (loopTimer.value) {
    clearInterval(loopTimer.value);
    loopTimer.value = null;
  }
  try {
    await invoke('stop_periodic_send');
  } catch (err) {
    // 忽略未启动或脱机错误
  }
  activeLoopId.value = null;
}

watch(loopIntervalMs, async (newVal) => {
  if (activeLoopId.value) {
    const cmd = props.commands.find((c) => c.id === activeLoopId.value);
    if (cmd && props.isRunning) {
      try {
        await invoke('start_periodic_send', {
          data: cmd.command,
          intervalMs: newVal,
          isHex: cmd.is_hex,
        });
      } catch (err) {
        if (loopTimer.value) clearInterval(loopTimer.value);
        loopTimer.value = window.setInterval(() => {
          if (!props.isRunning) {
            stopLoop();
            return;
          }
          handleSend(cmd);
        }, newVal);
      }
    } else {
      await stopLoop();
    }
  }
});

watch(
  () => props.isRunning,
  async (running) => {
    if (!running) {
      await stopLoop();
    }
  }
);

function addNewCommand() {
  if (!newCmdName.value.trim() || !newCmdText.value.trim()) return;
  const newCmd: QuickCmd = {
    id: `cmd_${Date.now()}`,
    name: newCmdName.value.trim(),
    command: newCmdText.value.trim(),
    is_hex: newCmdIsHex.value,
  };
  const updated = [...props.commands, newCmd];
  emit('update-commands', updated);

  newCmdName.value = '';
  newCmdText.value = '';
  newCmdIsHex.value = false;
  showAddModal.value = false;
}

function deleteCommand(id: string) {
  if (activeLoopId.value === id) {
    stopLoop();
  }
  const updated = props.commands.filter((c) => c.id !== id);
  emit('update-commands', updated);
}

onUnmounted(() => {
  stopLoop();
});
</script>

<template>
  <div class="quick-cmd-card">
    <div class="card-header">
      <div class="title-group">
        <span class="card-icon">⚡</span>
        <span class="card-title">快捷指令与循环发送</span>
      </div>
      <div class="header-actions">
        <button class="btn-icon" @click="showAddModal = !showAddModal" title="添加新指令">
          {{ showAddModal ? '✕' : '+ 新增' }}
        </button>
      </div>
    </div>

    <!-- 新增指令内联表单 -->
    <div class="add-form" v-if="showAddModal">
      <div class="form-row">
        <input
          type="text"
          class="form-input"
          placeholder="指令名称 (如 读取温度)"
          v-model="newCmdName"
        />
        <label class="hex-toggle">
          <input type="checkbox" v-model="newCmdIsHex" />
          <span>HEX</span>
        </label>
      </div>
      <div class="form-row">
        <input
          type="text"
          class="form-input font-mono"
          placeholder="内容 (如 01 03 00 00 00 02 或 READ\n)"
          v-model="newCmdText"
        />
        <button class="btn-save" @click="addNewCommand">保存</button>
      </div>
    </div>

    <!-- 循环发送周期设置条 -->
    <div class="loop-setting-bar">
      <span class="loop-label">循环周期:</span>
      <select class="loop-select font-mono" v-model.number="loopIntervalMs">
        <option :value="50">50ms (20Hz)</option>
        <option :value="100">100ms (10Hz)</option>
        <option :value="200">200ms (5Hz)</option>
        <option :value="500">500ms (2Hz)</option>
        <option :value="1000">1000ms (1Hz)</option>
        <option :value="2000">2000ms (0.5Hz)</option>
      </select>
      <span class="loop-status" v-if="activeLoopId">
        <span class="pulse-dot"></span> 循环中
      </span>
    </div>

    <!-- 指令列表 -->
    <div class="card-body">
      <div class="cmd-list">
        <div
          v-for="cmd in commands"
          :key="cmd.id"
          class="cmd-row"
          :class="{ 'row-active-loop': activeLoopId === cmd.id, 'row-danger': cmd.danger }"
        >
          <div class="cmd-main">
            <div class="cmd-title-line">
              <span class="cmd-name">{{ cmd.name }}</span>
              <span class="badge-hex font-mono" v-if="cmd.is_hex">HEX</span>
            </div>
            <code class="cmd-code font-mono">{{ cmd.command }}</code>
          </div>

          <div class="cmd-actions">
            <!-- 单次发送 -->
            <button
              class="btn-send"
              :class="{ 'btn-danger': cmd.danger }"
              :disabled="!isRunning"
              @click="handleSend(cmd)"
            >
              {{ cmd.danger ? '急停' : '发送' }}
            </button>

            <!-- 循环发送勾选/切换按钮 (非急停指令) -->
            <button
              v-if="!cmd.danger"
              class="btn-loop"
              :class="{ active: activeLoopId === cmd.id }"
              :disabled="!isRunning"
              @click="toggleLoop(cmd)"
              title="循环定时发送"
            >
              {{ activeLoopId === cmd.id ? '停止' : '循环' }}
            </button>

            <!-- 删除按钮 -->
            <button class="btn-del" @click="deleteCommand(cmd.id)" title="删除指令">
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-cmd-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-header {
  padding: 8px 12px;
  background-color: rgba(24, 34, 50, 0.6);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-icon {
  font-size: 13px;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.btn-icon {
  background-color: rgba(14, 165, 233, 0.1);
  border: 1px solid rgba(14, 165, 233, 0.3);
  color: var(--accent-cyan);
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-icon:hover {
  background-color: rgba(14, 165, 233, 0.2);
}

.add-form {
  padding: 8px 10px;
  background-color: rgba(11, 15, 23, 0.8);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.form-input {
  flex: 1;
  background-color: rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-primary);
  outline: none;
}

.form-input:focus {
  border-color: var(--accent-cyan);
}

.hex-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.btn-save {
  padding: 4px 12px;
  background-color: #0284c7;
  border: 1px solid #0ea5e9;
  border-radius: 3px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.loop-setting-bar {
  padding: 4px 10px;
  background-color: rgba(15, 23, 42, 0.5);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.loop-label {
  color: var(--text-muted);
}

.loop-select {
  background-color: rgba(11, 15, 23, 0.6);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  color: var(--text-primary);
  font-size: 10px;
  padding: 1px 4px;
  outline: none;
}

.loop-status {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-emerald);
  font-size: 10px;
  margin-left: auto;
}

.pulse-dot {
  width: 6px;
  height: 6px;
  background-color: var(--accent-emerald);
  border-radius: 50%;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.card-body {
  padding: 8px;
  max-height: 260px;
  overflow-y: auto;
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cmd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background-color: rgba(11, 15, 23, 0.4);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  transition: all 0.2s;
}

.cmd-row:hover {
  border-color: rgba(14, 165, 233, 0.4);
}

.row-active-loop {
  border-color: var(--accent-emerald);
  background-color: rgba(16, 185, 129, 0.08);
}

.row-danger {
  border-color: rgba(239, 68, 68, 0.4);
}

.cmd-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
  max-width: 60%;
}

.cmd-title-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cmd-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.badge-hex {
  font-size: 9px;
  background-color: rgba(245, 158, 11, 0.15);
  color: var(--accent-amber);
  padding: 0 4px;
  border-radius: 2px;
}

.cmd-code {
  font-size: 10px;
  color: var(--accent-cyan);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.85;
}

.cmd-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-send {
  padding: 3px 8px;
  font-size: 11px;
  background-color: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-send:hover:not(:disabled) {
  background-color: var(--bg-card-hover);
  border-color: var(--accent-cyan);
}

.btn-danger {
  background-color: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.4);
  color: var(--accent-rose);
}

.btn-danger:hover:not(:disabled) {
  background-color: rgba(239, 68, 68, 0.3);
}

.btn-loop {
  padding: 3px 6px;
  font-size: 10px;
  background: none;
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
}

.btn-loop:hover:not(:disabled) {
  color: var(--accent-emerald);
  border-color: var(--accent-emerald);
}

.btn-loop.active {
  background-color: rgba(16, 185, 129, 0.2);
  border-color: var(--accent-emerald);
  color: var(--accent-emerald);
}

.btn-del {
  padding: 2px 4px;
  font-size: 10px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}

.btn-del:hover {
  color: var(--accent-rose);
}

.btn-send:disabled,
.btn-loop:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
