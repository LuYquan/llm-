import assert from 'node:assert/strict';
import { WriteQuiescenceTracker } from '../src/services/transport/write-quiescence.ts';
import { useSerialSession, resetSession } from '../src/services/transport/session.ts';
import { TransportFactory } from '../src/services/transport/factory.ts';
import type { ISerialTransport, TransportStatus, WriteReceipt, WriteResultEvent } from '../src/services/transport/types.ts';

const receipt = (request_id = 'fixture-tx-1', session_id = 'fixture-session', epoch = 2): WriteReceipt =>
  ({ request_id, session_id, epoch, byte_count: 3, status: 'queued' });
const result = (overrides: Partial<WriteResultEvent> = {}): WriteResultEvent => ({
  request_id: 'fixture-tx-1', session_id: 'fixture-session', epoch: 2, source: 'normal', status: 'written', requested_bytes: 3, written_bytes: 3, ...overrides,
});
const connected = () => { const tracker = new WriteQuiescenceTracker(); tracker.setConnected(true); return tracker; };

{
  const tracker = connected();
  const attempt = tracker.begin(3);
  assert.equal(tracker.snapshot().pendingCount, 1, 'an active driver invocation is pending before its queued receipt exists');
  assert.equal(tracker.snapshot().ready, false);
  assert.equal(tracker.acceptReceipt(attempt, receipt()), true);
  assert.equal(tracker.snapshot().pendingCount, 1, 'queued is not a writer drain');
  const waiting = tracker.wait(1000);
  tracker.acceptResult(result());
  assert.deepEqual(await waiting, { ready: true });
  assert.equal(tracker.snapshot().pendingCount, 0);
}
{
  const tracker = connected();
  const attempt = tracker.begin(3);
  tracker.acceptResult(result());
  assert.equal(tracker.snapshot().pendingCount, 1, 'an early final event cannot bypass its still-unidentified queued receipt');
  assert.equal(tracker.acceptReceipt(attempt, receipt()), true);
  assert.equal(tracker.snapshot().ready, true, 'early final event and later queued receipt reconcile by the full identity triple');
}
{
  const tracker = connected();
  const attempt = tracker.begin(3);
  tracker.acceptResult(result({ session_id: 'old-session' }));
  tracker.acceptResult(result({ epoch: 1 }));
  tracker.acceptReceipt(attempt, receipt());
  tracker.acceptResult(result({ request_id: 'other-request' }));
  tracker.acceptResult(result({ session_id: 'old-session' }));
  tracker.acceptResult(result({ epoch: 1 }));
  assert.equal(tracker.snapshot().pendingCount, 1, 'request id alone and old session/epoch events do not drain the queue');
  tracker.acceptResult(result());
  assert.equal(tracker.snapshot().ready, true);
}
for (const status of ['failed', 'canceled', 'superseded', 'acknowledged'] as const) {
  const tracker = connected();
  tracker.acceptReceipt(tracker.begin(3), receipt());
  tracker.acceptResult(result({ status, written_bytes: status === 'failed' ? 1 : 3 }));
  assert.equal(tracker.snapshot().pendingCount, 0);
  assert.equal(tracker.snapshot().ready, false, `${status} is a terminal event but not a successful complete driver write`);
  assert.ok((await tracker.wait(20)).reason);
  tracker.acceptResult(result());
  assert.equal(tracker.snapshot().ready, false, 'a late written callback cannot erase an uncertain device state');
  tracker.setConnected(false); tracker.setConnected(true);
  assert.equal(tracker.snapshot().ready, true, 'a deliberately fresh connection clears the old writer latch');
}
for (const invalid of [result({ requested_bytes: 2 }), result({ written_bytes: 2 })]) {
  const tracker = connected(); tracker.acceptReceipt(tracker.begin(3), receipt()); tracker.acceptResult(invalid);
  assert.equal(tracker.snapshot().ready, false, 'partial or mismatched byte evidence cannot prove queue quiescence');
}
{
  const tracker = connected();
  const attempt = tracker.begin(3);
  tracker.acceptResult(result({ written_bytes: 1 }));
  tracker.acceptResult(result());
  assert.equal(tracker.acceptReceipt(attempt, receipt()), false, 'an early partial-write event cannot be overwritten by a later contradictory written callback');
  assert.equal(tracker.snapshot().ready, false);
}
{
  const tracker = connected();
  tracker.acceptReceipt(tracker.begin(3), receipt());
  assert.equal((await tracker.wait(0)).ready, false);
  assert.equal(tracker.snapshot().pendingCount, 1, 'timeout retains the unknown request');
  tracker.acceptResult(result());
  assert.equal(tracker.snapshot().ready, false, 'timeout stays fail-closed even if the late driver event eventually drains');
}
{
  const tracker = connected(); tracker.observeIdentity('fixture-session', 2);
  const attempt = tracker.begin(3);
  const waiting = tracker.wait(1000);
  tracker.setConnected(false); tracker.setConnected(true);
  assert.equal(tracker.acceptReceipt(attempt, receipt()), false, 'an in-flight old connection cannot attach its receipt to a fresh connection');
  assert.equal((await waiting).ready, false, 'fresh ready state does not fulfill an old scope waiter');
  assert.equal(tracker.snapshot().ready, true, 'the old callback cannot latch an error on the fresh connection');
}
{
  const tracker = connected(); tracker.observeIdentity('fixture-session', 2);
  tracker.acceptReceipt(tracker.begin(3), receipt());
  const waiting = tracker.wait(1000);
  tracker.observeIdentity('fixture-session', 3);
  assert.equal((await waiting).ready, false);
  assert.equal(tracker.snapshot().ready, false, 'protocol/epoch change while a queued write is uncertain is blocked until reconnect');
}
{
  const tracker = connected();
  tracker.acceptReceipt(tracker.begin(3), { ...receipt(), status: 'written', byte_count: 2 });
  assert.equal(tracker.snapshot().ready, false);
}

