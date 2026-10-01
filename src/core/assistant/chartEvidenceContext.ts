import type { ComputedRef, InjectionKey } from 'vue';

export interface ChartEvidenceContext {
  source: 'live' | 'demo' | 'unknown';
  timeSource: string;
  canReview: boolean;
  disabledReason: string;
}

export const CHART_EVIDENCE_CONTEXT: InjectionKey<ComputedRef<ChartEvidenceContext>> = Symbol('chart-evidence-context');

export const UNKNOWN_CHART_EVIDENCE_CONTEXT: ChartEvidenceContext = Object.freeze({
  source: 'unknown',
  timeSource: 'unknown',
  canReview: true,
  disabledReason: '',
});
