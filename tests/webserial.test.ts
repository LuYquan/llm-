/**
 * WebSerialTransport 与浏览器串口驱动深度单元测试
 */

import assert from 'node:assert/strict';
import { WebSerialTransport } from '../src/services/transport/web-serial-transport.ts';
import { TransportFactory } from '../src/services/transport/factory.ts';
import { TransportError, type TransportStatus, type ParsedBatch } from '../src/services/transport/types.ts';
import { StreamDemuxer } from '../src/services/transport/worker/stream-demuxer.ts';
import type { ProtocolConfig } from '../src/core/protocol/types.ts';
import type { WaveformBatch } from '../src/types/ipc.ts';
import type { WorkerInMessage, WorkerOutMessage } from '../src/services/transport/worker/types.ts';
import { ChannelStore } from '../src/core/channel/ChannelStore.ts';

let passedCount = 0;
let failedCount = 0;
let workerImportSequence = 0;

function encodeFloatFrames(frames: number[][], withTail = true): Uint8Array {
  const length = frames.reduce((sum, frame) => sum + frame.length * 4 + (withTail ? 4 : 0), 0);
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  let offset = 0;
  for (const frame of frames) {
    for (const value of frame) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    if (withTail) {
      data.set([0, 0, 0x80, 0x7f], offset);
      offset += 4;
    }
  }
  return data;
}

function observeWaveforms(transport: WebSerialTransport): WaveformBatch[] {
  // Exercise the real adapter without a simulation timer or physical device.
  Object.assign(transport, { currentStatus: 'connected', sessionId: 'web-frame-test', sessionEpoch: 7 });
  const batches: WaveformBatch[] = [];
  transport.onWaveformBatch((batch) => batches.push(batch));
  return batches;
}

async function runDemuxWorker(config: ProtocolConfig, chunks: Uint8Array[], afterChunks: WorkerInMessage[] = []): Promise<ParsedBatch[]> {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const outputs: WorkerOutMessage[] = [];
  const workerScope = {
    onmessage: null as ((event: { data: WorkerInMessage }) => void) | null,
    postMessage: (message: WorkerOutMessage) => outputs.push(message),
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: workerScope });
  globalThis.setInterval = (() => 0) as any;
  globalThis.clearInterval = (() => {}) as any;
  try {
    // Import a fresh module so parser state and batch buffers cannot leak across cases.
    await import(`../src/services/transport/worker/demuxer.worker.ts?frame-test=${++workerImportSequence}`);
    const send = (data: WorkerInMessage) => workerScope.onmessage!({ data });
    send({ type: 'CONFIGURE', protocolConfig: config });
    for (const chunk of chunks) send({ type: 'CHUNK', data: chunk, timestampUs: 125000 });
    for (const message of afterChunks) send(message);
    send({ type: 'FLUSH' });
    return outputs.flatMap((message) => message.type === 'BATCH' ? [message.batch] : []);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
    else delete (globalThis as any).self;
  }
}

function deliverParsedBatches(transport: WebSerialTransport, batches: ParsedBatch[]): void {
  for (const batch of batches) {
    for (const listener of (transport as any).batchListeners) listener(batch);
  }
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failedCount++;
  }
}