{
  const tracker = connected();
  tracker.acceptReceipt(tracker.begin(3), receipt());
  const controllerA = new AbortController();
  const beforeCancel = tracker.snapshot();
  const oldWait = tracker.wait(1000, controllerA.signal);
  const newWait = tracker.wait(1000);
  controllerA.abort();
  const canceled = await oldWait;
  assert.equal(canceled.ready, false);
  assert.match(canceled.reason!, /取消等待/);
  assert.deepEqual(tracker.snapshot(), beforeCancel, 'canceling A changes no write identity, pending count, generation or error');
  tracker.acceptResult(result());
  assert.deepEqual(await newWait, { ready: true }, 'another waiter still observes the real final driver event');
}
{
  const tracker = connected();
  const attemptA = tracker.begin(3);
  const controllerA = new AbortController();
  const oldWait = tracker.wait(1000, controllerA.signal);
  controllerA.abort();
  const attemptB = tracker.begin(3);
  const beforeOldContinuation = tracker.snapshot();
  assert.equal((await oldWait).ready, false);
  assert.deepEqual(tracker.snapshot(), beforeOldContinuation, 'old canceled wait cannot clear inflight calls started before or after cancellation');
  tracker.acceptReceipt(attemptA, { ...receipt('tx-A'), status: 'written' });
  tracker.acceptReceipt(attemptB, receipt('tx-B'));
  assert.equal(tracker.snapshot().pendingCount, 1);
  assert.equal(tracker.snapshot().error, null);
  const waitB = tracker.wait(1000);
  tracker.acceptResult(result({ request_id: 'tx-B' }));
  assert.deepEqual(await waitB, { ready: true });
}
{
  const tracker = connected();
  tracker.acceptReceipt(tracker.begin(3), receipt());
  const controller = new AbortController(); controller.abort();
  const before = tracker.snapshot();
  assert.equal((await tracker.wait(0, controller.signal)).ready, false, 'preabort wins over a zero timeout');
  assert.deepEqual(tracker.snapshot(), before, 'preabort cannot latch timeout uncertainty');
  tracker.acceptResult(result());
  assert.equal((await tracker.wait(0, controller.signal)).ready, false, 'canceled scope cannot claim success even if the writer is now drained');
  assert.deepEqual(await tracker.wait(0), { ready: true });
}
{
  // Use a controlled clock, not wall-clock sleep: after A cancels, advance past
  // A's deadline while B has a new pending request in the same generation.
  const realNow = Date.now;
  let now = realNow();
  try {
    Date.now = () => now;
    const tracker = connected();
    tracker.acceptReceipt(tracker.begin(3), receipt('tx-A'));
    const controllerA = new AbortController();
    const oldWait = tracker.wait(10, controllerA.signal);
    controllerA.abort();
    tracker.acceptResult(result({ request_id: 'tx-A' }));
    tracker.acceptReceipt(tracker.begin(3), receipt('tx-B'));
    now += 20;
    assert.equal((await oldWait).ready, false);
    assert.equal(tracker.snapshot().pendingCount, 1);
    assert.equal(tracker.snapshot().error, null, 'canceled old deadline cannot latch a global error on the fresh experiment');
    const waitB = tracker.wait(1000);
    tracker.acceptResult(result({ request_id: 'tx-B' }));
    assert.deepEqual(await waitB, { ready: true });
  } finally { Date.now = realNow; }
}
{
  const tracker = connected();
  tracker.acceptReceipt(tracker.begin(3), receipt());
  const controller = new AbortController();
  const waiting = tracker.wait(1000, controller.signal);
  tracker.observeIdentity('fixture-session', 3);
  const beforeAbort = tracker.snapshot();
  controller.abort();
  assert.equal((await waiting).ready, false);
  assert.deepEqual(tracker.snapshot(), beforeAbort, 'abort preserves the actual uncertainty introduced by an epoch change');
  assert.ok(tracker.snapshot().error);
}

