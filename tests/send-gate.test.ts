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
}
