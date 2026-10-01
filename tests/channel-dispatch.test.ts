import assert from 'node:assert/strict';
import { ChannelStore } from '../src/core/channel/ChannelStore.ts';
import { isFreshChannelValue } from '../src/core/tuning/write-correlation.ts';

/** Deterministic races against the real store, including callbacks already queued at cancellation. */
export function runChannelDispatchTests() {
  const names = ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const realNow = Date.now;
  let assertions = 0;
  function scenario(check: (clock: ReturnType<typeof fakeClock>) => void) {
    const clock = fakeClock();
    try { check(clock); assertions++; }
    finally {
      names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
      Date.now = realNow;
    }
  }
  function fakeClock() {
    let now = 10_000;
    let nextTimer = 0;
    let nextFrame = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const frames = new Map<number, () => void>();
    const oldTimers = new Map<number, () => void>();
    const oldFrames = new Map<number, () => void>();
    const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    install('setTimeout', (callback: () => void, delay = 0) => { const id = nextTimer++; timers.set(id, { at: now + delay, callback }); oldTimers.set(id, callback); return id; });
    install('clearTimeout', (id: number) => timers.delete(id));
    install('requestAnimationFrame', (callback: () => void) => { const id = nextFrame++; frames.set(id, callback); oldFrames.set(id, callback); return id; });
    install('cancelAnimationFrame', (id: number) => frames.delete(id));
    Date.now = () => now;
    return {
      timers, frames, oldTimers, oldFrames,
      get now() { return now; },
      frame(id = frames.keys().next().value!) { const callback = frames.get(id); assert.ok(callback); frames.delete(id); callback(); },
      advance(ms: number) {
        const end = now + ms;
        for (let iterations = 0; ; iterations++) {
          assert.ok(iterations < 10_000, 'dispatch must not spin');
          const next = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          now = next[1].at; timers.delete(next[0]); next[1].callback();
        }
        now = end;
      },
    };
  }

  scenario((clock) => {
    const store = new ChannelStore(8);
    const channels = store.listChannels();
    assert.equal(store.observeLatest('missing'), undefined);
    assert.deepEqual(store.listChannels(), channels, 'observation must not create a buffer');
    store.push('0', 1, 11); store.setAlias('speed', '0');
    const first = store.observeLatest('speed')!;
    assert.deepEqual(first, { point: { t: 1, v: 11 }, updatedAtMs: 10_000, revision: 1, generation: 0 });
    first.point.v = 99;
    clock.advance(600);
    assert.equal(store.observeLatest('0')!.point.v, 11, 'observation must be detached');
    assert.equal(store.observeLatest('0')!.updatedAtMs, 10_000, 'a read must not refresh the ingestion time');
    store.push('0', 2, NaN); assert.equal(store.observeLatest('0'), undefined);
    store.push('0', Infinity, 11); assert.equal(store.observeLatest('0'), undefined);
    store.push('other', 1, 2); store.clear('0');
    assert.equal(store.observeLatest('0'), undefined);
    assert.equal(store.observeLatest('other')!.generation, 0, 'partial clear must not rebrand retained data');
    assert.equal(store.getGeneration(), 1);
    store.push('other', 2, 3); assert.equal(store.observeLatest('other')!.generation, 1);
    store.clear(); assert.equal(store.observeLatest('other'), undefined);
    assert.equal(store.getChannelRevision('other'), 0);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const values: number[] = [];
    const stop = store.subscribe(['x'], (batch) => values.push(batch.latest.x!.v), { fps: 10 });
    store.push('x', 1, 11); assert.equal(clock.frames.size, 1); assert.equal(clock.timers.size, 1);
    clock.advance(16); assert.deepEqual(values, [11], 'withheld rAF must not block notifications');
    assert.equal(clock.frames.size, 0, 'timer winner cancels rAF handle zero');
    store.push('x', 2, 22);
    clock.oldFrames.get(0)!();
    assert.equal(clock.frames.size, 1, 'queued stale frame must not clear the new ticket');
    clock.advance(100); assert.deepEqual(values, [11, 22]);
    stop(); assert.equal(clock.frames.size + clock.timers.size, 0);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const values: number[] = [];
    store.subscribe(['x'], (batch) => values.push(batch.latest.x!.v), { fps: 1000 });
    store.push('x', 1, 11); clock.frame(0);
    assert.equal(clock.timers.size, 0, 'frame winner cancels timer handle zero');
    store.push('x', 2, 22); clock.oldTimers.get(0)!();
    assert.equal(clock.frames.size, 1, 'queued stale timer must not clear the new frame');
    clock.advance(16); assert.deepEqual(values, [11, 22]);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const values: number[] = [];
    store.subscribe(['x'], (batch) => values.push(batch.latest.x!.v), { fps: 1000 });
    store.push('x', 1, 11); store.flushDispatch();
    assert.equal(clock.timers.size + clock.frames.size, 0, 'explicit flush cancels both scheduled callbacks');
    store.push('x', 2, 22); store.clear(); store.push('x', 3, 33);
    clock.oldFrames.get(1)!(); clock.oldTimers.get(1)!();
    assert.equal(clock.frames.size, 1);
    clock.advance(16); assert.deepEqual(values, [11, 33]);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const values: number[] = [];
    store.subscribe(['x'], (batch) => {
      values.push(batch.latest.x!.v);
      if (values.length === 1) { store.push('x', 2, 22); store.flushDispatch(); }
    }, { fps: 1000 });
    store.push('x', 1, 11); clock.frame();
    assert.deepEqual(values, [11], 'reentrant flush must not emit the same dirty batch');
    clock.advance(16); assert.deepEqual(values, [11, 22], 'callback ingestion must survive the first dispatch');
  });

  scenario((clock) => {
    const store = new ChannelStore(); const first: number[] = []; const second: number[] = [];
    let cleared = false;
    store.subscribe(['x'], (batch) => { first.push(batch.latest.x!.v); if (!cleared) { cleared = true; store.clear(); store.push('x', 2, 22); } }, { fps: 1000 });
    store.subscribe(['x'], (batch) => second.push(batch.latest.x!.v), { fps: 1000 });
    store.push('x', 1, 11); clock.frame();
    assert.deepEqual(second, [], 'generation change aborts delivery of the old batch');
    clock.advance(16); assert.deepEqual(first, [11, 22]); assert.deepEqual(second, [22]);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const received: string[] = [];
    let added = false; let stopSecond = () => {};
    store.subscribe(['x'], () => { received.push('first'); stopSecond(); if (!added) { added = true; store.subscribe(['x'], () => received.push('new'), { fps: 1000 }); } }, { fps: 1000 });
    stopSecond = store.subscribe(['x'], () => received.push('removed'), { fps: 1000 });
    store.push('x', 1, 11); clock.frame(); assert.deepEqual(received, ['first']);
    clock.advance(20); store.push('x', 2, 22); clock.frame(); assert.deepEqual(received, ['first', 'first', 'new']);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const values: string[] = [];
    const realError = console.error; const errors: unknown[][] = [];
    console.error = (...args) => errors.push(args);
    try {
      store.subscribe(['x'], () => { throw new Error('expected fixture callback failure'); });
      store.subscribe(['x'], () => values.push('delivered'));
      store.push('x', 1, 11); clock.frame();
      assert.equal(errors.length, 1); assert.deepEqual(values, ['delivered']);
      assert.equal(clock.timers.size + clock.frames.size, 0);
    } finally { console.error = realError; }
  });

  scenario((clock) => {
    const store = new ChannelStore(); const fast: number[] = []; const slow: number[] = [];
    store.subscribe(['x'], (batch) => slow.push(batch.latest.x!.v), { fps: 1 });
    store.subscribe(['x'], (batch) => fast.push(batch.latest.x!.v), { fps: 10 });
    store.push('x', 1, 11); clock.frame();
    clock.advance(20); store.push('x', 2, 22); clock.frame();
    assert.equal([...clock.timers.values()][0].at, 10_100, 'choose the earliest subscriber deadline');
    clock.advance(80); assert.deepEqual(fast, [11, 22]); assert.deepEqual(slow, [11]);
    assert.equal([...clock.timers.values()][0].at, 11_000, 'do not poll a throttled subscriber every frame');
    clock.advance(900); assert.deepEqual(slow, [11, 22]);
  });

  scenario((clock) => {
    const store = new ChannelStore(); store.setSessionContext('fixture-session', 1);
    store.push('kp', 1, 2);
    const startedAt = clock.now; const startRevision = store.getChannelRevision('kp');
    const correlation = { startedAt, startRevision, channelGeneration: store.getGeneration(), writeStatus: 'written' as const, sessionId: 'fixture-session', epoch: 1, currentSessionId: 'fixture-session', currentEpoch: 1 };
    const convert = () => { const observation = store.observeLatest('kp')!; return { value: observation.point.v, receivedAt: observation.updatedAtMs, revision: observation.revision, generation: observation.generation }; };
    assert.equal(isFreshChannelValue(convert(), correlation), false, 'same-millisecond prewrite data must remain stale');
    store.push('kp', 2, 3);
    assert.equal(isFreshChannelValue(convert(), correlation), true, 'new ingestion can confirm without a subscriber dispatch');
    assert.equal(isFreshChannelValue(convert(), { ...correlation, writeStatus: 'failed' }), false);
    assert.equal(isFreshChannelValue(convert(), { ...correlation, currentEpoch: 2 }), false);
    store.clear('other'); assert.equal(isFreshChannelValue(convert(), { ...correlation, channelGeneration: store.getGeneration() }), false);
  });

  scenario((clock) => {
    const store = new ChannelStore(); const batches: Array<{ generation: number; ingested: number }> = [];
    store.setAlias('speed', 'x');
    store.subscribe(['speed'], (batch) => batches.push({ generation: batch.generation, ingested: batch.updatedGenerations.speed }), { fps: 1000 });
    store.push('x', 1, 11); store.clear('other'); clock.frame();
    assert.deepEqual(batches, [{ generation: 1, ingested: 0 }], 'partial clear must expose retained point identity separately from the batch generation');
    clock.advance(20); store.push('x', 2, 22); clock.frame();
    assert.deepEqual(batches[1], { generation: 1, ingested: 1 });
  });

  scenario((clock) => {
    const store = new ChannelStore(); const values: number[] = [];
    const stop = store.subscribe(['x'], (batch) => values.push(batch.latest.x!.v));
    store.push('x', 1, 11); stop();
    clock.oldFrames.get(0)!(); clock.oldTimers.get(0)!();
    assert.deepEqual(values, [], 'unsubscribed pending delivery stays cancelled');
    assert.equal(clock.timers.size + clock.frames.size, 0);
    store.subscribe(['x'], (batch) => values.push(batch.latest.x!.v));
    clock.advance(16); assert.deepEqual(values, [11], 'a later subscription can receive retained dirty data naturally');
  });

  console.log(`  ✓ [ChannelStore dispatch] ${assertions} deterministic scenarios: raw identity, rAF/timer races, lifecycle, reentrancy and deadlines`);
}
