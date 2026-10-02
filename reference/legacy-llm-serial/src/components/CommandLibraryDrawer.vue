<script setup lang="ts">
import { ref } from 'vue';
import type { QuickCmd } from './QuickCommandPanel.vue';

const props = defineProps<{
  isOpen: boolean;
  isRunning: boolean;
  commands: QuickCmd[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'send-command', cmd: QuickCmd): void;
  (e: 'fill-input', text: string): void;
  (e: 'update-commands', list: QuickCmd[]): void;
  (e: 'emergency-stop'): void;
}>();

const showAddModal = ref(false);
const editingCmdId = ref<string | null>(null);

const formName = ref('');
const formText = ref('');
const formIsHex = ref(false);
const formDanger = ref(false);

function openAddModal() {
  editingCmdId.value = null;
  formName.value = '';
  formText.value = '';
  formIsHex.value = false;
  formDanger.value = false;
  showAddModal.value = true;
}

function openEditModal(cmd: QuickCmd) {
  editingCmdId.value = cmd.id;
  formName.value = cmd.name;
  formText.value = cmd.command;
  formIsHex.value = cmd.is_hex;
  formDanger.value = !!cmd.danger;
  showAddModal.value = true;
}

function saveCmd() {
  if (!formName.value.trim() || !formText.value.trim()) return;

  const currentList = [...props.commands];
  if (editingCmdId.value) {
    const idx = currentList.findIndex((c) => c.id === editingCmdId.value);
    if (idx !== -1) {
      currentList[idx] = {
        ...currentList[idx],
        name: formName.value.trim(),
        command: formText.value,
        is_hex: formIsHex.value,
        danger: formDanger.value,
      };
    }
  } else {
    currentList.push({
      id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: formName.value.trim(),
      command: formText.value,
      is_hex: formIsHex.value,
      danger: formDanger.value,
    });
  }

  emit('update-commands', currentList);
  showAddModal.value = false;
}

function deleteCmd(id: string) {
  const currentList = props.commands.filter((c) => c.id !== id);
  emit('update-commands', currentList);
}

function moveCmd(index: number, direction: 'up' | 'down') {
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= props.commands.length) return;

  const currentList = [...props.commands];
  const temp = currentList[index];
  currentList[index] = currentList[targetIndex];
  currentList[targetIndex] = temp;
  emit('update-commands', currentList);
}

function handleSend(cmd: QuickCmd) {
  if (cmd.danger) {
    emit('emergency-stop');
    return;
  }
  emit('send-command', cmd);
}

function handleFill(cmd: QuickCmd) {
  emit('fill-input', cmd.command);
}
</script>

