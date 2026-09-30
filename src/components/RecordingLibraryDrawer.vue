<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { RecordedRawChunk, RecordingPage, RecordingSummary } from '../services/transport/session';
import type { RecordingReplaySample } from '../services/recording/replay-decoder';
import { loadAnalysisHistory, type AnalysisHistoryEntry } from '../services/analysis/analysis-history';
import RecordingReplayChart from './RecordingReplayChart.vue';
import RecordingReplayAnalysis from './RecordingReplayAnalysis.vue';

const props = defineProps<{
  open: boolean;
  recordings: RecordingSummary[];
  loading?: boolean;
  error?: string | null;
  replaySession?: RecordingSummary | null;
  replayPage?: RecordingPage | null;
  replayLoading?: boolean;
  replayError?: string | null;
  replaySamples?: RecordingReplaySample[];
  replayLogs?: { timeSeconds: number; text: string }[];
  replayDecodeNotice?: string | null;
  replayDecodeErrorCount?: number;
}>();

const emit = defineEmits<{
  close: [];
  refresh: [];
  startReplay: [item: RecordingSummary];
  closeReplay: [];
  loadNextPage: [afterRxSequence: number];
  exportReplay: [];
  exportRaw: [];
}>();

const replayIndex = ref(0);
const replayPlaying = ref(false);
const replaySpeed = ref(1);
const analysisHistory = ref<AnalysisHistoryEntry[]>([]);
let replayTimer: number | null = null;

function refreshAnalysisHistory() {
  analysisHistory.value = loadAnalysisHistory().slice(-12).reverse();
}

function historySourceLabel(source: AnalysisHistoryEntry['source']): string {
  if (source === 'live') return '实时';
  if (source === 'replay') return '回放';
  if (source === 'simulation') return '仿真';
  if (source === 'manual') return '手动';
  return '未知';
}

function historyRecording(entry: AnalysisHistoryEntry): RecordingSummary | undefined {
  if (!entry.sessionId) return undefined;
  return props.recordings.find((item) => item.manifest.sessionId === entry.sessionId);
}

function openHistoryRecording(entry: AnalysisHistoryEntry) {
  const item = historyRecording(entry);
  if (item) emit('startReplay', item);
}

const currentReplayChunk = computed<RecordedRawChunk | null>(() => {
  const chunks = props.replayPage?.chunks ?? [];
  return chunks[replayIndex.value] ?? null;
});

const replayHex = computed(() => {
  const bytes = currentReplayChunk.value?.bytes ?? [];
  const shown = bytes.slice(0, 256).map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  return bytes.length > 256 ? `${shown} …（另有 ${bytes.length - 256} 字节）` : shown || '（空）';
});

function clearReplayTimer() {
  if (replayTimer !== null) {
    window.clearTimeout(replayTimer);
    replayTimer = null;
  }
}

function scheduleReplayStep() {
  clearReplayTimer();
  if (!replayPlaying.value || props.replayLoading || props.replayError) return;
  const page = props.replayPage;
  if (!page || page.chunks.length === 0) {
    replayPlaying.value = false;
    return;
  }
  if (replayIndex.value + 1 < page.chunks.length) {
    const current = page.chunks[replayIndex.value];
    const next = page.chunks[replayIndex.value + 1];
    const elapsedMs = Math.max(0, (next.receivedAtUs - current.receivedAtUs) / 1000 / replaySpeed.value);
    // Preserve the recorded host-receive timeline at 1×. Clamping long gaps
    // to two seconds silently sped up playback and made its rate inaccurate.
    replayTimer = window.setTimeout(() => {
      replayIndex.value++;
      scheduleReplayStep();
    }, Math.min(2_147_000_000, elapsedMs));
  } else if (!page.eof && page.nextAfterRxSequence !== null) {
    emit('loadNextPage', page.nextAfterRxSequence);
  } else {
    replayPlaying.value = false;
  }
}

function toggleReplay() {
  if (replayPlaying.value) {
    replayPlaying.value = false;
    clearReplayTimer();
    return;
  }
  replayPlaying.value = true;
  scheduleReplayStep();
}

watch(() => props.replayPage?.chunks[0]?.rxSequence, () => {
  replayIndex.value = 0;
  if (replayPlaying.value) scheduleReplayStep();
});

