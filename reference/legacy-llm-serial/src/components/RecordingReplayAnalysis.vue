<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { FftAnalysisResult, CancellableAnalysis } from '../services/analysis/analysis-worker-client';
import { analysisWorker } from '../services/analysis/analysis-worker-client';
import type { RecordingReplaySample } from '../services/recording/replay-decoder';
import { selectReplayChannelSamples, summarizeReplayChannels } from '../services/recording/replay-analysis';

const props = defineProps<{
  samples: readonly RecordingReplaySample[];
  sessionId: string;
  epoch: number;
  timeSource: string;
}>();

const selectedChannel = ref('');
const isAnalyzing = ref(false);
const analysisMessage = ref('选择通道后可对已读取的回放样本执行 FFT。');
const fftResponse = ref<FftAnalysisResult | null>(null);
interface ReplayFftOwnership {
  readonly revision: number;
  readonly channel: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly timeSource: string;
}
const fftOwnership = shallowRef<ReplayFftOwnership | null>(null);
let fftJob: CancellableAnalysis<FftAnalysisResult> | null = null;
let inputRevision = 0;

const channelOptions = computed(() => {
  return summarizeReplayChannels(props.samples);
});

const selectedSamples = computed(() => {
  return selectReplayChannelSamples(props.samples, selectedChannel.value);
});

function invalidateAnalysis(message: string) {
  // Ownership is revoked before cancellation: a resolved Worker promise can
  // still be delivered after cancel(), and must not commit into a new input.
  inputRevision += 1;
  const previousJob = fftJob;
  fftJob = null;
  previousJob?.cancel();
  isAnalyzing.value = false;
  fftResponse.value = null;
  fftOwnership.value = null;
  analysisMessage.value = message;
}

watch(channelOptions, (options) => {
  if (!options.some((option) => option.channel === selectedChannel.value)) {
    selectedChannel.value = options[0]?.channel ?? '';
    analysisMessage.value = selectedChannel.value
      ? '通道已切换；点击“计算 FFT”检查时间轴质量。'
      : '当前没有可分析的数值通道。';
  }
}, { immediate: true });

// selectedSamples is rebuilt from the actual finite input values. Watching it
// also catches in-place timestamp/value edits, not only array replacement or
// a changed sample count. A sync watcher closes the late-delivery boundary.
watch([
  selectedChannel,
  () => props.sessionId,
  () => props.epoch,
  () => props.timeSource,
  selectedSamples,
], () => invalidateAnalysis(selectedChannel.value
  ? '分析输入已变化，旧结果已撤销；点击“计算 FFT”重新分析。'
  : '当前没有可分析的数值通道。'), { flush: 'sync' });

