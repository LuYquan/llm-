import assert from 'node:assert/strict';
import { BrowserRecordingStore } from '../src/services/recording/browser-recording.ts';

export async function runBrowserRecordingTests(): Promise<void> {
  console.log('\n--- 单元测试套件: Web Serial 原始记录与只读分页 ---');

  const store = new BrowserRecordingStore();
  store.setReceiveClock(1000);
  const started = await store.start({
    source: 'mock',
    port: 'mock',
    baudRate: 115200,
    protocolConfig: { type: 'firewater' },
  });
  assert.equal(started.isRecording, true);
  assert.equal(started.rxBytes, 0);

  store.append(new Uint8Array([0x00, 0xff, 0x0a]), 120);
  store.append(new Uint8Array([0x41, 0x42]), 240);
  const stopped = await store.stop();
  assert.equal(stopped.isRecording, false);
  assert.equal(stopped.rxBytes, 5);
  assert.equal(stopped.rxChunks, 2);
  assert.equal(store.status().sessionId, stopped.sessionId);
  assert.equal(store.status().directory, stopped.directory);

  const [summary] = await store.list();
  assert.ok(summary);
  assert.equal(summary.manifest.status, 'complete');
  assert.equal(summary.manifest.source, 'mock');
  assert.equal(summary.manifest.timeSource, 'host_monotonic_receive');

  const first = await store.readPage(summary.manifest.sessionId, summary.directory, undefined, 3);
  assert.deepEqual(first.chunks.map((chunk) => chunk.bytes), [[0x00, 0xff, 0x0a]]);
  assert.equal(first.sequenceGap, false);
  assert.equal(first.eof, false);

  const second = await store.readPage(summary.manifest.sessionId, summary.directory, first.nextAfterRxSequence ?? undefined, 3);
  assert.deepEqual(second.chunks.map((chunk) => chunk.bytes), [[0x41, 0x42]]);
  assert.equal(second.sequenceGap, false);
  assert.equal(second.eof, true);

  console.log('  ✓ Web Serial 原始记录保留二进制字节、接收序号与主机时间，并可只读分页回放');
}