<template>
  <aside v-if="props.isOpen" class="command-library-drawer">
    <header class="drawer-header">
      <div class="header-title">
        <svg class="w-4 h-4 text-sky-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <span>预设命令库</span>
      </div>
      <button class="btn-close" @click="emit('close')">✕</button>
    </header>

    <div class="drawer-toolbar">
      <button class="btn-add-cmd" @click="openAddModal">
        + 新增预设命令
      </button>
      <span class="cmd-count-badge">共 {{ props.commands.length }} 条</span>
    </div>

    <div class="drawer-body custom-scrollbar">
      <div v-if="props.commands.length === 0" class="empty-hint">
        暂无预设指令，点击上方「新增预设命令」添加。
      </div>

      <div
        v-for="(cmd, idx) in props.commands"
        :key="cmd.id"
        class="cmd-card"
        :class="{ 'is-danger': cmd.danger }"
      >
        <div class="cmd-header-line">
          <div class="cmd-title-box">
            <span class="cmd-type-tag" :class="cmd.is_hex ? 'tag-hex' : 'tag-str'">
              {{ cmd.is_hex ? 'HEX' : 'STR' }}
            </span>
            <span class="cmd-name font-bold">{{ cmd.name }}</span>
            <span v-if="cmd.danger" class="cmd-danger-tag">危险</span>
          </div>

          <div class="cmd-sort-btns">
            <button class="btn-sort" :disabled="idx === 0" @click="moveCmd(idx, 'up')" title="上移">▲</button>
            <button class="btn-sort" :disabled="idx === props.commands.length - 1" @click="moveCmd(idx, 'down')" title="下移">▼</button>
          </div>
        </div>

        <div class="cmd-body-line">
          <code class="cmd-content font-mono">{{ cmd.command }}</code>
        </div>

        <div class="cmd-actions-line">
          <div class="left-actions">
            <button class="btn-card-action" @click="openEditModal(cmd)" title="编辑该指令">编辑</button>
            <button class="btn-card-action text-rose-400" @click="deleteCmd(cmd.id)" title="删除该指令">删除</button>
          </div>

          <div class="right-actions">
            <button class="btn-fill-input" @click="handleFill(cmd)" title="将此命令填入底部单行输入框">
              填入输入框
            </button>
            <button
              class="btn-send-cmd"
              :class="{ 'btn-danger-send': cmd.danger }"
              @click="handleSend(cmd)"
              title="立即下发该指令到串口"
            >
              {{ cmd.danger ? '急停' : '下发' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增 / 编辑命令弹窗 -->
    <div v-if="showAddModal" class="modal-backdrop" @click="showAddModal = false">
      <div class="modal-box" @click.stop>
        <div class="modal-title">{{ editingCmdId ? '编辑预设指令' : '新增预设指令' }}</div>

        <div class="modal-form">
          <div class="form-item">
            <label>指令名称:</label>
            <input v-model="formName" type="text" class="input-text" placeholder="如: 读取转速 / 复位" />
          </div>
          <div class="form-item">
            <label>指令内容:</label>
            <textarea v-model="formText" class="input-textarea font-mono" rows="3" placeholder="如: SET:KP=1.0\n 或 AA 01 55"></textarea>
          </div>
          <div class="form-item-check">
            <label class="check-label">
              <input v-model="formIsHex" type="checkbox" />
              <span>十六进制 (HEX 格式，如 01 03 00 00)</span>
            </label>
          </div>
          <div class="form-item-check">
            <label class="check-label text-rose-400">
              <input v-model="formDanger" type="checkbox" />
              <span>标记为危险操作 (带二次确认或最高优先级急停)</span>
            </label>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-cancel" @click="showAddModal = false">取消</button>
          <button class="btn-confirm" @click="saveCmd">保存</button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.command-library-drawer {
  position: absolute;
  top: 0;
  left: 44px;
  bottom: 0;
  width: 320px;
  background: var(--bg-surface, #272623);
  border-right: 1px solid var(--border-subtle, #383633);
  display: flex;
  flex-direction: column;
  z-index: 40;
  box-shadow: var(--card-shadow, 10px 0 30px rgba(0, 0, 0, 0.3));
  user-select: none;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

.drawer-header {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  padding: 2px 6px;
  transition: all 0.15s;
}

.btn-close:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.drawer-toolbar {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-surface, #272623);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.btn-add-cmd {
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-add-cmd:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}

.cmd-count-badge {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-hint {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  text-align: center;
  padding: 30px 10px;
}

.cmd-card {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: all 0.15s ease;
}

.cmd-card:hover {
  border-color: var(--border-strong, #4A4843);
  background: var(--bg-surface, #272623);
}

.cmd-card.is-danger {
  border-left: 3px solid #ef4444;
}

.cmd-header-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cmd-title-box {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cmd-type-tag {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 700;
}

.tag-str {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  color: var(--accent-terracotta, #DA7756);
}

.tag-hex {
  background: rgba(229, 158, 56, 0.15);
  color: #E59E38;
}

.cmd-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-main, #ECEAE4);
}

.cmd-danger-tag {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
}

.cmd-sort-btns {
  display: flex;
  gap: 2px;
}

.btn-sort {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 8px;
  cursor: pointer;
  padding: 2px 4px;
}

.btn-sort:hover:not(:disabled) {
  color: var(--accent-terracotta, #DA7756);
}

.btn-sort:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.cmd-body-line {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 4px 6px;
  overflow: hidden;
}

.cmd-content {
  font-size: 11px;
  color: var(--text-main, #ECEAE4);
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono, monospace);
}

.cmd-actions-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.left-actions,
.right-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.btn-card-action {
  background: transparent;
  border: none;
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  padding: 0;
}

.btn-card-action:hover {
  color: var(--text-main, #ECEAE4);
}

.btn-fill-input {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-fill-input:hover {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

.btn-send-cmd {
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-send-cmd:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}

.btn-danger-send {
  background: #ef4444;
  border-color: #ef4444;
}

.btn-danger-send:hover {
  background: #dc2626;
  border-color: #dc2626;
}

/* 模态框 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(4px);
}

.modal-box {
  width: 340px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--card-shadow, 0 16px 36px rgba(0, 0, 0, 0.4));
}

.modal-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-item label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.input-text {
  height: 28px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  padding: 0 8px;
  font-size: 11px;
  outline: none;
}

.input-text:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.input-textarea {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  padding: 6px 8px;
  font-size: 11px;
  outline: none;
  resize: vertical;
  font-family: var(--font-mono, monospace);
}

.input-textarea:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.form-item-check {
  display: flex;
  align-items: center;
}

.check-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle, #383633);
}

.btn-cancel {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  padding: 5px 12px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-cancel:hover {
  color: var(--text-main, #ECEAE4);
}

.btn-confirm {
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: #ffffff;
  padding: 5px 14px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-confirm:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}
</style>
