import assert from 'node:assert/strict';
import {
  clearAnalysisHistory,
  loadAnalysisHistory,
  persistAnalysisProvenance,
} from '../src/services/analysis/analysis-history.ts';

export async function runAnalysisHistoryTests() {
  const previousStorage = (globalThis as any).localStorage;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });

  try {
    clearAnalysisHistory();
    values.set('llm_serial_analysis_history_v1', JSON.stringify([
      { algorithm: { id: 'malformed' }, recordedAtMs: Date.now() },
    ]));
    assert.deepEqual(loadAnalysisHistory(), [], '损坏或不完整的分析历史不能进入 UI');
    await persistAnalysisProvenance({
      source: 'replay',
      sessionId: 'recording-1',
      epoch: 3,
      generation: 8,
      channelIds: ['actual'],
      interval: { start: 1, end: 2 },
      sampleCount: 10,
      algorithm: { id: 'step-response', version: 'test' },
      parameters: { stepTime: 1.2 },
    });
    const history = loadAnalysisHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].sessionId, 'recording-1');
    assert.equal(history[0].algorithm.id, 'step-response');
    assert.equal(typeof history[0].recordedAtMs, 'number');
    clearAnalysisHistory();
    assert.deepEqual(loadAnalysisHistory(), []);
    console.log('  ✓ 分析 provenance 浏览器历史保存与清理通过');
  } finally {
    if (previousStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage });
    }
  }
}
