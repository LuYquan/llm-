import assert from 'node:assert/strict';
import { TuningExecutionLease, type ExecutionLeaseState } from '../src/core/tuning/execution-lease';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  let context = 'connection-1';
  const acquisitions: Array<{ owner: string; signal: AbortSignal; wait: ReturnType<typeof deferred<boolean>> }> = [];
  const drains: Array<{ signal: AbortSignal; wait: ReturnType<typeof deferred<{ ready: boolean; reason?: string }>> }> = [];
  const states: Array<ExecutionLeaseState | null> = [];
  const failures: string[] = [];
  const releases: string[] = [];
  const lease = new TuningExecutionLease({
    context: () => context,
    acquire: (owner, signal) => {
      const wait = deferred<boolean>(); acquisitions.push({ owner, signal, wait }); return wait.promise;
    },
    drain: (signal) => {
      const wait = deferred<{ ready: boolean; reason?: string }>(); drains.push({ signal, wait }); return wait.promise;
    },
    release: owner => releases.push(owner), changed: state => states.push(state), failed: reason => failures.push(reason),
  });
  return { lease, acquisitions, drains, states, failures, releases, changeContext: () => { context = 'connection-2'; } };
}

// Actual coordinator callbacks are controlled; no copied App implementation.
{
  const f = fixture();
  const a = f.lease.start('A');
  assert.equal(f.lease.start('A'), a, 'duplicate start shares one acquire');
  assert.equal(await f.lease.start('concurrent'), false);
  await tick(); assert.equal(f.acquisitions.length, 1);
  f.acquisitions[0].wait.resolve(true); await tick();
  assert.equal(f.drains.length, 1);
  assert.equal(f.lease.finish('A'), true);
  assert.equal(f.drains[0].signal.aborted, true, 'stop cancels the old drain waiter');
  const b = f.lease.start('B'); await tick();
  f.drains[0].wait.resolve({ ready: true });
  assert.equal(await a, false, 'old successful drain cannot authorize B');
  assert.equal(f.lease.hasWriteAccess('B'), false);
  assert.equal(f.lease.finish('A'), false, 'old finally cannot release B');
  assert.deepEqual(f.releases, ['A']);
  f.acquisitions[1].wait.resolve(true); await tick();
  f.drains[1].wait.resolve({ ready: true }); assert.equal(await b, true);
  assert.equal(f.lease.hasWriteAccess('A'), false);
  assert.equal(f.lease.hasWriteAccess('B'), true);
  assert.equal(f.lease.cancel(), true);
  assert.equal(await f.lease.start('A'), false, 'retired ID replay grants no access');
  assert.deepEqual(f.releases, ['A', 'B']);
}
for (const lateOutcome of ['failure', 'throw'] as const) {
  const f = fixture(); const a = f.lease.start('A'); await tick();
  f.acquisitions[0].wait.resolve(true); await tick();
  f.lease.finish('A'); const b = f.lease.start('B'); await tick();
  if (lateOutcome === 'throw') f.drains[0].wait.reject(new Error('old timeout'));
  else f.drains[0].wait.resolve({ ready: false, reason: 'old timeout' });
  assert.equal(await a, false);
  assert.deepEqual(f.failures, [], 'old failure cannot request a stop against B');
  assert.equal(f.lease.owns('B'), true);
  f.lease.cancel(); f.acquisitions[1].wait.resolve(true); assert.equal(await b, false);
}
{
  const f = fixture(); const a = f.lease.start('A'); await tick();
  f.lease.finish('A'); const b = f.lease.start('B'); await tick();
  f.acquisitions[0].wait.resolve(true); assert.equal(await a, false);
  assert.equal(f.drains.length, 0, 'old acquire completion never starts a drain against the new attempt');
  f.acquisitions[1].wait.resolve(false); assert.equal(await b, false);
  assert.equal(f.failures.length, 1); assert.deepEqual(f.releases, ['A', 'B']);
}
{
  const f = fixture(); const a = f.lease.start('A'); await tick();
  f.acquisitions[0].wait.resolve(true); await tick();
  f.changeContext();
  f.drains[0].wait.resolve({ ready: true }); assert.equal(await a, false);
  assert.equal(f.lease.hasWriteAccess('A'), false); assert.equal(f.failures.length, 1);
  assert.deepEqual(f.releases, ['A']);
}
{
  const f = fixture(); const a = f.lease.start('A'); await tick();
  f.acquisitions[0].wait.resolve(true); await tick(); f.drains[0].wait.resolve({ ready: true });
  assert.equal(await a, true); f.changeContext();
  assert.equal(f.lease.hasWriteAccess('A'), false, 'dispatch rechecks a once-ready context');
  assert.equal(f.lease.cancelChangedContext(), true); assert.deepEqual(f.releases, ['A']);
}
console.log('Execution lease: late acquire/drain/failure/finally, cancellation, replay and context checks passed.');
