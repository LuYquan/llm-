import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { PipelineStatistics } from '../src/services/transport/pipeline-statistics';
import { WebSerialTransport } from '../src/services/transport/web-serial-transport';
import type { ParsedBatch } from '../src/services/transport/types';
import type { ProtocolConfig } from '../src/core/protocol/types';

export async function runPipelineStatisticsTests() {
  const statistics = new PipelineStatistics();
  const batch = { samples: [
    { channel: 'ch0', t: 1, v: 1 }, { channel: 'ch1', t: 1, v: 2 },
    { channel: 'ch0', t: 2, v: 3 }, { channel: 'ch1', t: 2, v: 4 },
  ], logLines: [], droppedBytes: 0 } as ParsedBatch;
  statistics.addBytes(24);
  statistics.addBatch(batch, 1000);
  assert.deepEqual(statistics.snapshot(1050, true), { total_samples: 2, rx_bytes: 24, sample_rate: 2 });
  statistics.addBatch(batch, 1100);
  assert.equal(statistics.snapshot(1100, true).total_samples, 2, 'channel duplication must not inflate sample frames');
  assert.equal(statistics.snapshot(2101, true).sample_rate, 0, 'stale throughput expires');
  assert.equal(statistics.snapshot(1150, false).sample_rate, 0, 'paused acquisition reports no current throughput');
  statistics.resetProtocol();
  assert.deepEqual(statistics.snapshot(2200, true), { total_samples: 0, rx_bytes: 24, sample_rate: 0 });
  statistics.reset();
  assert.equal(statistics.snapshot(2200, true).rx_bytes, 0);

  const binaryStatistics = new PipelineStatistics();
  const framedBatch: ParsedBatch = {
    samples: [
      { channel: 'ch0', t: 0.125, v: 1 }, { channel: 'ch1', t: 0.125, v: 10 },
      { channel: 'ch0', t: 0.125, v: 2 }, { channel: 'ch1', t: 0.125, v: 20 },
      { channel: 'ch0', t: 0.125, v: 3 }, { channel: 'ch1', t: 0.125, v: 30 },
    ],
    frames: [
      { timestampUs: 125000, values: [1, 10] },
      { timestampUs: 125000, values: [2, 20] },
      { timestampUs: 125000, values: [3, 30] },
    ],
    logLines: [],
  };
  binaryStatistics.addBytes(24);
  binaryStatistics.addBatch(framedBatch, 1000);
  console.log('    Binary statistics 3 frames =>', binaryStatistics.snapshot(1050, true).total_samples);
  assert.deepEqual(binaryStatistics.snapshot(1050, true), { total_samples: 3, rx_bytes: 24, sample_rate: 3 });
  binaryStatistics.addBatch({ ...framedBatch, samples: [], frames: [{ timestampUs: 125000, values: [4, 40] }] }, 1100);
  assert.equal(binaryStatistics.snapshot(1150, true).total_samples, 4, 'a new framed batch can have the same host arrival time as a previous batch');
  assert.equal(binaryStatistics.snapshot(1150, true).sample_rate, 4, 'host throughput counts frames, not distinct timestamps or channels');
  assert.equal(binaryStatistics.snapshot(1150, false).sample_rate, 0, 'pausing clears only the displayed current throughput');
  assert.equal(binaryStatistics.snapshot(2000, true).sample_rate, 1, 'only the most recent host delivery remains in the one-second window');
  assert.equal(binaryStatistics.snapshot(2100, true).sample_rate, 0);
  binaryStatistics.resetProtocol();
  assert.deepEqual(binaryStatistics.snapshot(2200, true), { total_samples: 0, rx_bytes: 24, sample_rate: 0 });
  binaryStatistics.addBatch(framedBatch, 2300);
  assert.equal(binaryStatistics.snapshot(2350, true).total_samples, 3, 'protocol reset does not preserve a stale frame watermark');
  binaryStatistics.reset();
  assert.deepEqual(binaryStatistics.snapshot(2400, true), { total_samples: 0, rx_bytes: 0, sample_rate: 0 });

  const transport = new WebSerialTransport();
  const config = reactive<ProtocolConfig>({ type:'rawdata', mode:'decode', format:'u8', channels:1 });
  let clonedMessage: any = null;
  const worker = {
    postMessage(message: unknown) {
      clonedMessage = structuredClone(message);
      const requestId = (message as any).requestId;
      const waiter = (transport as any).protocolWaiters.get(requestId);
      clearTimeout(waiter.timer);
      (transport as any).protocolWaiters.delete(requestId);
      waiter.resolve();
    },
    terminate() {},
  };
  (transport as any).worker = worker;
  await transport.configureProtocol(config);
  assert.equal(clonedMessage.protocolConfig.channels, 1, 'reactive form configuration is cloneable across the Worker boundary');
  config.channels = 3;
  assert.equal((transport as any).protocolConfig.channels, 1, 'editing a form does not mutate the active parser');
  (transport as any).worker = null;
  await transport.dispose();
  console.log('  ✓ 浏览器采集统计、无数据超时及响应式协议 Worker 边界回归测试通过');
}
