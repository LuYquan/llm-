import assert from 'node:assert/strict';
import { RecordingReplayController, type RecordingReplayState } from '../src/services/recording/replay-controller';
import type { RecordingPage, RecordingSummary } from '../src/services/transport/session';
import type { ProtocolConfig } from '../src/core/protocol/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function recording(sessionId: string, protocolConfig: ProtocolConfig = { type: 'firewater' }, directory = `fixture-${sessionId}`, epoch = 4): RecordingSummary {
  return {
    directory,
    manifest: {
      formatVersion: 1, sessionId, epoch, source: 'fixture', port: null, baudRate: null,
      protocolConfig, timeSource: 'host_monotonic_receive', status: 'complete',
      startedUnixMs: 1000, endedUnixMs: 2000, rxBytes: 0, rxChunks: 0,
      unindexedBytes: 0, segments: [], error: null,
    },
  };
}

function page(item: RecordingSummary, bytes: number[] = [49, 44, 50, 10], rxSequence = 1, eof = true): RecordingPage {
  return {
    sessionId: item.manifest.sessionId, epoch: item.manifest.epoch,
    chunks: [{ rxSequence, receivedAtUs: rxSequence * 1000, bytes }],
    nextAfterRxSequence: rxSequence, eof, sequenceGap: false,
  };
}

function fixture() {
  const state: RecordingReplayState = {
    session: { value: null }, page: { value: null }, chunks: { value: [] }, loading: { value: false },
    error: { value: null }, samples: { value: [] }, logs: { value: [] }, decoder: { value: null },
    decodeNotice: { value: null }, decodeErrorCount: { value: 0 },
  };
  const requests: { sessionId: string; directory: string; afterRxSequence?: number; maxBytes?: number; pending: ReturnType<typeof deferred<RecordingPage>> }[] = [];
  const controller = new RecordingReplayController(state, (sessionId, directory, afterRxSequence, maxBytes) => {
    const pending = deferred<RecordingPage>();
    requests.push({ sessionId, directory, afterRxSequence, maxBytes, pending });
    return pending.promise;
  });
  return { state, requests, controller };
}

