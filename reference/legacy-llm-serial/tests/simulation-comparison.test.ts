import assert from 'node:assert/strict';
import { comparableStepMetrics } from '../src/core/control/simulationComparison';
import type { StepResponseMetrics } from '../src/core/analysis/types';

const session = { sessionId: 'session-test', epoch: 2, generation: 3 };
const metrics: StepResponseMetrics = {
  rise_time_s: .1, settling_time_s: .4, overshoot_pct: 5, steady_state_error: .02,
  oscillation_freq_hz: null, damping_ratio: null, y0: 0, y_target: 10, y_ss: 9.98,
  y_max: 10.5, step_amplitude: 10, is_stable: true,
  provenance: { source: 'live', sessionId: session.sessionId, epoch: 2, generation: 3,
    channelIds: ['feedback'], interval: { start: 1, end: 2 }, sampleCount: 50,
    algorithm: { id: 'step-response', version: 'test' }, parameters: {} },
};
assert.equal(comparableStepMetrics(metrics, 'feedback', session), metrics);
assert.equal(comparableStepMetrics(metrics, 'unrelated', session), null);
assert.equal(comparableStepMetrics(metrics, null, session), null);
assert.equal(comparableStepMetrics({ ...metrics, provenance: undefined }, 'feedback', session), null);
assert.equal(comparableStepMetrics(metrics, 'feedback', { ...session, sessionId: 'reconnected' }), null);
assert.equal(comparableStepMetrics(metrics, 'feedback', { ...session, epoch: 3 }), null);
assert.equal(comparableStepMetrics(metrics, 'feedback', { ...session, generation: 4 }), null);
assert.equal(comparableStepMetrics({ ...metrics, provenance: { ...metrics.provenance!, source: 'simulation' } }, 'feedback', session), null);
assert.equal(comparableStepMetrics({ ...metrics, step_amplitude: 0 }, 'feedback', session), null);
console.log('仿真比较只接受已关联通道、会话、代次及有效实测指标。');
