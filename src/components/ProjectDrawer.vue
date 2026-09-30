<script setup lang="ts">
import { ref } from 'vue';
import { useWidgetStore } from '../stores/widgetStore';
import type { WorkspaceDocument } from '../services/workspace/document';
import { createControlLabPreset } from '../core/widget/schema';

const props = defineProps<{
  isOpen: boolean;
  workspaceDocument?: WorkspaceDocument | null;
  workspaceImportStatus?: { type: 'success' | 'error'; text: string } | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'import-workspace', json: string): void;
}>();

const store = useWidgetStore();
const fileInputRef = ref<HTMLInputElement | null>(null);
const workspaceFileInputRef = ref<HTMLInputElement | null>(null);

function handleExport() {
  const jsonStr = store.exportDashboardJson();
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `vofa_dashboard_${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function triggerImport() {
  fileInputRef.value?.click();
}

function handleExportWorkspace() {
  if (!props.workspaceDocument) return;
  const json = `${JSON.stringify(props.workspaceDocument, null, 2)}\n`;
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `llm-serial-workspace-v${props.workspaceDocument.version}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function triggerWorkspaceImport() {
  workspaceFileInputRef.value?.click();
}

function handleWorkspaceFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target?.result;
    if (typeof text === 'string') emit('import-workspace', text);
    target.value = '';
  };
  reader.readAsText(file);
}

function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target?.result as string;
    if (text) {
      const res = store.importDashboardJson(text);
      if (res.ok) {
        alert('工作台布局配置已成功导入！');
      } else {
        alert(`导入失败: ${res.error}`);
      }
    }
    target.value = '';
  };
  reader.readAsText(file);
}

function handleResetDefault() {
  if (confirm('确认恢复简洁波形工作台吗？请先导出需要保留的布局。')) {
    store.resetToDefault();
  }
}

function handleAddTab() {
  store.addTab();
}
</script>

<template>
  <aside v-if="props.isOpen" class="project-drawer">
    <header class="drawer-header">
      <div class="header-title">
        <svg class="w-4 h-4 text-sky-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>工程与画布管理</span>
      </div>
      <button class="btn-close" @click="emit('close')">✕</button>
    </header>

    <div class="drawer-body">
      <!-- 多工作台 Tab 列表管理 -->
      <div class="section-box">
        <div class="section-header">
          <span class="section-title">工作台列表 (Tabs)</span>
          <button class="btn-add-tab" @click="handleAddTab" title="新建空白工作台">+ 新建</button>
        </div>
        <div class="tab-items">
          <div
            v-for="t in store.dashboardState.value.tabs"
            :key="t.id"
            class="tab-item-row"
            :class="{ active: store.dashboardState.value.active_tab_id === t.id }"
            @click="store.switchTab(t.id)"
          >
            <div class="tab-item-name">
              <span class="tab-dot"></span>
              <span>{{ t.name }}</span>
            </div>
            <span class="tab-widget-count">{{ t.widgets.length }} 控件</span>
          </div>
        </div>
      </div>

      <!-- JSON 导出与导入 -->
      <div class="section-box">
        <div class="section-title mb-2">布局工程文件 (JSON)</div>
        <div class="btn-grid">
          <button class="btn-tool" @click="handleExport">
            <svg class="w-4 h-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            <span>导出配置 JSON</span>
          </button>

          <button class="btn-tool" @click="triggerImport">
            <svg class="w-4 h-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            <span>导入配置 JSON</span>
          </button>
          <input
            ref="fileInputRef"
            type="file"
            accept=".json"
            class="hidden-file-input"
            @change="handleFileChange"
          />
        </div>
      </div>

      <div class="section-box workspace-document-box">
        <div class="section-title mb-2">完整工作区文件</div>
        <p class="workspace-document-note">包含连接、协议、通道和布局；命令导入后保持草稿，不包含 API Key、原始记录或自动写入授权。</p>
        <div class="btn-grid">
          <button class="btn-tool" :disabled="!props.workspaceDocument" @click="handleExportWorkspace">
            <span>导出完整工作区</span>
          </button>
          <button class="btn-tool" @click="triggerWorkspaceImport">
            <span>预览并导入工作区</span>
          </button>
          <input
            ref="workspaceFileInputRef"
            type="file"
            accept=".json,application/json"
            class="hidden-file-input"
            @change="handleWorkspaceFileChange"
          />
        </div>
        <p v-if="props.workspaceImportStatus" class="workspace-document-status" :class="`status-${props.workspaceImportStatus.type}`" role="status">
          {{ props.workspaceImportStatus.text }}
        </p>
      </div>

      <!-- 重置与清空 -->
      <div class="section-box">
        <div class="section-title mb-2">模板与布局恢复</div>
        <button class="btn-tool" @click="store.addTab('控制实验模板', createControlLabPreset().tabs[1].widgets)">添加控制实验模板</button>
        <button class="btn-tool btn-reset" @click="handleResetDefault">
          <svg class="w-4 h-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
          <span>恢复简洁波形工作台</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.project-drawer {
  position: absolute;
  top: 0;
  left: 44px;
  bottom: 0;
  width: 290px;
  background: var(--bg-surface, #272623);
  border-right: 1px solid var(--border-subtle, #383633);
  box-shadow: var(--card-shadow, 4px 0 24px rgba(0, 0, 0, 0.3));
  display: flex;
  flex-direction: column;
  z-index: 40;
  user-select: none;
  animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background-color 0.25s ease, border-color 0.25s ease;
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
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-elevated, #2F2E2A);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
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
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 14px;
  border-radius: 4px;
  transition: all 0.15s;
}

.btn-close:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.drawer-body {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}

.section-box {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  padding: 12px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted, #9E9C94);
}

.mb-2 {
  margin-bottom: 8px;
}

.btn-add-tab {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.12));
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-add-tab:hover {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
}

.tab-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tab-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  cursor: pointer;
  transition: all 0.15s;
}

.tab-item-row:hover {
  border-color: var(--border-strong, #4A4843);
}

.tab-item-row.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border-color: var(--accent-terracotta, #DA7756);
}

.tab-item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-main, #ECEAE4);
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted, #9E9C94);
}

.tab-item-row.active .tab-dot {
  background: var(--accent-terracotta, #DA7756);
}

.tab-widget-count {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  font-family: var(--font-mono, monospace);
}

.btn-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.btn-tool {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-tool:hover {
  background: var(--bg-elevated, #2F2E2A);
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.btn-tool svg {
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  flex-shrink: 0;
}

.btn-reset {
  color: #E06D85;
  border-color: rgba(224, 109, 133, 0.3);
}

.btn-reset:hover {
  background: rgba(224, 109, 133, 0.15);
  border-color: #E06D85;
  color: #E06D85;
}

.hidden-file-input {
  display: none;
}

.workspace-document-box {
  border-color: var(--border-strong, #4A4843);
}

.workspace-document-note {
  margin: 0 0 10px;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  line-height: 1.45;
}

.workspace-document-status {
  margin: 10px 0 0;
  font-size: 10px;
  line-height: 1.45;
}

.workspace-document-status.status-success { color: #7AA89B; }
.workspace-document-status.status-error { color: #E06D85; }
</style>