// Real session integration, using a driver double through the existing factory.
// This is a deterministic transport test, not native or hardware acceptance.
await resetSession();
const priorFactory = TransportFactory.create;
const statusListeners = new Set<(status: TransportStatus) => void>();
const resultListeners = new Set<(value: WriteResultEvent) => void>();
let connection = 0;
let requestSequence = 0;
let driverStatus: TransportStatus = 'idle';
let writeImpl = async (): Promise<WriteReceipt> => receipt(`fixture-tx-${++requestSequence}`, `fixture-session-${connection}`, connection);
let driverWriteCalls = 0;
let stopImpl = async (_bytes: Uint8Array): Promise<void> => {};
let resumeImpl = async (): Promise<void> => {};
const emitStatus = (value: TransportStatus) => { driverStatus = value; statusListeners.forEach(listener => listener(value)); };
const emitResult = (value: WriteResultEvent) => resultListeners.forEach(listener => listener(value));
const fake = {
  kind: 'tauri', capabilities: { canEnumerateAllPorts: false, requiresUserGestureToAddPort: false, globalEmergencyStop: false, fileSystemLogging: false },
  async connect() { connection += 1; emitStatus('connected'); }, async disconnect() { emitStatus('idle'); },
  async listPorts() { return []; }, async requestPort() { return { id: 'fixture', label: 'fixture' }; },
  async configureProtocol() {}, emergencyStop: (bytes: Uint8Array) => stopImpl(bytes), resumeWrites: () => resumeImpl(),
  write: () => { driverWriteCalls += 1; return writeImpl(); }, onBatch: () => () => {}, onError: () => () => {},
  onStatusChange(callback: (value: TransportStatus) => void) { statusListeners.add(callback); callback(driverStatus); return () => statusListeners.delete(callback); },
  onWriteResult(callback: (value: WriteResultEvent) => void) { resultListeners.add(callback); return () => resultListeners.delete(callback); },
  async dispose() { emitStatus('idle'); },
} as ISerialTransport;
try {
  TransportFactory.create = async () => fake;
  const session = useSerialSession();
  await session.connect('fixture', { baudRate: 115200 });
  assert.equal(session.writesReady.value, true);
  const queued = await session.write(new Uint8Array([1, 2, 3]));
  assert.equal(session.pendingWriteCount.value, 1);
  assert.equal(session.writesReady.value, false, 'the session does not advertise a native queued command as drained');
  const waiting = session.waitForWriteQuiescence(1000);
  emitResult(result({ request_id: queued.request_id, session_id: queued.session_id!, epoch: queued.epoch! }));
  assert.equal((await waiting).ready, true);
  assert.equal(session.pendingWriteCount.value, 0);

  const cancelQueued = await session.write(new Uint8Array([1, 2, 3]));
  const cancelController = new AbortController();
  const canceledSessionWait = session.waitForWriteQuiescence(1000, cancelController.signal);
  cancelController.abort();
  const freshSessionWait = session.waitForWriteQuiescence(1000);
  assert.equal((await canceledSessionWait).ready, false, 'the real session forwards the caller cancellation signal');
  assert.equal(session.pendingWriteCount.value, 1, 'canceling a session waiter does not cancel its queued driver command');
  assert.equal(session.writeQuiescenceError.value, null, 'caller cancellation does not latch global transport error');
  assert.equal(session.writesReady.value, false);
  emitResult(result({ request_id: cancelQueued.request_id, session_id: cancelQueued.session_id!, epoch: cancelQueued.epoch! }));
  assert.equal((await freshSessionWait).ready, true, 'the fresh session waiter is fulfilled by the real final receipt');
  assert.equal(session.pendingWriteCount.value, 0);

  writeImpl = async () => {
    const queued = receipt(`fixture-tx-${++requestSequence}`, `fixture-session-${connection}`, connection);
    emitResult(result({ request_id: queued.request_id, session_id: queued.session_id!, epoch: queued.epoch! }));
    return queued;
  };
  await session.write(new Uint8Array([1, 2, 3]));
  assert.equal(session.writesReady.value, true, 'real session reconciles event-before-invoke receipt ordering');

  writeImpl = async () => receipt(`fixture-tx-${++requestSequence}`, `fixture-session-${connection}`, connection);
  const unresolved = await session.write(new Uint8Array([1, 2, 3]));
  emitResult(result({ request_id: unresolved.request_id, session_id: unresolved.session_id!, epoch: unresolved.epoch! + 1 }));
  assert.equal(session.pendingWriteCount.value, 1);
  assert.equal((await session.waitForWriteQuiescence(0)).ready, false);
  assert.ok(session.writeQuiescenceError.value);
  const requestCountBeforeBlockedWrite = requestSequence;
  await assert.rejects(session.write(new Uint8Array([1, 2, 3])), /重新连接/);
  assert.equal(requestSequence, requestCountBeforeBlockedWrite, 'a latched unknown queue blocks ordinary sends before driver submission');
  emitResult(result({ request_id: unresolved.request_id, session_id: unresolved.session_id!, epoch: unresolved.epoch! }));
  assert.equal(session.writesReady.value, false);

  await session.disconnect(); await session.connect('fixture', { baudRate: 115200 });
  assert.equal(session.writesReady.value, true);
  let completeOld: ((value: WriteReceipt) => void) | undefined;
  const oldReceipt = receipt('fixture-old-inflight', `fixture-session-${connection}`, connection);
  writeImpl = () => new Promise(resolve => { completeOld = resolve; });
  const oldWrite = session.write(new Uint8Array([1, 2, 3]));
  const oldWriteOutcome = oldWrite.then(() => 'unexpected-success', () => 'scope-changed');
  await Promise.resolve();
  assert.equal(session.pendingWriteCount.value, 1, 'driver invocation is pending before its receipt');
  const oldWaiting = session.waitForWriteQuiescence(1000);
  await session.disconnect(); await session.connect('fixture', { baudRate: 115200 });
  completeOld!(oldReceipt);
  assert.equal(await oldWriteOutcome, 'scope-changed');
  assert.equal((await oldWaiting).ready, false);
  assert.equal(session.writesReady.value, true);

  // Local lock is immediate even if the native barrier fails. A write which had
  // already entered the driver is still recorded, not fictionally withdrawn.
  let finishInflight: ((value: WriteReceipt) => void) | undefined;
  const inflightReceipt = { ...receipt('fixture-stop-inflight', `fixture-session-${connection}`, connection), status: 'written' as const };
  writeImpl = () => new Promise(resolve => { finishInflight = resolve; });
  const inflight = session.write(new Uint8Array([1, 2, 3]));
  await Promise.resolve();
  assert.ok(finishInflight, 'ordinary write is already in the driver before stop');
  const beforeStopWrites = driverWriteCalls;
  let stopBytes: Uint8Array | null = null;
  stopImpl = async (bytes) => { stopBytes = new Uint8Array(bytes); throw new Error('synthetic native stop barrier failed'); };
  const stopOutcome = session.emergencyStop('CMD:STOP\\n');
  assert.equal(session.softwareStopLocked.value, true, 'new writes are locked at the call entry before any driver await');
  await assert.rejects(stopOutcome, /native stop barrier failed/);
  assert.deepEqual(Array.from(stopBytes!), Array.from(new TextEncoder().encode('CMD:STOP\n')), 'attempted stop bytes really entered the mock driver');
  assert.equal(session.pendingWriteCount.value, 1, 'failed native stop does not pretend the prior in-flight write was canceled');
  await assert.rejects(session.write(new Uint8Array([4, 5, 6])), /软件停止/);
  assert.equal(driverWriteCalls, beforeStopWrites, 'no new ordinary driver invocation follows a failed stop');
  finishInflight!(inflightReceipt);
  assert.deepEqual(await inflight, inflightReceipt, 'the already-started driver write retains its real written receipt');
  assert.equal(session.pendingWriteCount.value, 0);
  assert.equal(session.writesReady.value, false, 'writer completion cannot clear the local stop latch');

  const priorWindow = (globalThis as any).window;
  try {
    (globalThis as any).window = { __TAURI_INTERNALS__: { invoke: async () => false } };
    assert.equal(await session.refreshWriteLockStatus(), true, 'a false native lock query cannot silently undo the renderer stop latch');
  } finally {
    if (priorWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = priorWindow;
  }
  resumeImpl = async () => { throw new Error('synthetic resume failed'); };
  await assert.rejects(session.resumeWrites(), /resume failed/);
  assert.equal(session.softwareStopLocked.value, true, 'failed explicit resume keeps the local lock');
  resumeImpl = async () => {};
  await session.resumeWrites();
  assert.equal(session.softwareStopLocked.value, false, 'successful explicit resume is the only unlock');

  // A successful old native resume is not authorization to clear a newer stop.
  stopImpl = async () => {};
  await session.emergencyStop('CMD:STOP');
  let finishOldResume: (() => void) | undefined;
  let oldDriverResumeCompleted = false;
  resumeImpl = () => new Promise<void>(resolve => {
    finishOldResume = () => { oldDriverResumeCompleted = true; resolve(); };
  });
  const oldResume = session.resumeWrites();
  const oldResumeOutcome = assert.rejects(oldResume, /驱动可能已恢复/);
  await Promise.resolve();
  assert.ok(finishOldResume, 'the older explicit resume is already waiting in the mock driver');
  await session.emergencyStop('CMD:SECOND_STOP');
  assert.equal(session.softwareStopLocked.value, true, 'the newer stop establishes its own local lock');
  finishOldResume!();
  await oldResumeOutcome;
  assert.equal(oldDriverResumeCompleted, true, 'the old native resume did actually finish; native lock state is not invented');
  assert.equal(session.softwareStopLocked.value, true, 'the old successful resume receipt cannot clear the newer stop');
  const writesAfterSecondStop = driverWriteCalls;
  await assert.rejects(session.write(new Uint8Array([7, 8, 9])), /软件停止/);
  assert.equal(driverWriteCalls, writesAfterSecondStop, 'the stale resume cannot admit a new ordinary driver write');
  resumeImpl = async () => {};
  await session.resumeWrites();
  assert.equal(session.softwareStopLocked.value, false, 'a fresh explicit resume for the current stop may unlock');

  const priorEncoder = globalThis.TextEncoder;
  let unexpectedStops = 0;
  stopImpl = async () => { unexpectedStops += 1; };
  try {
    globalThis.TextEncoder = class { encode() { throw new Error('synthetic stop encoding failed'); } } as unknown as typeof TextEncoder;
    await assert.rejects(session.emergencyStop('CMD:STOP'), /encoding failed/);
    assert.equal(session.softwareStopLocked.value, true, 'stop encoding failure also preserves the entry lock');
    assert.equal(unexpectedStops, 0, 'invalid/failed encoding sends no stop bytes to the driver');
  } finally { globalThis.TextEncoder = priorEncoder; }
  await session.resumeWrites();

  await resetSession();
  let initializations = 0;
  TransportFactory.create = async () => { initializations += 1; throw new Error('synthetic transport initialization failed'); };
  const failedInit = session.emergencyStop('CMD:STOP');
  assert.equal(session.softwareStopLocked.value, true, 'entry lock precedes transport initialization');
  await assert.rejects(failedInit, /initialization failed/);
  await assert.rejects(session.write(new Uint8Array([4, 5, 6])), /软件停止/);
  assert.equal(initializations, 1, 'a new ordinary call cannot restart driver initialization through the stop latch');
  await resetSession();
  TransportFactory.create = async () => fake;
  await session.resumeWrites();
  assert.equal(session.softwareStopLocked.value, false);
} finally {
  await resetSession();
  TransportFactory.create = priorFactory;
}

console.log('✓ write quiescence: real session queued/inflight tracking, waiter-only cancellation, receipt ordering, full identities, timeouts, failures, and scope changes');