async function runFft() {
  const channel = selectedChannel.value;
  const { timestamps, values } = selectedSamples.value;
  invalidateAnalysis('');
  if (!channel) {
    analysisMessage.value = '请先选择一个通道。';
    return;
  }
  if (values.length < 16) {
    analysisMessage.value = `未计算：通道 ${channel} 只有 ${values.length} 个有效样本，FFT 至少需要 16 点。`;
    return;
  }

  const ownership: ReplayFftOwnership = Object.freeze({
    revision: inputRevision,
    channel,
    sessionId: props.sessionId,
    epoch: props.epoch,
    timeSource: props.timeSource,
  });
  const job = analysisWorker.runFft(timestamps, values, 1024, {
    source: 'replay',
    sessionId: ownership.sessionId,
    epoch: ownership.epoch,
    channelIds: [channel],
  });
  fftJob = job;
  isAnalyzing.value = true;
  analysisMessage.value = `正在分析 ${channel} 的回放时间轴…`;
  const isCurrent = () => fftJob?.id === job.id && inputRevision === ownership.revision;
  try {
    const response = await job.promise;
    if (!isCurrent()) return;
    fftResponse.value = response;
    fftOwnership.value = ownership;
    if (!response.quality.valid || !response.result) {
      analysisMessage.value = `未计算：${response.quality.reason || '回放样本不满足 FFT 前提'}`;
      return;
    }
    analysisMessage.value = `FFT 已完成：${ownership.channel}；结果保留本次通道、会话和时间来源。`;
  } catch (error) {
    if (!isCurrent()) return;
    analysisMessage.value = `FFT 失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (isCurrent()) {
      fftJob = null;
      isAnalyzing.value = false;
    }
  }
}

function clearResult() {
  invalidateAnalysis(isAnalyzing.value
    ? 'FFT 计算已取消；原始回放和波形不受影响。'
    : '分析结果已清除；原始回放和波形不受影响。');
}

function formatNumber(value: number | null | undefined, digits = 4): string {
  return value !== null && value !== undefined && Number.isFinite(value) ? value.toPrecision(digits) : '—';
}

onUnmounted(() => {
  invalidateAnalysis('');
});
</script>

<template>
  <section class="recording-replay-analysis" aria-label="回放数据分析">
    <div class="recording-replay-analysis-heading">
      <strong>回放分析（只读）</strong>
      <span>不连接设备、不产生串口写入</span>
    </div>
    <div class="recording-replay-analysis-controls">
      <label>
        通道
        <select v-model="selectedChannel" :disabled="channelOptions.length === 0">
          <option v-if="channelOptions.length === 0" value="">无数值通道</option>
          <option v-for="option in channelOptions" :key="option.channel" :value="option.channel">
            {{ option.channel }}（{{ option.count.toLocaleString() }} 点）
          </option>
        </select>
      </label>
      <button type="button" :disabled="isAnalyzing || !selectedChannel" @click="runFft">
        {{ isAnalyzing ? '计算中…' : '计算 FFT' }}
      </button>
      <button type="button" class="recording-replay-analysis-clear" :disabled="!isAnalyzing && !fftResponse" @click="clearResult">{{ isAnalyzing ? '取消计算' : '清除' }}</button>
    </div>
    <p class="recording-replay-analysis-message" :class="{ error: fftResponse && !fftResponse.quality.valid }" role="status">
      {{ analysisMessage }}
    </p>
    <dl v-if="fftResponse?.result && fftResponse.provenance && fftOwnership" class="recording-replay-analysis-result">
      <div><dt>通道</dt><dd>{{ fftOwnership.channel }}</dd></div>
      <div><dt>会话</dt><dd :title="fftOwnership.sessionId">{{ fftOwnership.sessionId }}</dd></div>
      <div><dt>会话轮次</dt><dd>{{ fftOwnership.epoch }}</dd></div>
      <div><dt>主频</dt><dd>{{ formatNumber(fftResponse.result.peakFreq, 5) }} Hz</dd></div>
      <div><dt>峰值幅值</dt><dd>{{ formatNumber(fftResponse.result.peakAmp, 5) }}</dd></div>
      <div><dt>估计采样率</dt><dd>{{ formatNumber(fftResponse.result.sampleRate, 6) }} Hz</dd></div>
      <div><dt>有效点数</dt><dd>{{ fftResponse.provenance.sampleCount.toLocaleString() }}</dd></div>
      <div><dt>时间来源</dt><dd :title="fftOwnership.timeSource">{{ fftOwnership.timeSource }}</dd></div>
      <div><dt>区间</dt><dd>{{ formatNumber(fftResponse.provenance.interval.start, 6) }}–{{ formatNumber(fftResponse.provenance.interval.end, 6) }} s</dd></div>
    </dl>
    <p v-if="fftResponse?.provenance" class="recording-replay-analysis-provenance">
      {{ fftResponse.provenance.algorithm.id }} · v{{ fftResponse.provenance.algorithm.version }} · source={{ fftResponse.provenance.source }}
    </p>
  </section>
</template>

<style scoped>
.recording-replay-analysis { display: flex; flex-direction: column; gap: 6px; padding: 7px; border: 1px solid color-mix(in srgb, var(--accent-terracotta) 25%, var(--border-subtle)); border-radius: 6px; background: var(--bg-base); }
.recording-replay-analysis-heading { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; color: var(--text-main); font-size: 13px; }
.recording-replay-analysis-heading span { color: var(--text-muted); font-size: 12px; }
.recording-replay-analysis-controls { display: flex; align-items: end; gap: 6px; }
.recording-replay-analysis-controls label { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 3px; color: var(--text-muted); font-size: 12px; }
.recording-replay-analysis-controls select, .recording-replay-analysis-controls button { min-height: 32px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-main); background: var(--bg-elevated); font-size: 12px; }
.recording-replay-analysis-controls select { width: 100%; padding: 3px 5px; }
.recording-replay-analysis-controls button { padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.recording-replay-analysis-controls button:disabled { opacity: .5; cursor: not-allowed; }
.recording-replay-analysis-clear { border-color: var(--border-strong) !important; color: var(--text-main) !important; background: var(--bg-elevated) !important; }
.recording-replay-analysis-message { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.recording-replay-analysis-message.error { color: var(--accent-rose); }
.recording-replay-analysis-result { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 11px; margin: 0; }
.recording-replay-analysis-result div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.recording-replay-analysis-result dt { color: var(--text-muted); font-size: 12px; }
.recording-replay-analysis-result dd { overflow: hidden; margin: 0; color: var(--text-main); font: 12px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
.recording-replay-analysis-provenance { margin: 0; color: var(--text-muted); font: 12px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
</style>
