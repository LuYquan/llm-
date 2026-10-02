<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { globalProjectModel } from '../core/project/ProjectModel';
import type { ControlLoop, LoopState } from '../core/project/types';
import { globalChannelStore } from '../core/channel/ChannelStore';
import { CascadeStateMachine } from '../core/control/cascadeStateMachine';
import { BandwidthChecker, type BandwidthHierarchyReport } from '../core/control/bandwidthChecker';
import { estimateLoopBandwidth } from '../core/control/loopBandwidth';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'applied'): void;
}>();

const cascadeSM = new CascadeStateMachine(globalProjectModel);

// 响应式数据
const loops = ref<ControlLoop[]>([]);
const activeLoopId = ref<string>('');
const availableChannels = ref<string[]>([]);
const alertMessage = ref<{ type: 'success' | 'warn' | 'error'; text: string } | null>(null);

// 选中的编辑环路
const selectedLoop = computed<ControlLoop | undefined>(() => {
  return loops.value.find((l) => l.id === activeLoopId.value) || loops.value[0];
});

function refreshData() {
  loops.value = globalProjectModel.getLoops();
  const active = globalProjectModel.getActiveLoop();
  activeLoopId.value = active ? active.id : (loops.value[0]?.id || '');
  availableChannels.value = globalChannelStore.listChannels();
}

let unbindModel: (() => void) | null = null;

onMounted(() => {
  refreshData();
  unbindModel = globalProjectModel.onModelChanged(() => {
    refreshData();
  });
});

onUnmounted(() => {
  if (unbindModel) unbindModel();
});

watch(
  () => props.isOpen,
  (val) => {
    if (val) {
      refreshData();
      alertMessage.value = null;
    }
  }
);

// 快捷模板切换
function applyTemplate(tplKey: string) {
  const ok = globalProjectModel.applyTemplate(tplKey);
  if (ok) {
    refreshData();
    showAlert('success', `已成功载入内置拓扑模板: ${getTemplateName(tplKey)}`);
    emit('applied');
  }
}

function getTemplateName(key: string): string {
  switch (key) {
    case 'foc_3loop':
      return 'FOC 电机三环 (电流-速度-位置)';
    case 'drone_cascade':
      return '无人机姿态双环 (角速度-角度)';
    case 'temperature_single':
      return '温控系统单环 (PID + 纯滞后)';
    case 'generic_single':
      return '通用单环 (标准化单回路)';
    default:
      return key;
  }
}

// 切换激活环路
function selectActiveLoop(id: string) {
  activeLoopId.value = id;
  globalProjectModel.setActiveLoop(id);
}

// 状态跃迁控制 (严格受 CascadeStateMachine 保护)
function handleStateTransition(loopId: string, targetState: LoopState) {
  alertMessage.value = null;
  const res = cascadeSM.transition(loopId, targetState);
  if (!res.success) {
    showAlert('error', res.error || '状态切换失败');
    return;
  }

  if (res.invalidatedLoops.length > 0) {
    showAlert(
      'warn',
      `内环状态变更！已触发级联失效：外环 [${res.invalidatedLoops.join(', ')}] 被自动重置为待整定 (untuned)`
    );
  } else {
    showAlert('success', `环路状态已更新为: ${targetState === 'tuned' ? '已整定 (tuned)' : targetState === 'identified' ? '已辨识 (identified)' : '待整定 (untuned)'}`);
  }
  refreshData();
}

