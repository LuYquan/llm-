import type { StepResponseMetrics } from '../analysis/types';

export interface ComparisonSession {
  generation: number;
  sessionId: string | null;
  epoch: number | null;
}

/** A comparison must refer to the selected channel and the current recording context. */
export function comparableStepMetrics(
  metrics: StepResponseMetrics | null | undefined,
  channelId: string | null | undefined,
  session: ComparisonSession,
): StepResponseMetrics | null {
  const provenance = metrics?.provenance;
  if (!metrics || !channelId || !provenance || !['live', 'replay'].includes(provenance.source)) return null;
  if (!session.sessionId || provenance.sessionId !== session.sessionId || provenance.epoch !== session.epoch) return null;
  if (provenance.generation !== session.generation || !provenance.channelIds.includes(channelId)) return null;
  const { start, end } = provenance.interval;
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (!Number.isFinite(metrics.step_amplitude) || metrics.step_amplitude <= 0) return null;
  if (![metrics.overshoot_pct, metrics.steady_state_error].every(Number.isFinite)) return null;
  return metrics;
}
