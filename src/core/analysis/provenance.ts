/**
 * 可序列化的分析来源。分析结果可以被保存、回放或交给 AI 时，
 * 不能只带一组没有上下文的数字。
 */
export type AnalysisSource = 'live' | 'replay' | 'simulation' | 'manual' | 'unknown';

export interface AnalysisContext {
  source?: AnalysisSource;
  sessionId?: string | null;
  epoch?: number | null;
  generation?: number | null;
  channelIds?: string[];
}

export interface AnalysisProvenance {
  source: AnalysisSource;
  sessionId?: string;
  epoch?: number;
  generation?: number;
  channelIds: string[];
  interval: {
    start: number | null;
    end: number | null;
  };
  sampleCount: number;
  algorithm: {
    id: string;
    version: string;
  };
  parameters: Record<string, unknown>;
}

export const ANALYSIS_ALGORITHM_VERSION = '2026-09-29.1';

export const ANALYSIS_ALGORITHMS = {
  fft: 'fft-spectrum',
  step: 'step-response',
  identify: 'plant-identification',
  simulation: 'closed-loop-simulation',
} as const;

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

export function makeAnalysisProvenance(
  context: AnalysisContext | undefined,
  algorithmId: string,
  parameters: Record<string, unknown>,
  timestamps: ArrayLike<number> | undefined,
  sampleCount: number,
): AnalysisProvenance {
  const count = Math.max(0, Math.floor(Number.isFinite(sampleCount) ? sampleCount : 0));
  const startIndex = timestamps && timestamps.length > count ? timestamps.length - count : 0;
  const start = timestamps && timestamps.length > 0 ? Number(timestamps[startIndex]) : undefined;
  const end = timestamps && timestamps.length > 0 ? Number(timestamps[timestamps.length - 1]) : undefined;
  const provenance: AnalysisProvenance = {
    source: context?.source ?? 'unknown',
    channelIds: [...new Set((context?.channelIds ?? []).map(String).filter(Boolean))],
    interval: {
      start: finiteOrNull(start),
      end: finiteOrNull(end),
    },
    sampleCount: count,
    algorithm: { id: algorithmId, version: ANALYSIS_ALGORITHM_VERSION },
    parameters,
  };
  if (context?.sessionId) provenance.sessionId = context.sessionId;
  if (context?.epoch !== undefined && context.epoch !== null) provenance.epoch = context.epoch;
  if (context?.generation !== undefined && context.generation !== null) provenance.generation = context.generation;
  return provenance;
}

export function attachAnalysisProvenance<T extends object>(
  value: T,
  provenance: AnalysisProvenance,
): T & { provenance: AnalysisProvenance } {
  return Object.assign(value, { provenance });
}
