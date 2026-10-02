<script setup lang="ts">
import { computed } from 'vue';

export type DockDrawerType = 'connection' | 'commands' | 'widgets' | 'project' | null;

const props = defineProps<{
  activeDrawer: DockDrawerType;
  isRunning: boolean;
  connectionState: 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';
  isLocked: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:activeDrawer', val: DockDrawerType): void;
  (e: 'toggle-lock'): void;
}>();

function toggleDrawer(type: DockDrawerType) {
  if (props.activeDrawer === type) {
    emit('update:activeDrawer', null);
  } else {
    emit('update:activeDrawer', type);
  }
}

const statusDotClass = computed(() => {
  if (props.connectionState === 'connected') return 'status-online';
  if (props.connectionState === 'connecting' || props.connectionState === 'reconnecting') return 'status-connecting';
  if (props.connectionState === 'error') return 'status-error';
  return 'status-offline';
});
</script>

<template>
  <nav class="icon-dock">
    <!-- 顶部主导航项：四大真实抽屉结构 -->
    <div class="dock-top-group">
      <!-- 1. 协议与连接 -->
      <button
        class="dock-item"
        :class="{ active: props.activeDrawer === 'connection' }"
        @click="toggleDrawer('connection')"
        title="串口参数与协议"
      >
        <div class="dock-icon-wrapper">
          <svg class="dock-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          <span class="status-indicator" :class="statusDotClass"></span>
        </div>
        <span class="dock-label">连接</span>
      </button>

      <!-- 2. 预设命令库 -->
      <button
        class="dock-item"
        :class="{ active: props.activeDrawer === 'commands' }"
        @click="toggleDrawer('commands')"
        title="常用命令"
      >
        <div class="dock-icon-wrapper">
          <svg class="dock-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10 9 9 9 8 9"></polyline>
          </svg>
        </div>
        <span class="dock-label">命令</span>
      </button>

      <!-- 3. 元器件仓库 -->
      <button
        class="dock-item"
        :class="{ active: props.activeDrawer === 'widgets' }"
        @click="toggleDrawer('widgets')"
        title="添加显示或控制控件"
      >
        <div class="dock-icon-wrapper">
          <svg class="dock-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
            <line x1="12" y1="22.08" x2="12" y2="12"></line>
          </svg>
        </div>
        <span class="dock-label">控件</span>
      </button>

      <!-- 4. 工程与布局 -->
      <button
        class="dock-item"
        :class="{ active: props.activeDrawer === 'project' }"
        @click="toggleDrawer('project')"
        title="工作区与布局"
      >
        <div class="dock-icon-wrapper">
          <svg class="dock-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <span class="dock-label">工程</span>
      </button>
    </div>

  </nav>
</template>

<style scoped>
.icon-dock {
  width: 44px;
  min-width: 44px;
  height: 100%;
  background: var(--bg-surface, #272623);
  border-right: 1px solid var(--border-subtle, #383633);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  user-select: none;
  z-index: 30;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

.dock-top-group,
.dock-bottom-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.dock-item {
  width: 36px;
  height: 48px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted, #9E9C94);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
  padding: 0;
  position: relative;
}

.dock-item:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-main, #ECEAE4);
}

.dock-item.active {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
  box-shadow: inset 2px 0 0 var(--accent-terracotta, #DA7756);
}

.dock-icon-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
}

.dock-icon {
  width: 18px;
  height: 18px;
  min-width: 18px;
  min-height: 18px;
  flex-shrink: 0;
  display: block;
  transition: transform 0.15s;
}

.dock-item:hover .dock-icon {
  transform: scale(1.08);
}

.dock-label {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: -0.2px;
  line-height: 1;
}

/* 状态小圆点 */
.status-indicator {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--bg-surface, #272623);
}

.status-online {
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);
}

.status-connecting {
  background: #f59e0b;
  animation: pulse-ring 1s infinite;
}

.status-error {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
}

.status-offline {
  background: #64748b;
}

@keyframes pulse-ring {
  0% {
    transform: scale(0.9);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.2);
    opacity: 1;
  }
  100% {
    transform: scale(0.9);
    opacity: 0.8;
  }
}

.dock-item-lock {
  border-top: 1px solid var(--border-subtle, #383633);
  padding-top: 6px;
  height: 52px;
}

.dock-item-lock.locked {
  color: #E59E38;
}

.dock-item-lock.unlocked {
  color: #7AA89B;
}
</style>