export async function runWebSerialTests() {
  console.log('\n--- 单元测试套件: WebSerialTransport 驱动与宿主能力 ---');

  await test('WebSerialTransport 具备正确的 kind 与网页端 capabilities', () => {
    const transport = new WebSerialTransport();
    assert.equal(transport.kind, 'webserial');
    assert.deepEqual(transport.capabilities, {
      canEnumerateAllPorts: false,
      requiresUserGestureToAddPort: true,
      globalEmergencyStop: false,
      fileSystemLogging: false,
    });
    assert.equal(transport.getCurrentStatus(), 'idle');
    assert.equal(transport.getConnectedPortId(), null);
  });

  await test('未连接时调用 write / emergencyStop 抛出 NotConnected 错误', async () => {
    const transport = new WebSerialTransport();

    await assert.rejects(
      async () => {
        await transport.write(new Uint8Array([1, 2, 3]));
      },
      (err: any) => err instanceof TransportError && err.code === 'NotConnected'
    );

    await assert.rejects(
      async () => {
        await transport.emergencyStop(new Uint8Array([0xff]));
      },
      (err: any) => err instanceof TransportError && err.code === 'NotConnected'
    );
  });

  await test('串口信号控制将明确的 DTR/RTS/Break 状态传给活动端口', async () => {
    const transport = new WebSerialTransport();
    const calls: unknown[] = [];
    (transport as any).activePort = {
      setSignals: async (signals: unknown) => calls.push(signals),
      close: async () => {},
    };

    assert.equal(transport.supportsSignals, true);
    await transport.setSignals({ dtr: true, rts: false, brk: true });
    assert.deepEqual(calls, [{
      dataTerminalReady: true,
      requestToSend: false,
      break: true,
    }]);
    await transport.dispose();
  });

  await test('串口信号控制对未连接或不支持的端口显式报错', async () => {
    const transport = new WebSerialTransport();
    await assert.rejects(
      () => transport.setSignals({ dtr: true }),
      (err: any) => err instanceof TransportError && err.code === 'NotConnected'
    );

    (transport as any).activePort = { close: async () => {} };
    assert.equal(transport.supportsSignals, false);
    await assert.rejects(
      () => transport.setSignals({ dtr: true }),
      (err: any) => err instanceof TransportError && err.code === 'NotSupported'
    );
    await transport.dispose();
  });

  await test('在无 navigator.serial 环境下调用 listPorts 返回内建 mock 设备，requestPort 抛出 NotSupported', async () => {
    const transport = new WebSerialTransport();
    const ports = await transport.listPorts();
    assert.equal(ports.length, 1);
    assert.equal(ports[0].id, 'mock');
    assert.equal(ports[0].port_type, 'Mock');

    await assert.rejects(
      async () => {
        await transport.requestPort();
      },
      (err: any) => err instanceof TransportError && err.code === 'NotSupported'
    );
    await transport.dispose();
  });

  await test('协议配置切换到主线程兜底解析器并保留跨块二进制残帧', async () => {
    const transport = new WebSerialTransport();
    const batches: ParsedBatch[] = [];
    transport.onBatch((batch) => batches.push(batch));
    await transport.configureProtocol({ type: 'rawdata', mode: 'decode', format: 'u16le', channels: 1 });
    (transport as any).fallbackDemuxer = new StreamDemuxer();
    (transport as any).processChunkOnMainThread(new Uint8Array([0x34]));
    assert.equal((transport as any).pendingSamples.length, 0);
    (transport as any).processChunkOnMainThread(new Uint8Array([0x12]));
    (transport as any).flushFallbackBatch();
    assert.deepEqual(batches.flatMap((batch) => batch.samples.map((sample) => [sample.channel, sample.v])), [['ch0', 0x1234]]);

    await assert.rejects(
      () => transport.configureProtocol({ type: 'rawdata', mode: 'decode', format: 'u8', channels: 0 }),
      /通道数必须在 1 到 64/,
    );
    await transport.dispose();
  });

  await test('fallback RawData 同一 chunk 的三帧保留为三列并保持真实到达时间', async () => {
    const transport = new WebSerialTransport();
    await transport.configureProtocol({ type: 'rawdata', mode: 'decode', format: 'u8', channels: 1 });
    const waveforms = observeWaveforms(transport);
    try {
      (transport as any).processChunkOnMainThread(new Uint8Array([1, 2, 3]));
      const arrivalTime = (transport as any).pendingSamples[0].t;
      (transport as any).flushFallbackBatch();
      console.log('    RawData 3 frames =>', JSON.stringify(waveforms[0]?.series));
      assert.deepEqual(waveforms[0].series, [[1, 2, 3]]);
      assert.deepEqual(waveforms[0].timestamps, [arrivalTime, arrivalTime, arrivalTime]);
      assert.equal(waveforms[0].session_id, 'web-frame-test');
      assert.equal(waveforms[0].channel_epoch, 7);
      const store = new ChannelStore(10);
      store.pushSeries(waveforms[0].channel_names, waveforms[0].timestamps, waveforms[0].series);
      assert.deepEqual(Array.from(store.snapshot('ch0').values), [1, 2, 3]);
      assert.deepEqual(Array.from(store.snapshot('ch0').timestamps), [arrivalTime, arrivalTime, arrivalTime]);
      assert.equal((transport as any).pendingFrames.length, 0, 'flush clears frame metadata together with samples');
      (transport as any).flushFallbackBatch();
      assert.equal(waveforms.length, 1, 'a repeated flush must not replay frame metadata');
    } finally {
      await transport.dispose();
    }
  });

  await test('fallback JustFloat 同时间的多帧保持通道对齐与缺失通道 NaN', async () => {
    const transport = new WebSerialTransport();
    await transport.configureProtocol({ type: 'justfloat', channels: null });
    const waveforms = observeWaveforms(transport);
    try {
      (transport as any).processChunkOnMainThread(encodeFloatFrames([[1, 10], [2], [3, 30]]));
      const arrivalTime = (transport as any).pendingSamples[0].t;
      (transport as any).flushFallbackBatch();
      assert.deepEqual(waveforms[0].channel_names, ['ch0', 'ch1']);
      assert.deepEqual(waveforms[0].series, [[1, 2, 3], [10, Number.NaN, 30]]);
      assert.deepEqual(waveforms[0].timestamps, [arrivalTime, arrivalTime, arrivalTime]);
      const store = new ChannelStore(10);
      store.pushSeries(waveforms[0].channel_names, waveforms[0].timestamps, waveforms[0].series);
      assert.deepEqual(Array.from(store.snapshot('ch1').values), [10, Number.NaN, 30]);
    } finally {
      await transport.dispose();
    }
  });

  await test('显式帧的非有限字段、空 samples 和不同 channelNames 保留原帧列', async () => {
    const transport = new WebSerialTransport();
    await transport.configureProtocol({ type: 'rawdata', mode: 'decode', format: 'f32le', channels: 2 });
    const waveforms = observeWaveforms(transport);
    const frames = [
      { timestampUs: 125000, channelNames: ['a', 'b'], values: [Number.NaN, 11] },
      { timestampUs: 125000, channelNames: ['a', 'b'], values: [22, Number.POSITIVE_INFINITY] },
      { timestampUs: 125000, channelNames: ['b'], values: [33] },
      { timestampUs: 125000, channelNames: ['a', 'b'], values: [Number.NaN, Number.NEGATIVE_INFINITY] },
    ];
    // The production binary parsers reject non-finite payloads as bad frames.
    // Inject framed parser output to verify the adapter contract independently.
    (transport as any).fallbackProtocolEngine = {
      feed: () => ({ frames, logs: [], droppedBytes: 0, errorCount: 0 }),
      reset: () => {},
    };
    try {
      (transport as any).processChunkOnMainThread(new Uint8Array([0]));
      assert.deepEqual((transport as any).pendingSamples.map((sample: any) => [sample.channel, sample.v]), [['b', 11], ['a', 22], ['b', 33]]);
      (transport as any).flushFallbackBatch();
      assert.deepEqual(waveforms[0].channel_names, ['a', 'b']);
      assert.deepEqual(waveforms[0].series, [
        [Number.NaN, 22, Number.NaN, Number.NaN],
        [11, Number.NaN, 33, Number.NaN],
      ]);
      assert.deepEqual(waveforms[0].timestamps, [0.125, 0.125, 0.125, 0.125]);
      deliverParsedBatches(transport, [{ samples: [], logLines: [], frames: [frames[3]] }]);
      assert.deepEqual(waveforms[1].series, [[Number.NaN], [Number.NaN]], 'frame metadata must survive even when finite samples are absent');
      const store = new ChannelStore(10);
      store.pushSeries(waveforms[0].channel_names, waveforms[0].timestamps, waveforms[0].series);
      assert.deepEqual(Array.from(store.snapshot('a').values), [Number.NaN, 22, Number.NaN, Number.NaN]);
      assert.deepEqual(Array.from(store.snapshot('b').values), [11, Number.NaN, 33, Number.NaN]);
    } finally {
      await transport.dispose();
    }
  });

  await test('旧 ParsedBatch 无 frames 时维持命名通道、排序和 NaN 缺口', async () => {
    const transport = new WebSerialTransport();
    const waveforms = observeWaveforms(transport);
    try {
      deliverParsedBatches(transport, [{
        samples: [{ channel: 'b', t: 2, v: 20 }, { channel: 'a', t: 1, v: 1 }, { channel: 'b', t: 1, v: 10 }],
        logLines: [],
      }]);
      assert.deepEqual(waveforms[0].channel_names, ['b', 'a']);
      assert.deepEqual(waveforms[0].timestamps, [1, 2]);
      assert.deepEqual(waveforms[0].series, [[10, 20], [1, Number.NaN]]);
      Object.assign(transport, { currentStatus: 'idle' });
      deliverParsedBatches(transport, [{ samples: [], logLines: [], frames: [{ timestampUs: 1, values: [99] }] }]);
      assert.equal(waveforms.length, 1, 'the existing connected-session filter applies to framed batches too');
    } finally {
      await transport.dispose();
    }
  });

  await test('fallback 协议切换和 Worker flush/reset/configure 同步清理帧与样本缓冲', async () => {
    const transport = new WebSerialTransport();
    await transport.configureProtocol({ type: 'rawdata', mode: 'decode', format: 'u8', channels: 2 });
    const waveforms = observeWaveforms(transport);
    try {
      (transport as any).processChunkOnMainThread(new Uint8Array([1, 10]));
      assert.equal((transport as any).pendingFrames.length, 1);
      await transport.configureProtocol({ type: 'rawdata', mode: 'decode', format: 'u8', channels: 1 });
      assert.equal((transport as any).pendingFrames.length, 0);
      assert.equal((transport as any).pendingSamples.length, 0);
      (transport as any).processChunkOnMainThread(new Uint8Array([3, 4]));
      (transport as any).flushFallbackBatch();
      assert.deepEqual(waveforms[0].series, [[3, 4]]);
      assert.equal(waveforms[0].channel_epoch, 8);
    } finally {
      await transport.dispose();
    }

    const config: ProtocolConfig = { type: 'rawdata', mode: 'decode', format: 'u8', channels: 1 };
    const afterReset = await runDemuxWorker(config, [new Uint8Array([1, 2])], [
      { type: 'RESET' },
      { type: 'CHUNK', data: new Uint8Array([8]), timestampUs: 125000 },
      { type: 'FLUSH' },
      { type: 'FLUSH' },
    ]);
    assert.equal(afterReset.length, 1);
    assert.deepEqual(afterReset[0].samples.map((sample) => sample.v), [8]);
    assert.deepEqual(afterReset[0].frames?.map((frame) => frame.values), [[8]]);

    const afterConfigure = await runDemuxWorker(config, [new Uint8Array([1, 2])], [
      { type: 'CONFIGURE', protocolConfig: { type: 'justfloat', channels: 2 } },
      { type: 'CHUNK', data: encodeFloatFrames([[3, 30]]), timestampUs: 125000 },
    ]);
    assert.equal(afterConfigure.length, 2, 'configure flushes the previous protocol before rebuilding');
    assert.deepEqual(afterConfigure[0].frames?.map((frame) => frame.values), [[1], [2]]);
    assert.deepEqual(afterConfigure[1].frames?.map((frame) => frame.values), [[3, 30]]);
  });

  await test('Worker RESET 清除 RawData u16 半帧，重置后仅拼接新的字节', async () => {
    const config: ProtocolConfig = { type: 'rawdata', mode: 'decode', format: 'u16le', channels: 1 };
    const afterReset = await runDemuxWorker(config, [new Uint8Array([0x34])], [
      { type: 'RESET' },
      { type: 'CHUNK', data: new Uint8Array([0x12]), timestampUs: 125000 },
    ]);
    const values = afterReset.flatMap((batch) => batch.samples.map((sample) => sample.v));
    console.log('    Worker u16 half-frame RESET =>', JSON.stringify(values));
    assert.deepEqual(values, [], 'pre-RESET 0x34 must not combine with post-RESET 0x12 into 4660');
    assert.deepEqual(afterReset.flatMap((batch) => batch.frames ?? []), []);

    const nextFrame = await runDemuxWorker(config, [new Uint8Array([0x34])], [
      { type: 'RESET' },
      { type: 'CHUNK', data: new Uint8Array([0x12]), timestampUs: 125000 },
      { type: 'FLUSH' },
      { type: 'CHUNK', data: new Uint8Array([0xab]), timestampUs: 125000 },
    ]);
    assert.deepEqual(nextFrame.flatMap((batch) => batch.samples.map((sample) => sample.v)), [0xab12]);
    assert.deepEqual(nextFrame.flatMap((batch) => batch.frames?.map((frame) => frame.values) ?? []), [[0xab12]]);
  });

  await test('Worker RESET 清除 JustFloat 半帧，残尾不能复活旧帧且后续完整帧可恢复', async () => {
    const config: ProtocolConfig = { type: 'justfloat', channels: 2 };
    const oldFrame = encodeFloatFrames([[1, 10]]);
    const afterReset = await runDemuxWorker(config, [oldFrame.subarray(0, 6)], [
      { type: 'RESET' },
      { type: 'CHUNK', data: oldFrame.subarray(6), timestampUs: 125000 },
      { type: 'FLUSH' },
      { type: 'CHUNK', data: encodeFloatFrames([[2, 20]]), timestampUs: 125000 },
    ]);
    const values = afterReset.flatMap((batch) => batch.samples.map((sample) => sample.v));
    console.log('    Worker JustFloat half-frame RESET =>', JSON.stringify(values));
    assert.deepEqual(values, [2, 20], 'the old [1, 10] frame must not survive RESET');
    assert.deepEqual(afterReset.flatMap((batch) => batch.frames?.map((frame) => frame.values) ?? []), [[2, 20]]);
    assert.equal(afterReset.reduce((sum, batch) => sum + (batch.protocolErrors ?? 0), 0), 1, 'the orphaned two-byte payload is diagnosed');
    assert.equal(afterReset.reduce((sum, batch) => sum + (batch.droppedBytes ?? 0), 0), 2);
  });

  await test('Worker 跨 chunk 二进制残帧和坏浮点帧不会丢掉后续合法帧或串通道', async () => {
    const data = encodeFloatFrames([[1, 10], [Number.NaN, 99], [2, 20], [3, 30]], false);
    const parsed = await runDemuxWorker({ type: 'rawdata', mode: 'decode', format: 'f32le', channels: 2 }, [
      data.subarray(0, 5), data.subarray(5, data.length - 3), data.subarray(data.length - 3),
    ]);
    assert.equal(parsed.reduce((sum, batch) => sum + (batch.protocolErrors ?? 0), 0), 1);
    assert.equal(parsed.reduce((sum, batch) => sum + (batch.droppedBytes ?? 0), 0), 8);
    const transport = new WebSerialTransport();
    const waveforms = observeWaveforms(transport);
    try {
      deliverParsedBatches(transport, parsed);
      assert.deepEqual(waveforms.flatMap((batch) => batch.series[0]), [1, 2, 3]);
      assert.deepEqual(waveforms.flatMap((batch) => batch.series[1]), [10, 20, 30]);
      assert.deepEqual(waveforms.flatMap((batch) => batch.timestamps), [0.125, 0.125, 0.125]);
    } finally {
      await transport.dispose();
    }
  });

  await test('真实 demux Worker 的 RawData / JustFloat 多帧经波形适配仍保留全部帧', async () => {
    for (const config of [
      { type: 'rawdata', mode: 'decode', format: 'u8', channels: 2 },
      { type: 'justfloat', channels: 2 },
    ] as ProtocolConfig[]) {
      const data = config.type === 'rawdata'
        ? new Uint8Array([1, 10, 2, 20, 3, 30])
        : encodeFloatFrames([[1, 10], [2, 20], [3, 30]]);
      const parsed = await runDemuxWorker(config, [data]);
      assert.deepEqual(parsed.flatMap((batch) => batch.samples.map((sample) => sample.v)), [1, 10, 2, 20, 3, 30]);
      const transport = new WebSerialTransport();
      const waveforms = observeWaveforms(transport);
      try {
        deliverParsedBatches(transport, parsed);
        console.log(`    Worker ${config.type} 3 frames =>`, JSON.stringify(waveforms[0]?.series));
        assert.deepEqual(waveforms[0].series, [[1, 2, 3], [10, 20, 30]]);
        assert.deepEqual(waveforms[0].timestamps, [0.125, 0.125, 0.125]);
      } finally {
        await transport.dispose();
      }
    }
  });

  await test('WebSerialTransport 将文本/协议解析错误作为诊断计数派发，不伪装成有效样本', async () => {
    const transport = new WebSerialTransport();
    const batches: ParsedBatch[] = [];
    transport.onBatch((batch) => batches.push(batch));
    (transport as any).fallbackDemuxer = new StreamDemuxer();
    (transport as any).processChunkOnMainThread(new TextEncoder().encode('1.0,broken,3.0\n'));
    (transport as any).flushFallbackBatch();

    assert.equal(batches.flatMap((batch) => batch.samples).length, 0);
    assert.equal(batches.reduce((sum, batch) => sum + (batch.protocolErrors ?? 0), 0), 1);
    await transport.dispose();
  });

  await test('WebSerialTransport 能够连接内建 mock 设备并正常进行仿真与控制', async () => {
    const transport = new WebSerialTransport();
    const batches: ParsedBatch[] = [];
    transport.onBatch((b) => batches.push(b));

    await transport.connect('mock', { baudRate: 115200 });
    assert.equal(transport.getCurrentStatus(), 'connected');
    assert.equal(transport.getConnectedPortId(), 'mock');

    // 发送调参指令
    const writeReceipt = await transport.write(new TextEncoder().encode('SET:PID,2.5,1.0,0.3\n'));
    assert.equal(writeReceipt.status, 'written');
    assert.equal(writeReceipt.byte_count, new TextEncoder().encode('SET:PID,2.5,1.0,0.3\n').length);
    assert.ok(writeReceipt.request_id.length > 0);
    assert.ok(writeReceipt.session_id, 'Web Serial receipts carry the active session identity');
    assert.equal(writeReceipt.epoch, 1);
    await transport.configureProtocol({ type: 'firewater' });
    const protocolEpochReceipt = await transport.write(new TextEncoder().encode('EPOCH_CHECK'));
    assert.equal(protocolEpochReceipt.session_id, writeReceipt.session_id);
    assert.equal(protocolEpochReceipt.epoch, 2, 'protocol rebuild advances the write epoch');
    assert.equal((transport as any).mockKp, 2.5);
    assert.equal((transport as any).mockKi, 1.0);
    assert.equal((transport as any).mockKd, 0.3);

    // 发送急停
    await transport.emergencyStop();
    assert.equal((transport as any).mockTarget, 0);
    await assert.rejects(
      () => transport.write(new TextEncoder().encode('BLOCKED')),
      (err: any) => err instanceof TransportError && /停止屏障/.test(err.message)
    );
    await transport.resumeWrites();
    await transport.write(new TextEncoder().encode('RESUMED'));

    // 等待产生数据批次
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(batches.length > 0, 'mock 设备应定时推送波形批次');

    await transport.disconnect();
    assert.equal(transport.getCurrentStatus(), 'idle');
    await transport.dispose();
  });

  await test('Web Serial 波形批次携带真实 session/epoch 且缺失通道保留断点', async () => {
    const transport = new WebSerialTransport();
    const waveformBatches: any[] = [];
    const unsubscribe = (transport as any).onWaveformBatch((batch: any) => waveformBatches.push(batch));

    await transport.connect('mock', { baudRate: 115200 });
    const firstReceipt = await transport.write(new TextEncoder().encode('IDENTITY_CHECK'));
    // Inject a staggered two-channel batch through the same subscription path
    // to verify that a missing value remains a chart gap instead of becoming 0.
    for (const listener of (transport as any).batchListeners) {
      listener({
        samples: [
          { channel: 'a', t: 1, v: 1 },
          { channel: 'b', t: 2, v: 2 },
        ],
        logLines: [],
      });
    }
    const injected = waveformBatches[0];
    assert.equal(injected.session_id, firstReceipt.session_id);
    assert.equal(injected.channel_epoch, 1);
    assert.deepEqual(injected.series, [[1, Number.NaN], [Number.NaN, 2]]);

    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(waveformBatches.length > 1, 'mock 应产生带身份的波形批次');
    const firstBatch = waveformBatches[1];
    assert.equal(firstBatch.session_id, firstReceipt.session_id);
    assert.equal(firstBatch.channel_epoch, 1);
    assert.ok(firstBatch.channel_names.length >= 2);

    await transport.configureProtocol({ type: 'firewater' });
    const secondReceipt = await transport.write(new TextEncoder().encode('IDENTITY_CHECK_2'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondReceipt.session_id, firstReceipt.session_id);
    assert.equal(secondReceipt.epoch, 2);
    assert.ok(waveformBatches.some((batch) => batch.channel_epoch === 2));

    unsubscribe();
    await transport.dispose();
  });

  await test('WebSerialTransport 可独立暂停采集而保持连接与发送能力', async () => {
    const transport = new WebSerialTransport();
    const batches: ParsedBatch[] = [];
    transport.onBatch((batch) => batches.push(batch));

    await transport.connect('mock', { baudRate: 115200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    batches.length = 0;

    await transport.setAcquisitionEnabled?.(false);
    assert.equal(transport.getCurrentStatus(), 'connected');
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(batches.length, 0, '采集暂停期间不应产生新的 mock 波形批次');
    const writeReceipt = await transport.write(new TextEncoder().encode('PAUSED_WRITE'));
    assert.equal(writeReceipt.status, 'written');

    await transport.setAcquisitionEnabled?.(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(batches.length > 0, '恢复采集后应继续产生波形批次');
    await transport.dispose();
  });

  await test('在具备 navigator.serial 时 listPorts 包含 mock 与物理设备，拔出物理设备时 mock 端口保留', async () => {
    const mockPhysicalPort: any = {
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    };

    let physicalPorts = [mockPhysicalPort];
    const nav = (globalThis as any).navigator || {};
    const oldSerialDesc = Object.getOwnPropertyDescriptor(nav, 'serial');

    Object.defineProperty(nav, 'serial', {
      value: {
        getPorts: async () => physicalPorts,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
      writable: true,
    });

    try {
      const transport = new WebSerialTransport();
      const ports = await transport.listPorts();
      assert.equal(ports.length, 2);
      assert.equal(ports[0].id, 'mock');
      assert.ok(ports[1].id.startsWith('webserial-1a86:7523'));

      // 模拟物理设备拔出后刷新
      physicalPorts = [];
      const portsAfterRemoval = await transport.listPorts();
      assert.equal(portsAfterRemoval.length, 1);
      assert.equal(portsAfterRemoval[0].id, 'mock');

      await transport.dispose();
    } finally {
      if (oldSerialDesc) {
        Object.defineProperty(nav, 'serial', oldSerialDesc);
      } else {
        delete (nav as any).serial;
      }
    }
  });

  await test('navigator.serial.requestPort 授权物理端口成功及用户取消弹窗 (NotFoundError)', async () => {
    const mockPhysicalPort: any = {
      getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
    };

    let shouldCancel = false;
    const nav = (globalThis as any).navigator || {};
    const oldSerialDesc = Object.getOwnPropertyDescriptor(nav, 'serial');

    Object.defineProperty(nav, 'serial', {
      value: {
        getPorts: async () => [],
        requestPort: async () => {
          if (shouldCancel) {
            const err: any = new Error('No port selected by the user');
            err.name = 'NotFoundError';
            throw err;
          }
          return mockPhysicalPort;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
      writable: true,
    });

    try {
      const transport = new WebSerialTransport();

      // 1. 用户授权端口成功
      const port = await transport.requestPort();
      assert.ok(port !== null);
      assert.ok(port!.id.startsWith('webserial-10c4:ea60'));
      assert.equal(port!.port_type, 'WebSerial');

      // 2. 用户取消选择弹窗 -> 优雅返回 null，不抛出异常
      shouldCancel = true;
      const cancelledPort = await transport.requestPort();
      assert.equal(cancelledPort, null);

      await transport.dispose();
    } finally {
      if (oldSerialDesc) {
        Object.defineProperty(nav, 'serial', oldSerialDesc);
      } else {
        delete (nav as any).serial;
      }
    }
  });

  await test('连接不存在的端口抛出 PortNotFound 错误', async () => {
    const transport = new WebSerialTransport();
    await assert.rejects(
      async () => {
        await transport.connect('non-existent-port', { baudRate: 115200 });
      },
      (err: any) => err instanceof TransportError && err.code === 'PortNotFound'
    );
    assert.equal(transport.getCurrentStatus(), 'idle');
  });

  await test('模拟 Web Serial 端口完整的打开、读写、急停与安全顺序关闭', async () => {
    const transport = new WebSerialTransport();

    let openCalled = false;
    let closeCalled = false;
    let readerCancelled = false;
    let readerLockReleased = false;
    let writerLockReleased = false;
    const writtenChunks: Uint8Array[] = [];

    let cancelResolve: any = null;
    const mockReadableStream = {
      getReader() {
        return {
          async read() {
            return new Promise<{ value: undefined; done: true }>((resolve) => {
              cancelResolve = resolve;
            });
          },
          async cancel() {
            readerCancelled = true;
            if (cancelResolve) {
              cancelResolve({ value: undefined, done: true });
            }
          },
          releaseLock() {
            readerLockReleased = true;
          },
        };
      },
    };

    const mockWritableStream = {
      getWriter() {
        return {
          async write(chunk: Uint8Array) {
            writtenChunks.push(chunk);
          },
          async abort() {},
          releaseLock() {
            writerLockReleased = true;
          },
        };
      },
    };

    const mockPort: any = {
      open: async (options: any) => {
        openCalled = true;
        assert.equal(options.baudRate, 115200);
        assert.equal(options.bufferSize, 65536); // 显式 64KB 防溢出
      },
      close: async () => {
        // 严格断言关闭顺序：reader 释放锁后才可调用 port.close()
        assert.ok(readerLockReleased, '必须先释放 reader 锁才能 close port');
        assert.ok(writerLockReleased, '必须先释放 writer 锁才能 close port');
        closeCalled = true;
      },
      readable: mockReadableStream,
      writable: mockWritableStream,
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      setSignals: async (_signals: any) => {},
    };

    // 注入 mock 端口至 transport 内部
    const registered = (transport as any).registerPort(mockPort);
    assert.equal(registered.usbVendorId, 0x1a86);
    assert.ok(registered.label.includes('VID:0x1A86'));

    // 状态流转监听
    const statusHistory: TransportStatus[] = [];
    transport.onStatusChange((s) => statusHistory.push(s));

    // 执行 connect
    await transport.connect(registered.id, { baudRate: 115200 });
    assert.ok(openCalled);
    assert.equal(transport.getCurrentStatus(), 'connected');
    assert.equal(transport.getConnectedPortId(), registered.id);

    // 发送普通数据
    const writeReceipt = await transport.write(new Uint8Array([0x10, 0x20]));
    assert.equal(writeReceipt.status, 'written');
    assert.equal(writeReceipt.byte_count, 2);
    assert.equal(writtenChunks.length, 1);
    assert.deepEqual(Array.from(writtenChunks[0]), [0x10, 0x20]);

    // 发送最高优先级急停指令
    await transport.emergencyStop(new Uint8Array([0xff, 0xfe]));
    assert.equal(writtenChunks.length, 2);
    assert.deepEqual(Array.from(writtenChunks[1]), [0xff, 0xfe]);

    // 重复连接抛出 AlreadyConnected
    await assert.rejects(
      async () => {
        await transport.connect(registered.id, { baudRate: 115200 });
      },
      (err: any) => err instanceof TransportError && err.code === 'AlreadyConnected'
    );

    // 执行断开（严格顺序断言）
    await transport.disconnect();
    assert.ok(readerCancelled);
    assert.ok(readerLockReleased);
    assert.ok(writerLockReleased);
    assert.ok(closeCalled);
    assert.equal(transport.getCurrentStatus(), 'idle');

    await transport.dispose();
  });

  await test('WebSerialTransport 接收数据流并在 onBatch 中分发解析出的波形与日志', async () => {
    const transport = new WebSerialTransport();

    // 模拟数据流：先给 CSV 数据，再给普通日志行
    const chunksToSend = [
      new TextEncoder().encode('10.0,20.0,30.0\n'),
      new TextEncoder().encode('[INFO] Device initialized successfully\n'),
      new TextEncoder().encode('>temp:45.5\n>voltage:3.3\n>temp:46.0\n'),
    ];
    let chunkIdx = 0;

    const mockReadableStream = {
      getReader() {
        return {
          async read() {
            if (chunkIdx < chunksToSend.length) {
              const val = chunksToSend[chunkIdx++];
              return { value: val, done: false };
            }
            // 数据发送完毕，挂起等待 cancel
            return new Promise<{ value: undefined; done: true }>((resolve) => {
              // 挂起状态，由 cancel 触发完成
              this.cancelPromiseResolve = resolve;
            });
          },
          cancelPromiseResolve: null as any,
          async cancel() {
            if (this.cancelPromiseResolve) {
              this.cancelPromiseResolve({ value: undefined, done: true });
            }
          },
          releaseLock() {},
        };
      },
    };

    const mockPort: any = {
      open: async () => {},
      close: async () => {},
      readable: mockReadableStream,
      writable: {
        getWriter: () => ({
          async write() {},
          async abort() {},
          releaseLock() {},
        }),
      },
      getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
    };

    const registered = (transport as any).registerPort(mockPort);

    const receivedBatches: ParsedBatch[] = [];
    transport.onBatch((batch) => {
      receivedBatches.push(batch);
    });

    await transport.connect(registered.id, { baudRate: 115200 });

    // 等待数据被读取与批量推送
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(receivedBatches.length > 0, '必须接收到至少一个 ParsedBatch');

    const allSamples = receivedBatches.flatMap((b) => b.samples);
    const allLogs = receivedBatches.flatMap((b) => b.logLines);

    // 验证 CSV 样本
    const ch0 = allSamples.filter((s) => s.channel === 'setpoint');
    assert.ok(ch0.length > 0, '必须成功提取 setpoint 通道');
    assert.equal(ch0[0].v, 10.0);

    // 验证日志行
    assert.ok(
      allLogs.some((l) => l.text.includes('Device initialized successfully')),
      '必须成功提取系统日志行'
    );

    await transport.disconnect();
    await transport.dispose();
  });

  await test('WebSerialTransport 急停通道清空待发队列与抢占发送', async () => {
    const transport = new WebSerialTransport();
    const writeLog: string[] = [];

    // 创建一个受控的 mock writer，首帧写入人工延迟以形成队列堆积
    let releaseFirstWrite: (() => void) | null = null;
    const mockWritableStream = {
      getWriter() {
        return {
          async write(chunk: Uint8Array) {
            const str = new TextDecoder().decode(chunk);
            writeLog.push(str);
            if (str === 'MSG_1' && releaseFirstWrite === null) {
              // 模拟正在耗时发送的第一帧
              await new Promise<void>((r) => {
                releaseFirstWrite = r;
              });
            }
          },
          async abort() {},
          releaseLock() {},
        };
      },
    };

    const mockPort: any = {
      open: async () => {},
      close: async () => {},
      readable: null,
      writable: mockWritableStream,
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    };

    const reg = (transport as any).registerPort(mockPort);
    await transport.connect(reg.id, { baudRate: 115200 });

    // 1. 发送 MSG_1（将阻塞在 writer.write 中）
    const p1 = transport.write(new TextEncoder().encode('MSG_1'));

    // 2. 紧接着排队 MSG_2 与 MSG_3
    const p2 = transport.write(new TextEncoder().encode('MSG_2'));
    const p3 = transport.write(new TextEncoder().encode('MSG_3'));

    // 3. 立即下发最高优先级急停指令 EMERGENCY
    const pEmerg = transport.emergencyStop(new TextEncoder().encode('EMERGENCY'));

    // 待发队列中的 MSG_2 与 MSG_3 应当被急停机制取消清空
    await assert.rejects(p2, (err: any) => err instanceof TransportError && err.code === 'Timeout');
    await assert.rejects(p3, (err: any) => err instanceof TransportError && err.code === 'Timeout');

    // 释放阻塞的首帧
    if (releaseFirstWrite) {
      (releaseFirstWrite as any)();
    }

    await p1;
    await pEmerg;

    // 验证写入物理端口的顺序：首帧 MSG_1 发送后，紧随其后的是 EMERGENCY，而 MSG_2/MSG_3 被彻底移除
    assert.deepEqual(writeLog, ['MSG_1', 'EMERGENCY']);

    await transport.disconnect();
    await transport.dispose();
  });

  await test('WebSerialTransport 读循环遇到 BufferOverrunError 自动恢复并不断开连接', async () => {
    const transport = new WebSerialTransport();
    let readAttempts = 0;
    const errorsReported: TransportError[] = [];

    transport.onError((err) => {
      errorsReported.push(err);
    });

    const mockReadableStream = {
      getReader() {
        return {
          async read() {
            readAttempts++;
            if (readAttempts === 1) {
              const overrunErr = new Error('Hardware buffer overrun');
              overrunErr.name = 'BufferOverrunError';
              throw overrunErr;
            }
            // 恢复后的第二次 read，正常返回并结束
            return { value: undefined, done: true };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    };

    const mockPort: any = {
      open: async () => {},
      close: async () => {},
      readable: mockReadableStream,
      writable: null,
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    };

    const reg = (transport as any).registerPort(mockPort);
    await transport.connect(reg.id, { baudRate: 115200 });

    // 等待可恢复错误处理与 reader 重建
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(readAttempts >= 2, '遇到可恢复错误后必须重新获取 reader 继续读取');
    assert.ok(
      errorsReported.some((e) => e.code === 'BufferOverflow'),
      '必须正确上报 BufferOverflow 错误事件'
    );
    assert.equal(transport.getCurrentStatus(), 'connected');

    await transport.disconnect();
    await transport.dispose();
  });

  await test('WebSerialTransport 读循环遇到不可恢复错误 (NetworkError) 自动转为 device-lost 并清理资源', async () => {
    const transport = new WebSerialTransport();
    let currentStatus: TransportStatus = 'idle';
    transport.onStatusChange((s) => {
      currentStatus = s;
    });

    let closeCalled = false;
    const mockPort: any = {
      open: async () => {},
      close: async () => {
        closeCalled = true;
      },
      readable: {
        getReader() {
          return {
            async read() {
              const netErr = new Error('The device has been lost.');
              netErr.name = 'NetworkError';
              throw netErr;
            },
            async cancel() {},
            releaseLock() {},
          };
        },
      },
      writable: null,
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    };

    const reg = (transport as any).registerPort(mockPort);
    await transport.connect(reg.id, { baudRate: 115200 });

    await new Promise((r) => setTimeout(r, 80));

    assert.equal(currentStatus, 'device-lost');
    assert.ok(closeCalled, 'device-lost 后必须清理并关闭底层端口句柄');

    await transport.dispose();
  });

  await test('WebSerialTransport 模拟热插拔拔出 (disconnect) 触发 device-lost 状态', async () => {
    const transport = new WebSerialTransport();
    let currentStatus: TransportStatus = 'idle';
    transport.onStatusChange((s) => {
      currentStatus = s;
    });

    const mockPort: any = {
      open: async () => {},
      close: async () => {},
      readable: null,
      writable: null,
      getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6001 }),
    };

    const reg = (transport as any).registerPort(mockPort);
    await transport.connect(reg.id, { baudRate: 9600 });
    assert.equal(currentStatus, 'connected');

    // 模拟原生硬件拔出事件触发
    (transport as any).handleDisconnect({ port: mockPort });
    assert.equal(currentStatus, 'device-lost');

    await transport.dispose();
  });

  await test('WebSerialTransport.setSignals 正确向下传递控制信号', async () => {
    const transport = new WebSerialTransport();
    let receivedSignals: any = null;

    const mockPort: any = {
      open: async () => {},
      close: async () => {},
      readable: null,
      writable: null,
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      setSignals: async (signals: any) => {
        receivedSignals = signals;
      },
    };

    const reg = (transport as any).registerPort(mockPort);
    await transport.connect(reg.id, { baudRate: 115200 });

    await transport.setSignals({ dtr: true, rts: false, brk: true });
    assert.deepEqual(receivedSignals, {
      dataTerminalReady: true,
      requestToSend: false,
      break: true,
    });

    await transport.disconnect();
    await transport.dispose();
  });

  await test('TransportFactory 安全上下文与环境嗅探断言', () => {
    assert.equal(TransportFactory.isTauri(), false);
    assert.equal(TransportFactory.isSecureContext(), false);
    assert.equal(TransportFactory.isWebSerialSupported(), false);
  });

  console.log(`\n========================================`);
  console.log(`WebSerial 测试完成: ${passedCount} 通过, ${failedCount} 失败`);
  console.log(`========================================\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}