// 修改参数与通道保存
function handleFieldChange(field: string, val: any) {
  if (!selectedLoop.value) return;
  const id = selectedLoop.value.id;
  const partial: any = {};

  if (field.startsWith('channels.')) {
    const chKey = field.split('.')[1];
    partial.channels = {
      ...selectedLoop.value.channels,
      [chKey]: val,
    };
  } else if (field.startsWith('params.')) {
    const pKey = field.split('.')[1];
    const cur = selectedLoop.value.current_params || { kp: 1, ki: 0, kd: 0 };
    partial.current_params = {
      ...cur,
      [pKey]: Number(val) || 0,
    };
  } else if (field.startsWith('limits.')) {
    const [_, pName, idxStr] = field.split('.');
    const idx = parseInt(idxStr, 10);
    const limits = selectedLoop.value.param_limits;
    const oldRange = [...((limits as any)[pName] || [0, 100])];
    oldRange[idx] = Number(val) || 0;
    partial.param_limits = {
      ...limits,
      [pName]: oldRange,
    };
  } else {
    partial[field] = val;
  }

  globalProjectModel.updateLoop(id, partial);
}

const bandwidthEvidence = computed(() => loops.value.map(estimateLoopBandwidth));
const bandwidthReport = computed<BandwidthHierarchyReport>(() => BandwidthChecker.checkHierarchy(bandwidthEvidence.value.map(item => item.info)));
const displayBandwidth = (value: number | null | undefined) => value != null && Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : '待提供';

// 提示消息辅助
function showAlert(type: 'success' | 'warn' | 'error', text: string) {
  alertMessage.value = { type, text };
  if (type === 'success') {
    setTimeout(() => {
      if (alertMessage.value?.text === text) alertMessage.value = null;
    }, 4000);
  }
}
</script>

