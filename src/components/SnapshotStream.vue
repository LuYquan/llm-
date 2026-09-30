<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useSerialSession } from '../services/transport/session';

import type { StepMetrics, StepSnapshot } from '../types/ipc';
export type { StepMetrics, StepSnapshot };

const emit = defineEmits<{
  (e: 'select-snapshot', snapshot: StepSnapshot): void;
}>();

const snapshots = ref<StepSnapshot[]>([]);
const selectedId = ref<string | null>(null);
const session = useSerialSession();
let unlistener: (() => void) | null = null;

function handleNewSnapshot(snapshot: StepSnapshot) {
  snapshots.value.unshift(snapshot);
  if (snapshots.value.length > 50) {
    snapshots.value.pop();
  }
  if (!selectedId.value) {
    selectSnapshot(snapshot);
  }
}

function selectSnapshot(snapshot: StepSnapshot) {
  selectedId.value = snapshot.id;
  emit('select-snapshot', snapshot);
}

function clearSnapshots() {
  snapshots.value = [];
  selectedId.value = null;
}

function formatTime(timestampUs: number): string {
  const d = new Date(timestampUs / 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

onMounted(() => {
  unlistener = session.onStepSnapshot((snapshot) => {
    handleNewSnapshot(snapshot);
  });
});

onUnmounted(() => {
  if (unlistener) {
    unlistener();
    unlistener = null;
  }
});

defineExpose({
  clearSnapshots,
  handleNewSnapshot,
  snapshots,
  selectedId,
});
</script>

<template>
  <div class="snapshot-stream-card">
    <div class="stream-header">
      <div class="stream-title-group">
        <span class="stream-icon">⚡</span>
        <span class="stream-title">阶跃快照历史流</span>
        <span class="stream-badge">{{ snapshots.length }} 组</span>
      </div>
      <button class="btn-clear" @click="clearSnapshots" :disabled="snapshots.length === 0">
        清空
      </button>
    </div>

    <div class="stream-body" v-if="snapshots.length > 0">
      <div
        v-for="snap in snapshots"
        :key="snap.id"
        class="snapshot-item"
        :class="{ active: selectedId === snap.id, unstable: !snap.metrics.is_stable }"
        @click="selectSnapshot(snap)"
      >
        <div class="item-top">
          <div class="step-transition font-mono">
            <span class="val-before">{{ (snap.metrics.y0 ?? snap.target_before ?? 0).toFixed(1) }}</span>
            <span class="arrow">→</span>
            <span class="val-target">{{ (snap.metrics.y_target ?? snap.target_after ?? 0).toFixed(1) }}</span>
            <span class="step-amp">(Δ={{ snap.step_amplitude != null ? snap.step_amplitude.toFixed(1) : '--' }})</span>
          </div>
          <span
            class="badge-stability"
            :class="snap.status === 'Interrupted' ? 'badge-interrupted' : (snap.metrics.is_stable ? 'badge-stable' : 'badge-divergent')"
          >
            {{ snap.status === 'Interrupted' ? '被打断' : (snap.metrics.is_stable ? '已收敛' : '未收敛') }}
          </span>
        </div>

        <div class="metrics-grid font-mono">
          <div class="metric-cell">
            <span class="cell-label">上升时间 tr</span>
            <span class="cell-value">
              {{ snap.metrics.rise_time_s != null ? snap.metrics.rise_time_s.toFixed(3) + 's' : '--' }}
            </span>
          </div>

          <div class="metric-cell">
            <span class="cell-label">超调量 Mp</span>
            <span
              class="cell-value"
              :class="{
                'val-good': (snap.metrics.overshoot_percent ?? snap.metrics.overshoot_pct ?? 0) <= 10,
                'val-warn': (snap.metrics.overshoot_percent ?? snap.metrics.overshoot_pct ?? 0) > 10 && (snap.metrics.overshoot_percent ?? snap.metrics.overshoot_pct ?? 0) <= 25,
                'val-danger': (snap.metrics.overshoot_percent ?? snap.metrics.overshoot_pct ?? 0) > 25,
              }"
            >
              {{ (snap.metrics.overshoot_percent ?? snap.metrics.overshoot_pct) != null ? (snap.metrics.overshoot_percent ?? snap.metrics.overshoot_pct)!.toFixed(1) + '%' : '--' }}
            </span>
          </div>

          <div class="metric-cell">
            <span class="cell-label">调节时间 ts</span>
            <span class="cell-value">
              {{ snap.metrics.settling_time_s != null ? snap.metrics.settling_time_s.toFixed(2) + 's' : '未收敛' }}
            </span>
          </div>

          <div class="metric-cell">
            <span class="cell-label">稳态误差 ess</span>
            <span
              class="cell-value"
              :class="{
                'val-good': (snap.metrics.steady_state_error ?? 0) <= 0.05,
                'val-warn': (snap.metrics.steady_state_error ?? 0) > 0.05
              }"
            >
              {{ snap.metrics.steady_state_error != null ? snap.metrics.steady_state_error.toFixed(2) : '--' }}
            </span>
          </div>
        </div>

        <div class="item-footer">
          <span class="item-time font-mono">{{ formatTime(snap.timestamp_us) }}</span>
          <span class="channel-hint">{{ snap.channel_binding?.target || snap.target_channel }} ➔ {{ snap.channel_binding?.actual || snap.actual_channel }}</span>
        </div>
      </div>
    </div>

    <div class="stream-empty" v-else>
      <span class="empty-icon">📊</span>
      <p class="empty-title">等待阶跃发生</p>
      <p class="empty-desc">
        当目标值发生突变 (>10%) 时，系统将自动切片捕获阶跃响应并提取四大指标。
      </p>
    </div>
  </div>
