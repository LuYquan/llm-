import assert from 'node:assert/strict';
import { ChannelStore } from '../src/core/channel/ChannelStore.ts';
import type { ChannelViewBatch } from '../src/core/channel/types.ts';
import { isAcknowledgementForWrite, isFreshChannelValue } from '../src/core/tuning/write-correlation.ts';
import type { AcknowledgementCorrelation, ParameterReadbackCorrelation } from '../src/core/tuning/write-correlation.ts';

const identity = { writeStatus: 'written' as const, sessionId: 'device-current', epoch: 3,
  currentSessionId: 'device-current', currentEpoch: 3 };
const ackContext: AcknowledgementCorrelation = { ...identity, startedAt: 1000, startLogId: 20, protocolRequestId: 'trial-current' };
const ack = { id: 21, tag: '[RX]', level: 'info', text: 'PID_APPLIED trial-current', at: 1001 };

assert.equal(isAcknowledgementForWrite(ack, 'PID_APPLIED trial-current', ackContext), true,
  'current unique ACK received before a later frontend receipt callback remains usable once written is known');
assert.equal(isAcknowledgementForWrite({ ...ack, id: 20 }, 'PID_APPLIED trial-current', ackContext), false,
  'a matching ACK already present at the dispatch watermark cannot confirm this attempt');
assert.equal(isAcknowledgementForWrite({ ...ack, at: 999 }, 'PID_APPLIED trial-current', ackContext), false,
  'a pre-dispatch receive timestamp cannot confirm this attempt');
assert.equal(isAcknowledgementForWrite({ ...ack, text: 'PID_APPLIED trial-previous' }, 'PID_APPLIED trial-current', ackContext), false,
  'a late ACK for an earlier protocol id cannot confirm the current attempt');
assert.equal(isAcknowledgementForWrite(ack, 'PID_APPLIED', ackContext), false, 'generic ACK text cannot bypass request identity');
for (const text of ['PID_APPLIED trial-current FAILED', 'ERROR PID_APPLIED trial-current', 'PID_APPLIED trial-current-extra']) {
  assert.equal(isAcknowledgementForWrite({ ...ack, text }, 'PID_APPLIED trial-current', ackContext), false,
    'a failure suffix, error prefix, or a different token cannot satisfy the configured complete success line');
}
assert.equal(isAcknowledgementForWrite({ ...ack, text: '  PID_APPLIED trial-current\r\n' }, '  PID_APPLIED trial-current ', ackContext), true,
  'only leading/trailing whitespace is ignored for complete-line matching');
assert.equal(isAcknowledgementForWrite({ ...ack, tag: '[TX]' }, 'PID_APPLIED trial-current', ackContext), false,
  'a displayed outgoing command cannot confirm device application');
for (const writeStatus of ['queued', 'failed'] as const) {
  assert.equal(isAcknowledgementForWrite(ack, 'PID_APPLIED trial-current', { ...ackContext, writeStatus }), false,
    'received ACK alone cannot bypass the independently required written receipt');
}
for (const mismatch of [{ currentSessionId: 'device-reconnected' }, { currentEpoch: 4 }, { sessionId: undefined }, { epoch: undefined }]) {
  assert.equal(isAcknowledgementForWrite(ack, 'PID_APPLIED trial-current', { ...ackContext, ...mismatch }), false,
    'a receipt outside the current session/epoch cannot confirm application');
}

const store = new ChannelStore(100);
store.initPresetChannels(2);
store.setAlias('kp-readback', '!0');
store.setSessionContext('device-current', 3);
let observed: ChannelViewBatch | null = null;
const unsubscribe = store.subscribe(['kp-readback'], (batch) => { observed = batch; }, { fps: 1000 });
const originalNow = Date.now;
try {
  Date.now = () => 1000;
  store.push('!0', 1, 2.3);
  const startRevision = store.getChannelRevision('kp-readback');
  const context: ParameterReadbackCorrelation = { ...identity, startedAt: 1000, channelGeneration: store.getGeneration(), startRevision };
  store.flushDispatch();
  const delayedOld = observed as ChannelViewBatch | null;
  assert.ok(delayedOld, 'the subscription receives the sample which was ingested before command dispatch');
  assert.equal(delayedOld.updatedRevisions['kp-readback'], startRevision);
  assert.equal(isFreshChannelValue({ value: 2.3, receivedAt: delayedOld.updatedAtMs['kp-readback'],
    revision: delayedOld.updatedRevisions['kp-readback'], generation: delayedOld.generation }, context), false,
  'same-millisecond old data and its delayed subscriber dispatch fail the ingestion watermark');

  store.push('!0', 1.01, 2.3);
  const current = { value: 2.3, receivedAt: 1000, revision: store.getChannelRevision('kp-readback'), generation: store.getGeneration() };
  assert.equal(current.revision, startRevision + 1);
  assert.equal(store.getChannelRevision('!0'), current.revision, 'canonical and alias names share one ingestion revision');
  assert.equal(store.getChannelRevision('!1'), 0, 'unrelated channels do not advance the parameter watermark');
  assert.equal(isFreshChannelValue(current, context), true,
    'new same-millisecond readback can precede the frontend receipt callback');
  for (const writeStatus of ['queued', 'failed'] as const) {
    assert.equal(isFreshChannelValue(current, { ...context, writeStatus }), false, 'readback cannot replace a written receipt');
  }
  assert.equal(isFreshChannelValue(current, { ...context, currentEpoch: 4 }), false, 'old-epoch parameter samples are rejected');
  assert.equal(isFreshChannelValue({ ...current, revision: NaN }, context), false, 'missing/invalid revision fails closed');
  assert.equal(isFreshChannelValue({ ...current, receivedAt: 999 }, context), false, 'pre-dispatch received data is rejected');
  store.clear();
  assert.equal(store.getChannelRevision('kp-readback'), 0, 'clear removes prior watermarks together with display generation');
  store.push('!0', 2, 2.3);
  assert.equal(isFreshChannelValue({ ...current, revision: store.getChannelRevision('kp-readback'), generation: store.getGeneration() }, context), false,
    'a new generation cannot reuse an old write watermark even when the revision number repeats');
} finally {
  Date.now = originalNow;
  unsubscribe();
}

console.log('✓ tuning write correlation: RX identity, receipt reordering, ingestion revisions, and stopped/failed write gates');
