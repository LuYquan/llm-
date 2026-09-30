import assert from 'node:assert/strict';
import { runWorkspaceTransaction } from '../src/services/workspace/transaction.ts';

export async function runWorkspaceTransactionTests(): Promise<void> {
  const state = { protocol: 'firewater', dashboard: 'before', model: 'before' };
  const snapshot = { ...state };
  const applied = await runWorkspaceTransaction(
    snapshot,
    async () => {
      state.protocol = 'justfloat';
      state.dashboard = 'after';
      throw new Error('simulated dashboard failure');
    },
    async (prior) => {
      Object.assign(state, prior);
    },
  );
  assert.equal(applied.ok, false);
  assert.equal(state.protocol, 'firewater');
  assert.equal(state.dashboard, 'before');
  assert.equal(state.model, 'before');

  const rollbackFailure = await runWorkspaceTransaction(
    { value: 1 },
    () => { throw new Error('apply failed'); },
    () => { throw new Error('rollback failed'); },
  );
  assert.equal(rollbackFailure.ok, false);
  if (!rollbackFailure.ok) assert.match(String(rollbackFailure.rollbackError), /rollback failed/);

  const completed = await runWorkspaceTransaction(
    { value: 1 },
    () => undefined,
    () => undefined,
  );
  assert.deepEqual(completed, { ok: true });
  console.log('工作区事务应用失败回滚与回滚失败披露测试通过。');
}