</template>

<style scoped>
.snapshot-stream-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: 380px;
}

.stream-header {
  padding: 8px 12px;
  background-color: rgba(24, 34, 50, 0.6);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.stream-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.stream-icon {
  font-size: 13px;
}

.stream-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.stream-badge {
  font-size: 10px;
  background-color: rgba(14, 165, 233, 0.15);
  color: var(--accent-cyan);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
}

.btn-clear {
  background: none;
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-clear:hover:not(:disabled) {
  background-color: rgba(239, 68, 68, 0.15);
  color: var(--accent-rose);
  border-color: rgba(239, 68, 68, 0.3);
}

.btn-clear:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.stream-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
}

.snapshot-item {
  background-color: rgba(11, 15, 23, 0.5);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 8px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.snapshot-item:hover {
  border-color: var(--accent-cyan);
  background-color: rgba(14, 165, 233, 0.05);
}

.snapshot-item.active {
  border-color: var(--accent-cyan);
  box-shadow: 0 0 0 1px rgba(14, 165, 233, 0.4);
  background-color: rgba(14, 165, 233, 0.08);
}

.snapshot-item.unstable {
  border-left: 3px solid var(--accent-rose);
}

.item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.step-transition {
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}

.val-before {
  color: var(--text-secondary);
}

.arrow {
  color: var(--accent-cyan);
}

.val-target {
  color: var(--accent-emerald);
}

.step-amp {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 4px;
}

.badge-stability {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}

.badge-stable {
  background-color: rgba(16, 185, 129, 0.15);
  color: var(--accent-emerald);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.badge-divergent {
  background-color: rgba(239, 68, 68, 0.15);
  color: var(--accent-rose);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.badge-interrupted {
  background-color: rgba(245, 158, 11, 0.15);
  color: var(--accent-amber);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 12px;
  background-color: rgba(0, 0, 0, 0.2);
  padding: 6px;
  border-radius: 4px;
}

.metric-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}

.cell-label {
  color: var(--text-muted);
}

.cell-value {
  font-weight: 600;
  color: var(--text-primary);
}

.val-good {
  color: var(--accent-emerald);
}

.val-warn {
  color: var(--accent-amber);
}

.val-danger {
  color: var(--accent-rose);
}

.item-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-muted);
}

.stream-empty {
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
}

.empty-icon {
  font-size: 24px;
  opacity: 0.6;
}

.empty-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.empty-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
  max-width: 240px;
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
