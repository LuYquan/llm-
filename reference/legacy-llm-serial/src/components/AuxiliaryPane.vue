<script setup lang="ts">
import { ref } from 'vue';
import WaveformViewer from './WaveformViewer.vue';
import SnapshotStream from './SnapshotStream.vue';
import WidgetDashboard from './WidgetDashboard.vue';

interface Props {
  activeTab?: 'waveform' | 'dashboard';
  isRunning?: boolean;
  radarScores?: any;
  activeSnapshot?: any;
  isMaximized?: boolean;
}

withDefaults(defineProps<Props>(), {
  activeTab: 'waveform',
  isRunning: false,
  isMaximized: false,
});

const emit = defineEmits<{
  (e: 'update:activeTab', tab: 'waveform' | 'dashboard'): void;
  (e: 'toggle-maximize'): void;
  (e: 'close'): void;
  (e: 'update-mapping', mapping: any): void;
  (e: 'select-snapshot', snapshot: any): void;
  (e: 'open-serial-request'): void;
}>();

const snapshotStreamRef = ref<InstanceType<typeof SnapshotStream> | null>(null);

function switchTab(tab: 'waveform' | 'dashboard') {
  emit('update:activeTab', tab);
}
</script>

<template>
  <div class="auxiliary-pane" :class="{ 'is-maximized': isMaximized }">
    <!-- 扩展翼顶部工具栏：Tabs 胶囊与视口控制 -->
    <header class="aux-header">
      <div class="aux-tabs">
        <button
          type="button"
          class="aux-tab-btn"
          :class="{ 'is-active': activeTab === 'dashboard' }"
          @click="switchTab('dashboard')"
          title="VOFA+ 全融合自定义控件工作台 (多 Tab 画布、图表、仪表盘、滑块)"
        >
          <svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
          <span>VOFA+ 控件工作台</span>
        </button>

        <button
          type="button"
          class="aux-tab-btn"
          :class="{ 'is-active': activeTab === 'waveform' }"
          @click="switchTab('waveform')"
          title="切换至经典双栏波形模式 (波形 + 阶跃快照流，供性能对比)"
        >
          <svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span>经典波形模式</span>
        </button>
      </div>

      <!-- 右侧控制区：全屏与收起 -->
      <div class="aux-actions">
        <button
          type="button"
          class="aux-action-btn"
          @click="emit('toggle-maximize')"
          :title="isMaximized ? '还原分屏视图' : '一键最大化扩展翼 (铺满窗口)'"
        >
          <svg v-if="!isMaximized" width="14" height="14" viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
          </svg>
        </button>

        <button
          type="button"
          class="aux-action-btn close-btn"
          @click="emit('close')"
          title="收起右侧扩展翼"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 扩展翼内容视区 (保留状态，不重复销毁实例) -->
    <div class="aux-body">
      <!-- Tab 1: 实时波形视窗 -->
      <div class="tab-pane" v-show="activeTab === 'waveform'">
        <div class="waveform-tab-layout">
          <section class="waveform-canvas-area">
            <WaveformViewer @update-mapping="emit('update-mapping', $event)" />
          </section>
          <aside class="waveform-side-snapshots">
            <SnapshotStream
              ref="snapshotStreamRef"
              @select-snapshot="emit('select-snapshot', $event)"
            />
          </aside>
        </div>
      </div>

      <!-- Tab 2: 自定义控件工作台 -->
      <div class="tab-pane" v-show="activeTab === 'dashboard'">
        <WidgetDashboard
          :is-running="isRunning"
          @open-serial-request="emit('open-serial-request')"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.auxiliary-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background-color: var(--bg-base);
  overflow: hidden;
  position: relative;
}

.auxiliary-pane.is-maximized {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
}

.aux-header {
  height: 38px;
  background-color: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  flex-shrink: 0;
  user-select: none;
}

.aux-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.aux-tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 4px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.aux-tab-btn:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-main);
}

.aux-tab-btn.is-active {
  background: var(--bg-elevated);
  color: var(--accent-terracotta);
  border-color: rgba(218, 119, 86, 0.3);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.tab-icon {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  flex-shrink: 0;
}

.aux-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.aux-action-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  width: 26px;
  height: 26px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
}

.aux-action-btn svg {
  width: 14px;
  height: 14px;
  min-width: 14px;
  min-height: 14px;
  flex-shrink: 0;
}

.aux-action-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-main);
  border-color: var(--border-subtle);
}

.aux-action-btn.close-btn:hover {
  color: var(--accent-terracotta);
}

.aux-body {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.tab-pane {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 波形 Tab 内部双栏 */
.waveform-tab-layout {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.waveform-canvas-area {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.waveform-side-snapshots {
  width: 220px;
  height: 100%;
  border-left: 1px solid var(--border-subtle);
  background-color: var(--bg-base);
  overflow-y: auto;
  flex-shrink: 0;
}

/* AI Tab 内部垂直流 */
.ai-tab-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow-y: auto;
  padding: 10px;
  gap: 10px;
  box-sizing: border-box;
}

.ai-tab-top {
  display: flex;
  justify-content: center;
  background: var(--bg-surface);
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  padding: 8px;
}

.ai-tab-bottom {
  flex: 1;
}
</style>
