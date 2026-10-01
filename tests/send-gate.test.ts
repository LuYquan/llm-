import assert from 'node:assert/strict';
import { SendGate } from '../src/core/widget/sendGate.ts';
import type { BaseWidgetConfig } from '../src/types/widget.ts';

const config = {
  id: 'test-button',
  type: 'button',
  title: 'test',
  command_template: 'CMD:{val}',
  encoding: 'text',
  order: 0,
  button_text: 'Send',
  is_danger: false,
} as BaseWidgetConfig;

function heldSenderGate() {
  const gate = new SendGate(0);
  gate.setPortConnected(true);
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const payloads: string[] = [];
  gate.setSender(payload => {
    payloads.push(payload);
    return payloads.length === 1 ? held : Promise.resolve();
  });
  return { gate, finish, payloads };
}

export async function runSendGateTests() {
  console.log('  测试控件发送必须有发送器且替代命令不能报告成功');

  const missingSender = new SendGate(0);
  missingSender.setPortConnected(true);
  const missingResult = await missingSender.dispatch(config, '1');
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.reason, 'io_error');

  const gate = new SendGate(0);
  gate.setPortConnected(true);
  let releaseFirstWrite: (() => void) | undefined;
  let holdFirstWrite = true;
  gate.setSender(() => {
    if (!holdFirstWrite) return Promise.resolve();
    holdFirstWrite = false;
    return new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  });

  const first = gate.dispatch(config, '1');
  await Promise.resolve();
  const superseded = gate.dispatch(config, '2');
  const newest = gate.dispatch(config, '3');
  const supersededResult = await superseded;
  assert.equal(supersededResult.ok, false);
  assert.equal(supersededResult.reason, 'superseded');

  assert.ok(releaseFirstWrite, 'the first write should already be in flight');
  releaseFirstWrite();
  assert.equal((await first).ok, true);
  assert.equal((await newest).ok, true);

  console.log('  测试实验 owner 同步占锁、取消、有界等待及旧回调隔离');
  {
    const { gate, finish, payloads } = heldSenderGate();
    const ordinary = gate.dispatch(config, 'held');
    const queued = gate.dispatch(config, 'queued');
    let acquisitionSettled = false;
    const acquisition = gate.acquireExperimentLock('experiment-A').then(value => {
      acquisitionSettled = true;
      return value;
    });
    assert.equal((await queued).reason, 'disabled', 'acquire cancels unsent ordinary commands immediately');
    assert.equal(acquisitionSettled, false, 'a started ordinary write must complete before acquisition succeeds');
    assert.equal((await gate.dispatch(config, 'blocked')).reason, 'disabled', 'the lock is owned before acquire returns');
    assert.equal(await gate.acquireExperimentLock('experiment-B'), false, 'another active owner cannot replace A');
    assert.equal(await gate.acquireExperimentLock('experiment-A'), false, 'duplicate acquisitions cannot share cancellation ownership');
    assert.equal(gate.releaseExperimentLock('experiment-B'), false);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    assert.equal(await gate.acquireExperimentLock('experiment-B', alreadyAborted.signal), false);
    assert.equal((await gate.dispatch(config, 'still-blocked')).reason, 'disabled', 'wrong-owner release/preabort preserves A');
    assert.deepEqual(payloads, ['CMD:held'], 'canceled and blocked commands never reached the sender');
    finish();
    assert.equal((await ordinary).ok, true);
    assert.equal(await acquisition, true);
    assert.equal((await gate.dispatch(config, 'blocked-after-drain')).reason, 'disabled');
    assert.equal(gate.releaseExperimentLock('experiment-A'), true);
    assert.equal(gate.releaseExperimentLock('experiment-A'), false);
    assert.equal((await gate.dispatch(config, 'after-release')).ok, true);
  }
  {
    const { gate, finish, payloads } = heldSenderGate();
    const ordinary = gate.dispatch(config, 'held');
    const controllerA = new AbortController();
    const oldAcquire = gate.acquireExperimentLock('experiment-A', controllerA.signal);
    controllerA.abort();
    // B enters before A's promise continuation runs; the actual sender is held.
    let newSettled = false;
    const newAcquire = gate.acquireExperimentLock('experiment-B').then(value => { newSettled = true; return value; });
    assert.equal(await oldAcquire, false);
    assert.equal(newSettled, false, 'canceling A cannot invent completion of B or the ordinary write');
    assert.equal(gate.releaseExperimentLock('experiment-A'), false, 'stale A cannot release the new owner');
    assert.equal((await gate.dispatch(config, 'blocked')).reason, 'disabled');
    assert.deepEqual(payloads, ['CMD:held'], 'abort did not withdraw or repeat the started sender call');
    finish();
    assert.equal((await ordinary).ok, true, 'the real write still produces its own result');
    assert.equal(await newAcquire, true);
    assert.equal(gate.releaseExperimentLock('experiment-B'), true);
  }
  {
    const { gate, finish } = heldSenderGate();
    const ordinary = gate.dispatch(config, 'held');
    const oldController = new AbortController();
    const oldAcquire = gate.acquireExperimentLock('reused-owner', oldController.signal);
    assert.equal(gate.releaseExperimentLock('reused-owner'), true);
    const newAcquire = gate.acquireExperimentLock('reused-owner');
    oldController.abort();
    assert.equal(await oldAcquire, false, 'release invalidates an unfinished old acquisition');
    assert.equal((await gate.dispatch(config, 'blocked')).reason, 'disabled', 'old cancellation cannot clear a new acquisition with a reused ID');
    finish();
    await ordinary;
    assert.equal(await newAcquire, true);
    assert.equal(gate.releaseExperimentLock('reused-owner'), true);
  }
  {
    const { gate, finish, payloads } = heldSenderGate();
    const ordinary = gate.dispatch(config, 'held');
    assert.equal(await gate.acquireExperimentLock('timed-out-A', undefined, 0), false, 'an unfinished acquisition has a bounded timeout');
    const freshAcquire = gate.acquireExperimentLock('experiment-B');
    assert.equal(gate.releaseExperimentLock('timed-out-A'), false);
    assert.equal((await gate.dispatch(config, 'blocked')).reason, 'disabled', 'timeout cleanup belongs only to its own acquisition');
    assert.deepEqual(payloads, ['CMD:held']);
    finish();
    assert.equal((await ordinary).ok, true, 'timeout does not cancel a real sender invocation');
    assert.equal(await freshAcquire, true);
    assert.equal(gate.releaseExperimentLock('experiment-B'), true);
  }
  {
    const { gate, finish, payloads } = heldSenderGate();
    const ordinary = gate.dispatch(config, 'held');
    const queued = gate.dispatch(config, 'queued');
    const controller = new AbortController(); controller.abort();
    assert.equal(await gate.acquireExperimentLock('preaborted', controller.signal, 0), false);
    assert.equal(await gate.acquireExperimentLock('   '), false);
    finish();
    assert.equal((await ordinary).ok, true);
    assert.equal((await queued).ok, true, 'preaborted/invalid acquisition does not cancel the normal queue');
    assert.deepEqual(payloads, ['CMD:held', 'CMD:queued']);
    assert.equal(await gate.acquireExperimentLock('ready', undefined, 0), true, 'an already drained gate needs no wait');
    assert.equal(gate.releaseExperimentLock('ready'), true);
  }
}