<template>
  <div v-if="isOpen" class="modal-overlay" @click.self="emit('close')">
    <div class="wizard-modal">
      <!-- 模态框顶部导航 -->
      <div class="wizard-header">
        <div class="header-title">
          <span class="icon">🧭</span>
          <div>
            <h3>环路拓扑与串级整定向导</h3>
            <span class="sub">从内到外配置；模型检查与设备验收分别记录</span>
          </div>
        </div>
        <button class="btn-close" @click="emit('close')" title="关闭向导">✕</button>
      </div>

      <!-- 快捷模板切换条 -->
      <div class="template-selector-bar">
        <span class="bar-label">快速预设模板:</span>
        <button
          class="btn-tpl"
          :class="{ active: globalProjectModel.getModel().template === 'foc_3loop' }"
          @click="applyTemplate('foc_3loop')"
        >
          ⚡ FOC 电机三环
        </button>
        <button
          class="btn-tpl"
          :class="{ active: globalProjectModel.getModel().template === 'drone_cascade' }"
          @click="applyTemplate('drone_cascade')"
        >
          🚁 无人机姿态双环
        </button>
        <button
          class="btn-tpl"
          :class="{ active: globalProjectModel.getModel().template === 'temperature_single' }"
          @click="applyTemplate('temperature_single')"
        >
          🌡️ 温控系统单环
        </button>
        <button
          class="btn-tpl"
          :class="{ active: globalProjectModel.getModel().template === 'generic_single' }"
          @click="applyTemplate('generic_single')"
        >
          ⚙️ 通用单环
        </button>
      </div>

      <!-- 提示反馈条 -->
      <div v-if="alertMessage" class="alert-banner" :class="alertMessage.type">
        <span class="alert-icon">
          {{ alertMessage.type === 'error' ? '🚫' : alertMessage.type === 'warn' ? '⚠️' : '✅' }}
        </span>
        <span class="alert-text">{{ alertMessage.text }}</span>
      </div>

      <!-- 核心主体: 上方可视化串级管道 + 下方详细属性与带宽分析 -->
      <div class="wizard-body">
        <!-- 1. 串级多环时序流水线可视化卡片 -->
        <section class="section-pipeline">
          <div class="section-title">
            <span>串级流转状态 (从最内环 Order 0 依次向外推进)</span>
            <span class="rule-hint">先内后外法则：内环未整定，外环严禁辨识与整定</span>
          </div>

          <div class="pipeline-cards">
            <template v-for="(loop, idx) in loops" :key="loop.id">
              <!-- 环路卡片 -->
              <div
                class="loop-card"
                :class="{
                  'is-active': loop.id === activeLoopId,
                  'state-tuned': loop.state === 'tuned',
                  'state-identified': loop.state === 'identified',
                  'state-untuned': loop.state === 'untuned',
                }"
                @click="selectActiveLoop(loop.id)"
              >
                <div class="loop-card-top">
                  <span class="order-badge">层级 {{ loop.order }}: {{ loop.order === 0 ? '最内环' : `${loop.order} 级外环` }}</span>
                  <span
                    class="state-pill"
                    :class="loop.state"
                  >
                    {{ loop.state === 'tuned' ? '✔ 已整定' : loop.state === 'identified' ? '🔬 已辨识' : '⏳ 待整定' }}
                  </span>
                </div>

                <div class="loop-card-name">
                  <strong>{{ loop.name || loop.id }}</strong>
                  <span class="struct-tag">{{ loop.structure }}</span>
                </div>

                <div class="loop-card-channels">
                  <span>目标: {{ loop.channels.setpoint }}</span>
                  <span>反馈: {{ loop.channels.feedback }}</span>
                </div>

                <!-- 快捷状态跃迁按键 -->
                <div class="loop-card-actions" @click.stop>
                  <button
                    v-if="loop.state !== 'tuned'"
                    class="btn-action btn-mark-tuned"
                    title="标记为整定完成 (将校验内环前提)"
                    @click="handleStateTransition(loop.id, 'tuned')"
                  >
                    标为已整定
                  </button>
                  <button
                    v-if="loop.state === 'untuned'"
                    class="btn-action btn-mark-identified"
                    title="标为已辨识"
                    @click="handleStateTransition(loop.id, 'identified')"
                  >
                    标为已辨识
                  </button>
                  <button
                    v-if="loop.state !== 'untuned'"
                    class="btn-action btn-reset"
                    title="重置为待整定 (将级联失效外环)"
                    @click="handleStateTransition(loop.id, 'untuned')"
                  >
                    重置
                  </button>
                </div>
              </div>

              <!-- 环间连接箭头 -->
              <div v-if="idx < loops.length - 1" class="pipeline-connector">
                <span class="arrow-line"></span>
                <span class="arrow-head">▶</span>
                <span class="arrow-text">复合传递</span>
              </div>
            </template>
          </div>
        </section>

        <!-- 2. 下方分栏: 左侧当前环路配置编辑 + 右侧带宽分层检查与建议 -->
        <div class="wizard-columns" v-if="selectedLoop">
          <!-- 左栏: 通道绑定与参数限幅配置 -->
          <div class="col-settings">
            <h4 class="col-title">环路参数与通道映射: {{ selectedLoop.name || selectedLoop.id }}</h4>

            <div class="form-grid">
              <div class="form-group">
                <label>环路显示名称</label>
                <input
                  type="text"
                  :value="selectedLoop.name"
                  @change="handleFieldChange('name', ($event.target as HTMLInputElement).value)"
                  class="input-dark"
                />
              </div>

              <div class="form-group">
                <label>控制器控制结构</label>
                <select
                  :value="selectedLoop.structure"
                  @change="handleFieldChange('structure', ($event.target as HTMLSelectElement).value)"
                  class="select-dark"
                >
                  <option value="P">P (纯比例 - 推荐位置外环)</option>
                  <option value="PI">PI (比例积分 - 推荐速度/电流中内环)</option>
                  <option value="PD">PD (比例微分)</option>
                  <option value="PID">PID (完整 PID - 推荐角速度/温控)</option>
                </select>
              </div>

              <!-- 通道绑定 -->
              <div class="form-group">
                <label>目标设定通道 (Setpoint)</label>
                <div class="input-with-datalist">
                  <input
                    type="text"
                    list="channel-options"
                    :value="selectedLoop.channels.setpoint"
                    @change="handleFieldChange('channels.setpoint', ($event.target as HTMLInputElement).value)"
                    class="input-dark"
                    placeholder="输入或选择通道"
                  />
                </div>
              </div>

              <div class="form-group">
                <label>实际响应通道 (Feedback / Actual)</label>
                <div class="input-with-datalist">
                  <input
                    type="text"
                    list="channel-options"
                    :value="selectedLoop.channels.feedback"
                    @change="handleFieldChange('channels.feedback', ($event.target as HTMLInputElement).value)"
                    class="input-dark"
                    placeholder="输入或选择通道"
                  />
                </div>
              </div>

              <div class="form-group">
                <label>控制输出通道 (Output)</label>
                <div class="input-with-datalist">
                  <input
                    type="text"
                    list="channel-options"
                    :value="selectedLoop.channels.output"
                    @change="handleFieldChange('channels.output', ($event.target as HTMLInputElement).value)"
                    class="input-dark"
                    placeholder="输入或选择通道"
                  />
                </div>
              </div>

              <div class="form-group">
                <label>下发指令模板</label>
                <input
                  type="text"
                  :value="selectedLoop.cmd_template"
                  @change="handleFieldChange('cmd_template', ($event.target as HTMLInputElement).value)"
                  class="input-dark font-mono"
                  placeholder="如 SET_PID {order} {kp} {ki} {kd}"
                />
              </div>
            </div>

            <!-- 参数上下限安全网 (SafetyGuard 依据) -->
            <div class="limits-section">
              <span class="limits-title">SafetyGuard 参数安全限幅区间 [Min, Max]</span>
              <div class="limits-row">
                <div class="limit-box">
                  <span class="limit-tag">Kp:</span>
                  <input
                    type="number"
                    step="0.1"
                    :value="selectedLoop.param_limits.kp[0]"
                    @change="handleFieldChange('limits.kp.0', ($event.target as HTMLInputElement).value)"
                    class="input-mini"
                  />
                  <span>~</span>
                  <input
                    type="number"
                    step="0.1"
                    :value="selectedLoop.param_limits.kp[1]"
                    @change="handleFieldChange('limits.kp.1', ($event.target as HTMLInputElement).value)"
                    class="input-mini"
                  />
                </div>

                <div class="limit-box">
                  <span class="limit-tag">Ki:</span>
                  <input
                    type="number"
                    step="0.1"
                    :value="selectedLoop.param_limits.ki[0]"
                    @change="handleFieldChange('limits.ki.0', ($event.target as HTMLInputElement).value)"
                    class="input-mini"
                  />
                  <span>~</span>
                  <input
                    type="number"
                    step="0.1"
                    :value="selectedLoop.param_limits.ki[1]"
                    @change="handleFieldChange('limits.ki.1', ($event.target as HTMLInputElement).value)"
                    class="input-mini"
                  />
                </div>

                <div class="limit-box">
                  <span class="limit-tag">Kd:</span>
                  <input
                    type="number"
                    step="0.01"
                    :value="selectedLoop.param_limits.kd[0]"
                    @change="handleFieldChange('limits.kd.0', ($event.target as HTMLInputElement).value)"
                    class="input-mini"
                  />
                  <span>~</span>
                  <input
                    type="number"
                    step="0.01"
                    :value="selectedLoop.param_limits.kd[1]"
                    @change="handleFieldChange('limits.kd.1', ($event.target as HTMLInputElement).value)"
                    class="input-mini"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- 右栏: 工业级带宽分层实时诊断 -->
          <div class="col-bandwidth">
            <h4 class="col-title">模型带宽与采样设计检查</h4>
            
            <div class="bandwidth-summary-card" :class="`risk-${bandwidthReport.overall_risk}`">
              <div class="summary-status">
                <span class="badge-status">
                  {{ bandwidthReport.passed ? '经验检查通过' : '检查尚未通过' }}
                </span>
                <span class="summary-text">{{ bandwidthReport.summary }}</span>
              </div>
            </div>

            <div class="bandwidth-evidence" aria-label="带宽数据来源">
              <p v-for="entry in bandwidthEvidence" :key="entry.info.id"><strong>{{ entry.info.name || entry.info.id }}</strong> · {{ displayBandwidth(entry.info.omega_c) }}{{ entry.source === 'model-estimate' ? ' rad/s · 模型估计' : '' }}<br>{{ entry.explanation }}</p>
              <p v-for="message in [...bandwidthReport.input_errors,...bandwidthReport.nyquist_warnings]" :key="message" class="pair-msg">{{ message }}</p>
              <p v-for="message in bandwidthReport.limitations" :key="message">{{ message }}</p>
            </div>

            <!-- 相邻环路频率隔离比检测列表 -->
            <div class="pair-list">
              <div
                v-for="pair in bandwidthReport.pairs"
                :key="`${pair.innerId}_${pair.outerId}`"
                class="pair-item"
                :class="`risk-${pair.risk_level}`"
              >
                <div class="pair-header">
                  <strong class="pair-names">{{ pair.innerName }} ➔ {{ pair.outerName }}</strong>
                  <span class="ratio-badge font-mono">
                    隔离比: {{ displayBandwidth(pair.ratio) }}{{ pair.ratio != null ? 'x' : '' }} (经验阈值 ≥ 3x)
                  </span>
                </div>
                <p class="pair-msg">{{ pair.message }}</p>
                <div class="pair-advice">
                  <span class="advice-icon">💡 优化建议:</span>
                  <span>{{ pair.advice }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="wizard-footer">
        <span class="footer-tip">修改即时写入全局拓扑配置，自动同步至所有绘图控件与 Copilot。</span>
        <button class="btn-primary" @click="emit('close')">完成并返回工作台</button>
      </div>

      <!-- 可选通道 DataList -->
      <datalist id="channel-options">
        <option v-for="ch in availableChannels" :key="ch" :value="ch" />
      </datalist>
    </div>
  </div>
</template>

<style scoped>
.bandwidth-evidence { color:var(--text-muted); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.bandwidth-evidence p { margin:10px 0; }
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.75);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.wizard-modal {
  width: 960px;
  max-width: 95vw;
  max-height: 90vh;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 12px;
  box-shadow: var(--card-shadow, 0 25px 50px -12px rgba(0, 0, 0, 0.5));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-main, #ECEAE4);
}

.wizard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle, #383633);
  background: var(--bg-elevated, #2F2E2A);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-title .icon {
  font-size: 24px;
}

.header-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.header-title .sub {
  font-size: 12px;
  color: var(--text-muted, #9E9C94);
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.btn-close:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.template-selector-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  background: var(--bg-surface, #272623);
  border-bottom: 1px solid var(--border-subtle, #383633);
  overflow-x: auto;
}

.bar-label {
  font-size: 12px;
  color: var(--text-muted, #9E9C94);
  white-space: nowrap;
}

.btn-tpl {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle, #383633);
  background: var(--bg-elevated, #2F2E2A);
  color: var(--text-muted, #9E9C94);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.btn-tpl:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.btn-tpl.active {
  background: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
  color: #ffffff;
  font-weight: 500;
}

.alert-banner {
  padding: 8px 16px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert-banner.success {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
  border-bottom: 1px solid rgba(34, 197, 94, 0.3);
}

.alert-banner.warn {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
  border-bottom: 1px solid rgba(245, 158, 11, 0.3);
}

.alert-banner.error {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border-bottom: 1px solid rgba(239, 68, 68, 0.3);
}

.wizard-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-pipeline {
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  padding: 14px;
}

.section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #E8E6DF);
  margin-bottom: 12px;
}

.rule-hint {
  font-size: 11px;
  color: var(--accent-terracotta, #DA7756);
  font-weight: normal;
}

.pipeline-cards {
  display: flex;
  align-items: center;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.loop-card {
  min-width: 220px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.loop-card:hover {
  border-color: var(--border-focus, #DA7756);
}

.loop-card.is-active {
  border-color: var(--accent-terracotta, #DA7756);
  box-shadow: 0 0 0 1px var(--accent-terracotta, #DA7756);
  background: var(--bg-elevated, #2F2E2A);
}

.loop-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.order-badge {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.state-pill {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.state-pill.tuned {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.state-pill.identified {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
}

.state-pill.untuned {
  background: var(--bg-base, #1F1E1D);
  color: var(--text-muted, #9E9C94);
}

.loop-card-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-main, #E8E6DF);
}

.struct-tag {
  font-size: 10px;
  padding: 1px 4px;
  background: var(--bg-base, #1F1E1D);
  color: var(--accent-terracotta, #DA7756);
  border-radius: 3px;
  font-family: monospace;
}

.loop-card-channels {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  gap: 2px;
}

.loop-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.btn-action {
  flex: 1;
  padding: 4px 6px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--border-subtle, #383633);
  background: var(--bg-base, #1F1E1D);
  color: var(--text-main, #E8E6DF);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-action:hover {
  border-color: var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
}

.btn-mark-tuned {
  border-color: rgba(34, 197, 94, 0.4);
  color: #4ade80;
}

.btn-mark-tuned:hover {
  background: rgba(34, 197, 94, 0.2);
}

.btn-reset {
  color: #f87171;
}

.btn-reset:hover {
  background: rgba(239, 68, 68, 0.15);
}

.pipeline-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  padding: 0 4px;
}

.arrow-head {
  color: var(--accent-terracotta, #DA7756);
  font-size: 14px;
}

.arrow-text {
  font-size: 9px;
  color: var(--text-muted, #9E9C94);
  white-space: nowrap;
}

.wizard-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.col-settings, .col-bandwidth {
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.col-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #E8E6DF);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.input-dark, .select-dark {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #E8E6DF);
  padding: 6px 8px;
  font-size: 12px;
}

.input-dark:focus, .select-dark:focus {
  border-color: var(--accent-terracotta, #DA7756);
  outline: none;
}

.limits-section {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.limits-title {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  font-weight: 500;
}

.limits-row {
  display: flex;
  gap: 8px;
}

.limit-box {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-main, #E8E6DF);
}

.limit-tag {
  font-weight: 600;
  color: var(--accent-terracotta, #DA7756);
}

.input-mini {
  width: 55px;
  background: var(--bg-base, #1F1E1D);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 3px;
  color: var(--text-main, #E8E6DF);
  padding: 2px 4px;
  font-size: 11px;
}

.bandwidth-summary-card {
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
  border: 1px solid var(--border-subtle, #383633);
  background: var(--bg-surface, #272623);
}

.bandwidth-summary-card.risk-safe {
  border-color: rgba(34, 197, 94, 0.4);
}

.badge-status {
  font-weight: 600;
  margin-right: 8px;
}

.pair-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pair-item {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.pair-item.risk-critical {
  border-color: #ef4444;
}

.pair-item.risk-high {
  border-color: #f59e0b;
}

.pair-item.risk-safe {
  border-color: #22c55e;
}

.pair-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.ratio-badge {
  font-size: 11px;
  background: var(--bg-base, #1F1E1D);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--accent-terracotta, #DA7756);
}

.pair-msg {
  margin: 0;
  color: var(--text-main, #E8E6DF);
  font-size: 11px;
}

.pair-advice {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
  display: flex;
  gap: 4px;
}

.advice-icon {
  color: #fbbf24;
  white-space: nowrap;
}

.wizard-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-subtle, #383633);
  background: var(--bg-elevated, #2F2E2A);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.footer-tip {
  font-size: 12px;
  color: var(--text-muted, #9E9C94);
}

.btn-primary {
  padding: 6px 16px;
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 6px;
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-primary:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}
</style>
