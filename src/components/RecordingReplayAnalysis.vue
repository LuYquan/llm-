<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
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
let fftJob: CancellableAnalysis<FftAnalysisResult> | null = null;

const channelOptions = computed(() => {
  return summarizeReplayChannels(props.samples);
});

const selectedSamples = computed(() => {
  const selected = selectReplayChannelSamples(props.samples, selectedChannel.value);
  return selected.timestamps.map((timeSeconds, index) => ({
    timeSeconds,
    value: selected.values[index],
  }));
});

watch(channelOptions, (options) => {
  if (!options.some((option) => option.channel === selectedChannel.value)) {
    selectedChannel.value = options[0]?.channel ?? '';
    fftResponse.value = null;
    analysisMessage.value = selectedChannel.value
      ? '通道已切换；点击“计算 FFT”检查时间轴质量。'
      : '当前没有可分析的数值通道。';
  }
}, { immediate: true });

watch(() => props.sessionId, () => {
  fftJob?.cancel();
  fftJob = null;
  isAnalyzing.value = false;
  fftResponse.value = null;
  analysisMessage.value = '已切换回放会话；请选择通道重新分析。';
});

async function runFft() {
  const channel = selectedChannel.value;
  const samples = selectedSamples.value;
  fftJob?.cancel();
  fftJob = null;
  fftResponse.value = null;
  if (!channel) {
    analysisMessage.value = '请先选择一个通道。';
    return;
  }
  if (samples.length < 16) {
    analysisMessage.value = `未计算：通道 ${channel} 只有 ${samples.length} 个有效样本，FFT 至少需要 16 点。`;
    return;
  }

  const timestamps = samples.map((sample) => sample.timeSeconds);
  const values = samples.map((sample) => sample.value);
  const job = analysisWorker.runFft(timestamps, values, 1024, {
    source: 'replay',
    sessionId: props.sessionId,
    epoch: props.epoch,
    channelIds: [channel],
  });
  fftJob = job;
  isAnalyzing.value = true;
  analysisMessage.value = `正在分析 ${channel} 的回放时间轴…`;
  try {
    const response = await job.promise;
    if (fftJob?.id !== job.id) return;
    fftResponse.value = response;
    if (!response.quality.valid || !response.result) {
      analysisMessage.value = `未计算：${response.quality.reason || '回放样本不满足 FFT 前提'}`;
      return;
    }
    analysisMessage.value = 'FFT 已完成；结果带有 replay 来源和原始会话区间。';
  } catch (error) {
    if (fftJob?.id !== job.id) return;
    analysisMessage.value = `FFT 失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (fftJob?.id === job.id) {
      fftJob = null;
      isAnalyzing.value = false;
    }
  }
}

function clearResult() {
  fftJob?.cancel();
  fftJob = null;
  isAnalyzing.value = false;
  fftResponse.value = null;
  analysisMessage.value = '分析结果已清除；原始回放和波形不受影响。';
}

function formatNumber(value: number | null | undefined, digits = 4): string {
  return value !== null && value !== undefined && Number.isFinite(value) ? value.toPrecision(digits) : '—';
}

onUnmounted(() => {
  fftJob?.cancel();
  fftJob = null;
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
        <select v-model="selectedChannel" :disabled="isAnalyzing || channelOptions.length === 0">
          <option v-if="channelOptions.length === 0" value="">无数值通道</option>
          <option v-for="option in channelOptions" :key="option.channel" :value="option.channel">
            {{ option.channel }}（{{ option.count.toLocaleString() }} 点）
          </option>
        </select>
      </label>
      <button type="button" :disabled="isAnalyzing || !selectedChannel" @click="runFft">
        {{ isAnalyzing ? '计算中…' : '计算 FFT' }}
      </button>
      <button type="button" class="recording-replay-analysis-clear" :disabled="isAnalyzing || !fftResponse" @click="clearResult">清除</button>
    </div>
    <p class="recording-replay-analysis-message" :class="{ error: fftResponse && !fftResponse.quality.valid }" role="status">
      {{ analysisMessage }}
    </p>
    <dl v-if="fftResponse?.result && fftResponse.provenance" class="recording-replay-analysis-result">
      <div><dt>主频</dt><dd>{{ formatNumber(fftResponse.result.peakFreq, 5) }} Hz</dd></div>
      <div><dt>峰值幅值</dt><dd>{{ formatNumber(fftResponse.result.peakAmp, 5) }}</dd></div>
      <div><dt>估计采样率</dt><dd>{{ formatNumber(fftResponse.result.sampleRate, 6) }} Hz</dd></div>
      <div><dt>有效点数</dt><dd>{{ fftResponse.provenance.sampleCount.toLocaleString() }}</dd></div>
      <div><dt>时间来源</dt><dd>{{ props.timeSource }}</dd></div>
      <div><dt>区间</dt><dd>{{ formatNumber(fftResponse.provenance.interval.start, 6) }}–{{ formatNumber(fftResponse.provenance.interval.end, 6) }} s</dd></div>
    </dl>
    <p v-if="fftResponse?.provenance" class="recording-replay-analysis-provenance">
      {{ fftResponse.provenance.algorithm.id }} · v{{ fftResponse.provenance.algorithm.version }} · source={{ fftResponse.provenance.source }}
    </p>
  </section>
</template>

<style scoped>
.recording-replay-analysis { display: flex; flex-direction: column; gap: 6px; padding: 7px; border: 1px solid color-mix(in srgb, var(--accent-terracotta) 25%, var(--border-subtle)); border-radius: 6px; background: var(--bg-base); }
.recording-replay-analysis-heading { display: flex; justify-content: space-between; gap: 8px; color: var(--text-main); font-size: 11px; }
.recording-replay-analysis-heading span { color: var(--text-muted); }
.recording-replay-analysis-controls { display: flex; align-items: end; gap: 6px; }
.recording-replay-analysis-controls label { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; color: var(--text-muted); font-size: 11px; }
.recording-replay-analysis-controls select, .recording-replay-analysis-controls button { min-height: 25px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-main); background: var(--bg-elevated); font-size: 11px; }
.recording-replay-analysis-controls select { width: 100%; padding: 3px 5px; }
.recording-replay-analysis-controls button { padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.recording-replay-analysis-controls button:disabled { opacity: .5; cursor: not-allowed; }
.recording-replay-analysis-clear { border-color: var(--border-strong) !important; color: var(--text-main) !important; background: var(--bg-elevated) !important; }
.recording-replay-analysis-message { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.4; }
.recording-replay-analysis-message.error { color: var(--accent-rose); }
.recording-replay-analysis-result { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 11px; margin: 0; }
.recording-replay-analysis-result div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.recording-replay-analysis-result dt { color: var(--text-muted); font-size: 11px; }
.recording-replay-analysis-result dd { overflow: hidden; margin: 0; color: var(--text-main); font: 11px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
.recording-replay-analysis-provenance { margin: 0; color: var(--text-muted); font: 11px/1.4 ui-monospace, monospace; overflow-wrap: anywhere; }
</style>