export async function runRecordingReplayControllerTests() {
  console.log('--- [RecordingReplayController] 延迟读取与会话归属回归 ---');
  const A = recording('A');
  const B = recording('B', { type: 'rawdata', mode: 'decode', format: 'u8', channels: 1 });

  {
    const { state, requests, controller } = fixture();
    const openingA = controller.open(A);
    const openingB = controller.open(B);
    assert.deepEqual(requests.map((request) => request.sessionId), ['A', 'B'], '切换后必须实际读取新会话');
    const decoderB = state.decoder.value;
    requests[1].pending.resolve(page(B, [7]));
    await openingB;
    assert.equal(state.page.value?.sessionId, 'B');
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [7]);
    requests[0].pending.resolve(page(A));
    await openingA;
    assert.equal(state.session.value?.manifest.sessionId, 'B');
    assert.equal(state.page.value?.sessionId, 'B');
    assert.equal(state.decoder.value, decoderB);
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [7], '旧页不能被新协议误解码');
    assert.deepEqual(state.chunks.value.map((chunk) => chunk.bytes), [[7]]);
    assert.equal(state.loading.value, false);
    assert.equal(state.error.value, null);
  }

  {
    const { state, requests, controller } = fixture();
    const openingA = controller.open(A);
    const openingB = controller.open(B);
    requests[0].pending.resolve(page(A));
    await openingA;
    assert.equal(state.loading.value, true, '旧请求 finally 不能提前解除新请求加载状态');
    assert.equal(state.page.value, null);
    assert.deepEqual(state.samples.value, []);
    requests[1].pending.resolve(page(B, [8]));
    await openingB;
    assert.equal(state.loading.value, false);
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [8]);
  }

  {
    const { state, requests, controller } = fixture();
    const openingA = controller.open(A);
    const openingB = controller.open(B);
    requests[1].pending.reject(new Error('B 读取失败'));
    await openingB;
    requests[0].pending.reject(new Error('旧 A 错误'));
    await openingA;
    assert.equal(state.error.value, 'B 读取失败', '旧请求错误不能覆盖当前可见错误');
    assert.equal(state.loading.value, false);
  }

  for (const reject of [false, true]) {
    const { state, requests, controller } = fixture();
    const opening = controller.open(A);
    controller.close();
    if (reject) requests[0].pending.reject(new Error('关闭后旧错误'));
    else requests[0].pending.resolve(page(A));
    await opening;
    assert.equal(state.session.value, null);
    assert.equal(state.page.value, null);
    assert.equal(state.decoder.value, null);
    assert.equal(state.loading.value, false);
    assert.equal(state.error.value, null);
    assert.deepEqual(state.samples.value, []);
    assert.deepEqual(state.chunks.value, []);
  }

  for (const changedDirectory of [false, true]) {
    const { state, requests, controller } = fixture();
    const reopened = recording('A', B.manifest.protocolConfig!, changedDirectory ? 'another-directory' : A.directory);
    const oldOpen = controller.open(A);
    const newOpen = controller.open(reopened);
    assert.equal(requests.length, 2, '同 ID 重新选择仍必须拥有新的请求世代');
    requests[0].pending.resolve(page(A));
    await oldOpen;
    assert.equal(state.loading.value, true);
    assert.equal(state.page.value, null);
    requests[1].pending.resolve(page(reopened, [9]));
    await newOpen;
    assert.equal(state.session.value?.directory, reopened.directory);
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [9]);
  }

  for (const mismatch of ['sessionId', 'epoch'] as const) {
    const { state, requests, controller } = fixture();
    const opening = controller.open(A);
    const response = page(A);
    if (mismatch === 'sessionId') response.sessionId = 'unexpected';
    else response.epoch += 1;
    requests[0].pending.resolve(response);
    await opening;
    assert.match(state.error.value ?? '', /会话或数据世代不匹配/);
    assert.equal(state.loading.value, false);
    assert.equal(state.page.value, null);
    assert.deepEqual(state.samples.value, []);
    assert.deepEqual(state.chunks.value, []);
  }

  {
    const { state, requests, controller } = fixture();
    const opening = controller.open(A);
    requests[0].pending.resolve(page(A, [49, 44], 1, false));
    await opening;
    assert.deepEqual(state.samples.value, [], '第一块未完成文本行不能提前解码');
    const next = controller.load(1);
    await controller.load(1);
    assert.equal(requests.length, 2, '同一世代重复点击不得重复读取同页');
    assert.equal(requests[1].afterRxSequence, 1);
    assert.equal(requests[1].maxBytes, 64 * 1024);
    requests[1].pending.resolve(page(A, [50, 10], 2, false));
    await next;
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [1, 2], '正常翻页必须沿用当前解码器余帧');
    assert.deepEqual(state.chunks.value.map((chunk) => chunk.rxSequence), [1, 2]);
    const empty = controller.load(2);
    requests[2].pending.resolve({ ...page(A), chunks: [], nextAfterRxSequence: null, eof: true });
    await empty;
    assert.equal(state.page.value?.eof, true);
    assert.deepEqual(state.page.value?.chunks, []);
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [1, 2]);
    assert.equal(state.error.value, null);
    assert.equal(state.loading.value, false);
  }

  {
    const { state, requests, controller } = fixture();
    const opening = controller.open(A);
    requests[0].pending.resolve(page(A, [49, 44], 1, false));
    await opening;
    const failed = controller.load(1);
    requests[1].pending.reject(new Error('当前页读取失败'));
    await failed;
    assert.equal(state.error.value, '当前页读取失败');
    assert.equal(state.page.value?.nextAfterRxSequence, 1);
    assert.equal(state.loading.value, false);
    const retry = controller.load(1);
    assert.equal(state.error.value, null);
    requests[2].pending.resolve(page(A, [50, 10], 2));
    await retry;
    assert.deepEqual(state.samples.value.map((sample) => sample.value), [1, 2], '失败页不得改变 parser，原游标可重试');
  }

  console.log('  ✓ 新会话立即读取，旧响应/错误/finally 不改变当前页、解析器和加载状态');
  console.log('  ✓ 关闭与同 ID 重开使旧请求失效，页 sessionId/epoch 不匹配可见拒绝');
  console.log('  ✓ 正常跨页解析、空页、重复点击、失败游标重试保持原有行为');
}
