import assert from 'node:assert/strict';
import {
  formatRecordingRawChunksCsv,
  formatRecordingSamplesCsv,
  recordingProtocolReplaySupport,
  RecordingReplayDecoder,
} from '../src/services/recording/replay-decoder';
import { buildReplayChartSeries } from '../src/services/recording/replay-chart';
import { selectReplayChannelSamples, summarizeReplayChannels } from '../src/services/recording/replay-analysis';
import type { RecordingPage } from '../src/services/transport/session';

function page(chunks: RecordingPage['chunks'], sequenceGap = false): RecordingPage {
  return {
    sessionId: 'replay-session',
    epoch: 4,
    chunks,
    nextAfterRxSequence: chunks.at(-1)?.rxSequence ?? null,
    eof: true,
    sequenceGap,
  };
}

export function runRecordingReplayTests() {
  console.log('--- [RecordingReplay] 原始会话离线解析与 CSV 测试 ---');

  {
    const decoder = new RecordingReplayDecoder({ type: 'firewater' });
    const first = decoder.feedPage(page([{ rxSequence: 1, receivedAtUs: 1_000_000, bytes: [49, 46, 50, 53, 44] }]));
    assert.equal(first.samples.length, 0, '跨块未完成文本行不能过早输出');
    const second = decoder.feedPage(page([{ rxSequence: 2, receivedAtUs: 2_000_000, bytes: [50, 46, 53, 10] }]));
    assert.deepEqual(second.samples, [
      { channel: 'CH1', timeSeconds: 2, value: 1.25 },
      { channel: 'CH2', timeSeconds: 2, value: 2.5 },
    ]);
  }

  {
    const decoder = new RecordingReplayDecoder({ type: 'justfloat', channels: 1 });
    const first = decoder.feedPage(page([{ rxSequence: 1, receivedAtUs: 10_000, bytes: [0, 0, 0] }]));
    assert.equal(first.samples.length, 0);
    const second = decoder.feedPage(page([{ rxSequence: 2, receivedAtUs: 20_000, bytes: [0x00, 0x00, 0x48, 0x41, 0x00, 0x00, 0x80, 0x7f] }]));
    assert.equal(second.samples.length, 1);
    assert.equal(second.samples[0].value, 12.5);
    assert.equal(second.samples[0].timeSeconds, 0.02);
  }

  {
    const decoder = new RecordingReplayDecoder({ type: 'rawdata', mode: 'decode', format: 'u8', channels: 1 });
    decoder.feedPage(page([{ rxSequence: 1, receivedAtUs: 10, bytes: [42] }]));
    const afterGap = decoder.feedPage(page([{ rxSequence: 4, receivedAtUs: 20, bytes: [43] }], true));
    assert.deepEqual(afterGap.samples, [{ channel: 'CH1', timeSeconds: 0.00002, value: 43 }]);
  }

  assert.match(recordingProtocolReplaySupport(null) || '', /没有保存协议配置/);
  assert.match(recordingProtocolReplaySupport({ type: 'rawdata', mode: 'display', format: 'u8', channels: 1 }) || '', /没有声明数值类型/);
  const csv = formatRecordingSamplesCsv([
    { channel: 'motor,"A"', timeSeconds: 1 / 3, value: Math.PI },
  ], { sessionId: 'session,"1"', epoch: 2, protocol: 'custom', timeSource: 'host_monotonic_receive' });
  assert.match(csv, /"session,""1"""/);
  assert.match(csv, /"motor,""A"""/);
  assert.match(csv, /0\.33333333333333331/);

  const rawCsv = formatRecordingRawChunksCsv([
    { rxSequence: 7, receivedAtUs: 123456, bytes: [0, 10, 255] },
  ], { sessionId: 'raw-session', epoch: 3 });
  assert.match(rawCsv, /rx_sequence,received_at_us,byte_count,raw_hex/);
  assert.match(rawCsv, /"raw-session",3,7,123456,3,"00 0A FF"/);

  const replayChart = buildReplayChartSeries([
    { channel: 'actual', timeSeconds: 0.2, value: 2 },
    { channel: 'actual', timeSeconds: 0.1, value: 1 },
    { channel: 'actual', timeSeconds: 0.3, value: 10 },
    { channel: 'target', timeSeconds: 0.1, value: 5 },
  ], 8);
  assert.deepEqual(replayChart.map((item) => item.channel), ['actual', 'target']);
  assert.equal(replayChart[0].points[0].timeSeconds, 0.1, '回放图表必须按样本时间排序');
  assert.ok(replayChart[0].points.some((point) => point.value === 10), '降采样必须保留通道峰值');

  assert.deepEqual(summarizeReplayChannels([
    { channel: 'B', timeSeconds: 0, value: 2 },
    { channel: 'A', timeSeconds: 0, value: 1 },
    { channel: ' A ', timeSeconds: 1, value: Number.NaN },
    { channel: 'B', timeSeconds: 1, value: 3 },
  ]), [
    { channel: 'A', count: 1 },
    { channel: 'B', count: 2 },
  ]);
  assert.deepEqual(selectReplayChannelSamples([
    { channel: 'A', timeSeconds: 0, value: 1 },
    { channel: 'B', timeSeconds: 0.5, value: 9 },
    { channel: 'A', timeSeconds: 1, value: 2 },
  ], 'A'), { timestamps: [0, 1], values: [1, 2] });

  console.log('  ✓ FireWater 跨块解析保留完整行和值');
  console.log('  ✓ JustFloat 跨页残帧沿用同一离线会话解析器');
  console.log('  ✓ 序号缺口重置解析器，避免跨缺口拼接伪帧');
  console.log('  ✓ 未知/RawData 显示协议说明限制，CSV 正确转义并保持数值精度');
  console.log('  ✓ 回放分析通道摘要只保留有限样本，并按通道提取时间/数值数组');
}