watch(() => props.replaySession?.manifest.sessionId, () => {
  replayPlaying.value = false;
  replayIndex.value = 0;
  clearReplayTimer();
});

watch(() => props.replayError, (error) => {
  if (error) {
    replayPlaying.value = false;
    clearReplayTimer();
  }
});

onUnmounted(() => {
  replayPlaying.value = false;
  clearReplayTimer();
  if (typeof window !== 'undefined') window.removeEventListener('llm-serial-analysis-history-updated', refreshAnalysisHistory);
});

onMounted(() => {
  refreshAnalysisHistory();
  if (typeof window !== 'undefined') window.addEventListener('llm-serial-analysis-history-updated', refreshAnalysisHistory);
});

watch(() => props.open, (open) => {
  if (open) refreshAnalysisHistory();
});

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatTime(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '未记录';
  return new Date(value).toLocaleString();
}

function formatDuration(start: number, end: number | null): string {
  if (!Number.isFinite(start) || !end || end < start) return end ? '时间无效' : '异常结束';
  const seconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : minutes > 0 ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`;
}

function statusLabel(status: string): string {
  if (status === 'complete') return '已完成';
  if (status === 'interrupted') return '异常中断';
  if (status === 'recording') return '记录中';
  return '状态未知';
}

function formatAnalysisInterval(entry: AnalysisHistoryEntry): string {
  const start = entry.interval.start;
  const end = entry.interval.end;
  if (start === null || end === null) return '时间区间未知';
  return `${start.toPrecision(6)}–${end.toPrecision(6)} s`;
}

function formatAnalysisTime(value: number): string {
  return Number.isFinite(value) ? new Date(value).toLocaleString() : '时间未知';
}
</script>

<template>
  <Transition name="recording-drawer">
    <div v-if="props.open" class="recording-library-backdrop" @click.self="emit('close')">
      <aside class="recording-library" role="dialog" aria-modal="true" aria-labelledby="recording-library-title">
        <header class="recording-library-header">
          <div>
            <h2 id="recording-library-title">记录会话</h2>
            <p>每次采集独立保存；列表只读取已保存的会话清单，不会修改记录。</p>
          </div>
          <button type="button" class="recording-icon-button" aria-label="关闭记录会话" @click="emit('close')">×</button>
        </header>

        <div class="recording-library-actions">
          <span>{{ props.recordings.length }} 个会话</span>
          <button type="button" :disabled="props.loading" @click="emit('refresh')">
            {{ props.loading ? '读取中…' : '刷新列表' }}
          </button>
        </div>

        <section v-if="analysisHistory.length" class="recording-analysis-history" aria-label="最近分析历史">
          <div class="recording-analysis-history-heading">
            <strong>最近分析证据</strong>
            <span>只保存元数据，不保存分析数值</span>
          </div>
          <ul class="recording-analysis-history-list">
            <li v-for="entry in analysisHistory" :key="`${entry.recordedAtMs}-${entry.algorithm.id}-${entry.sessionId || 'none'}`">
              <div class="recording-analysis-history-main">
                <strong>{{ entry.algorithm.id }}</strong>
                <span>{{ historySourceLabel(entry.source) }} · {{ entry.sampleCount.toLocaleString() }} 点 · {{ formatAnalysisTime(entry.recordedAtMs) }}</span>
              </div>
              <div class="recording-analysis-history-meta">
                <span>{{ entry.channelIds.length ? entry.channelIds.join(', ') : '未绑定通道' }}</span>
                <span>{{ formatAnalysisInterval(entry) }}</span>
              </div>
              <button
                v-if="historyRecording(entry)"
                type="button"
                class="recording-analysis-history-open"
                @click="openHistoryRecording(entry)"
              >重新打开会话</button>
            </li>
          </ul>
        </section>

        <p v-if="props.error" class="recording-library-error" role="alert">{{ props.error }}</p>
        <div v-if="props.loading && props.recordings.length === 0" class="recording-library-empty" aria-live="polite">
          正在读取记录清单…
        </div>
        <div v-else-if="props.recordings.length === 0" class="recording-library-empty">
          还没有记录会话。连接设备后，可以在顶栏点击“记录”。
        </div>
        <ul v-else class="recording-library-list">
          <li v-for="item in props.recordings" :key="item.manifest.sessionId + item.directory" class="recording-card">
            <div class="recording-card-heading">
              <strong>{{ item.manifest.port === 'mock' ? '演示 · 模拟遥测' : item.manifest.port || item.manifest.source || '未知来源' }}</strong>
              <span class="recording-status" :class="`status-${item.manifest.status}`">
                {{ statusLabel(item.manifest.status) }}
              </span>
            </div>
            <div class="recording-card-meta">
              <span>{{ formatTime(item.manifest.startedUnixMs) }}</span>
              <span>{{ formatDuration(item.manifest.startedUnixMs, item.manifest.endedUnixMs) }}</span>
            </div>
            <div class="recording-card-meta">
              <span>{{ formatBytes(item.manifest.rxBytes) }} · {{ item.manifest.rxChunks.toLocaleString() }} 块</span>
              <span>{{ item.manifest.port === 'mock' ? '模拟数据' : item.manifest.baudRate ? `${item.manifest.baudRate.toLocaleString()} baud` : item.manifest.timeSource }}</span>
            </div>
            <p v-if="item.manifest.error" class="recording-card-error">{{ item.manifest.error }}</p>
            <div class="recording-card-actions">
              <button
                type="button"
                :disabled="item.manifest.status === 'recording'"
                @click="emit('startReplay', item)"
              >
                只读回放原始 RX
              </button>
            </div>
            <code class="recording-card-path" :title="item.directory">{{ item.directory }}</code>
          </li>
        </ul>

        <section v-if="props.replaySession" class="recording-replay-panel" aria-label="只读记录回放">
          <header class="recording-replay-heading">
            <div>
              <strong>只读原始字节回放</strong>
              <span>{{ props.replaySession.manifest.protocolConfig ? `协议：${props.replaySession.manifest.protocolConfig.type}` : '旧记录未保存协议配置' }}</span>
            </div>
            <button type="button" class="recording-icon-button" aria-label="关闭回放" @click="emit('closeReplay')">×</button>
          </header>
          <p class="recording-replay-note">回放仅读取已保存的原始分块，不连接设备、不发送串口命令；时间为主机接收时间。</p>
          <p v-if="props.replayError" class="recording-library-error" role="alert">{{ props.replayError }}</p>
          <p v-if="props.replayDecodeNotice" class="recording-replay-note">{{ props.replayDecodeNotice }}</p>
          <p v-else-if="props.replayDecodeErrorCount" class="recording-card-error" role="status">
            离线解析发现 {{ props.replayDecodeErrorCount }} 个协议错误；原始 RX 仍保持可核对。
          </p>
          <p v-else-if="props.replayPage?.sequenceGap" class="recording-card-error" role="status">检测到接收序号缺口；当前页只显示索引中可核对的原始块。</p>
          <div v-if="props.replayLoading" class="recording-library-empty" aria-live="polite">读取只读回放页…</div>
          <template v-else-if="props.replayPage && props.replayPage.chunks.length > 0">
            <div class="recording-replay-controls">
              <button type="button" @click="toggleReplay">{{ replayPlaying ? '暂停' : '播放' }}</button>
              <label>速度
                <select v-model.number="replaySpeed">
                  <option :value="0.5">0.5×</option>
                  <option :value="1">1×</option>
                  <option :value="2">2×</option>
                </select>
              </label>
              <span>块 {{ replayIndex + 1 }} / {{ props.replayPage.chunks.length }}</span>
            </div>
            <input
              v-model.number="replayIndex"
              class="recording-replay-seek"
              type="range"
              min="0"
              :max="Math.max(0, props.replayPage.chunks.length - 1)"
              aria-label="当前回放块"
              @input="replayPlaying && scheduleReplayStep()"
            />
            <div v-if="currentReplayChunk" class="recording-replay-meta">
              <span>RX #{{ currentReplayChunk.rxSequence }}</span>
              <span>{{ (currentReplayChunk.receivedAtUs / 1_000_000).toFixed(6) }} 秒</span>
              <span>{{ currentReplayChunk.bytes.length }} 字节</span>
            </div>
            <div v-if="(props.replaySamples?.length ?? 0) > 0" class="recording-replay-decoded">
              <RecordingReplayChart :samples="props.replaySamples ?? []" />
              <RecordingReplayAnalysis
                v-if="props.replaySession.manifest.protocolConfig"
                :samples="props.replaySamples ?? []"
                :session-id="props.replaySession.manifest.sessionId"
                :epoch="props.replaySession.manifest.epoch"
                :time-source="props.replaySession.manifest.timeSource"
              />
              <div class="recording-replay-meta">
                <span>已解析 {{ (props.replaySamples?.length ?? 0).toLocaleString() }} 个样本</span>
                <span>{{ props.replayLogs?.length ?? 0 }} 条文本日志</span>
              </div>
              <div class="recording-replay-decoded-preview">
                <span v-for="sample in (props.replaySamples ?? []).slice(-12)" :key="`${sample.channel}-${sample.timeSeconds}-${sample.value}`">
                  {{ sample.channel }}={{ sample.value.toPrecision(8) }} @ {{ sample.timeSeconds.toFixed(4) }}s
                </span>
              </div>
              <button type="button" class="recording-replay-next" @click="emit('exportReplay')">导出已读取解析样本 CSV</button>
            </div>
            <button type="button" class="recording-replay-next" @click="emit('exportRaw')">导出已读取原始 RX 分块 CSV</button>
            <pre class="recording-replay-hex">{{ replayHex }}</pre>
            <button
              v-if="!props.replayPage.eof && props.replayPage.nextAfterRxSequence !== null"
              type="button"
              class="recording-replay-next"
              :disabled="props.replayLoading"
              @click="emit('loadNextPage', props.replayPage.nextAfterRxSequence)"
            >继续读取下一页</button>
            <span v-else class="recording-replay-end">{{ props.replayPage.eof ? '已到记录末尾' : '正在读取下一页…' }}</span>
          </template>
          <p v-else-if="props.replayPage" class="recording-library-empty">此会话没有可回放的完整原始块。</p>
        </section>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.recording-library-backdrop { position: fixed; inset: 0; z-index: 1200; display: flex; justify-content: flex-end; background: rgb(3 8 18 / 58%); }
.recording-library { width: min(540px, 100vw); height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 20px; color: var(--text-main); background: var(--bg-base); border-left: 1px solid var(--border-strong); box-shadow: -20px 0 60px rgb(0 0 0 / 30%); }
.recording-library-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
.recording-library-header h2 { margin: 0; font-size: 18px; font-weight: 650; }
.recording-library-header p { margin: 6px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.recording-icon-button { width: 32px; height: 32px; border: 1px solid var(--border-strong); border-radius: 8px; color: var(--text-main); background: var(--bg-elevated); font-size: 22px; line-height: 1; cursor: pointer; }
.recording-library-actions { display: flex; align-items: center; justify-content: space-between; color: var(--text-muted); font-size: 12px; }
.recording-library-actions button { border: 1px solid var(--border-strong); border-radius: 7px; padding: 6px 11px; color: var(--text-main); background: var(--bg-elevated); cursor: pointer; }
.recording-library-actions button:disabled { opacity: .55; cursor: progress; }
.recording-analysis-history { display: flex; flex-direction: column; gap: 7px; padding: 11px; border: 1px solid var(--border-strong); border-radius: 11px; background: var(--bg-elevated); }
.recording-analysis-history-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.recording-analysis-history-heading strong { color: var(--text-main); font-size: 11px; }
.recording-analysis-history-heading span { color: var(--text-muted); font-size: 11px; }
.recording-analysis-history-list { display: flex; flex-direction: column; gap: 6px; max-height: 150px; overflow: auto; margin: 0; padding: 0; list-style: none; }
.recording-analysis-history-list li { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 6px 7px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-base); }
.recording-analysis-history-main, .recording-analysis-history-meta { display: flex; justify-content: space-between; gap: 8px; }
.recording-analysis-history-main strong { overflow: hidden; color: var(--text-main); font: 11px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
.recording-analysis-history-main span, .recording-analysis-history-meta { color: var(--text-muted); font-size: 11px; }
.recording-analysis-history-meta span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recording-analysis-history-open { align-self: flex-end; border: 1px solid color-mix(in srgb, var(--accent-terracotta) 25%, var(--border-subtle)); border-radius: 4px; padding: 2px 6px; color: var(--text-main); background: var(--bg-elevated); font-size: 11px; cursor: pointer; }
.recording-library-empty { margin: auto 0; padding: 28px 20px; border: 1px dashed var(--border-strong); border-radius: 12px; color: var(--text-main); text-align: center; font-size: 13px; line-height: 1.6; }
.recording-library-error { margin: 0; padding: 11px 12px; border: 1px solid var(--accent-rose); border-radius: 8px; color: var(--text-main); background: var(--bg-elevated); font-size: 12px; }
.recording-library-list { display: flex; flex-direction: column; gap: 11px; overflow: auto; flex: 1 1 auto; min-height: 100px; margin: 0; padding: 0 4px 12px 0; list-style: none; }
.recording-card { padding: 13px; border: 1px solid var(--border-strong); border-radius: 11px; background: var(--bg-elevated); }
.recording-card-heading, .recording-card-meta { display: flex; align-items: center; justify-content: space-between; gap: 11px; }
.recording-card-heading { margin-bottom: 11px; font-size: 13px; }
.recording-card-heading strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recording-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; color: var(--accent-terracotta); background: color-mix(in srgb, var(--accent-terracotta) 25%, var(--border-subtle)); font-size: 11px; }
.status-interrupted { color: var(--text-main); background: var(--border-strong); }
.status-recording { color: var(--accent-emerald); background: var(--bg-elevated); }
.recording-card-meta { margin-top: 6px; color: var(--text-muted); font-size: 11px; }
.recording-card-error { margin: 8px 0 0; color: var(--accent-rose); font-size: 11px; line-height: 1.45; }
.recording-card-actions { display: flex; justify-content: flex-end; margin-top: 11px; }
.recording-card-actions button, .recording-replay-controls button, .recording-replay-next { border: 1px solid var(--accent-terracotta); border-radius: 6px; padding: 5px 8px; color: var(--text-main); background: color-mix(in srgb, var(--accent-terracotta) 25%, var(--border-subtle)); font-size: 11px; cursor: pointer; }
.recording-card-actions button:disabled, .recording-replay-controls button:disabled, .recording-replay-next:disabled { opacity: .5; cursor: not-allowed; }
.recording-replay-panel { display: flex; flex-direction: column; gap: 8px; flex: 0 0 auto; max-height: 48%; overflow: auto; padding: 12px; border: 1px solid var(--border-strong); border-radius: 11px; background: var(--bg-base); }
.recording-replay-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.recording-replay-heading div { display: flex; flex-direction: column; gap: 3px; }
.recording-replay-heading strong { font-size: 12px; }
.recording-replay-heading span, .recording-replay-note, .recording-replay-end { color: var(--text-muted); font-size: 11px; }
.recording-replay-note { margin: 0; line-height: 1.4; }
.recording-replay-controls { display: flex; align-items: center; gap: 11px; font-size: 11px; color: var(--text-muted); }
.recording-replay-controls label { display: flex; align-items: center; gap: 4px; }
.recording-replay-controls select { border: 1px solid var(--border-strong); border-radius: 4px; padding: 3px; color: var(--text-main); background: var(--bg-elevated); font-size: 11px; }
.recording-replay-controls span { margin-left: auto; }
.recording-replay-seek { width: 100%; accent-color: var(--accent-terracotta); }
.recording-replay-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--text-muted); font-size: 11px; }
.recording-replay-hex { max-height: 86px; overflow: auto; margin: 0; padding: 7px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--accent-terracotta); background: var(--bg-base); font: 11px/1.45 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.recording-replay-decoded { display: flex; flex-direction: column; gap: 6px; padding: 7px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-base); }
.recording-replay-decoded-preview { display: flex; flex-direction: column; gap: 2px; max-height: 90px; overflow: auto; color: var(--text-main); font: 11px/1.4 ui-monospace, monospace; }
.recording-replay-end { text-align: center; }
.recording-card-path { display: block; overflow: hidden; margin-top: 11px; color: var(--text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.recording-drawer-enter-active, .recording-drawer-leave-active { transition: opacity .16s ease; }
.recording-drawer-enter-active .recording-library, .recording-drawer-leave-active .recording-library { transition: transform .18s ease; }
.recording-drawer-enter-from, .recording-drawer-leave-to { opacity: 0; }
.recording-drawer-enter-from .recording-library, .recording-drawer-leave-to .recording-library { transform: translateX(18px); }
@media (prefers-reduced-motion: reduce) { .recording-drawer-enter-active, .recording-drawer-leave-active, .recording-drawer-enter-active .recording-library, .recording-drawer-leave-active .recording-library { transition-duration: 0s; } }
</style>
