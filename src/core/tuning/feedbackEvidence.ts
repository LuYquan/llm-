import type { PidValues } from '../project/types';
import type { TuningMetrics, TuningPlan, TuningSession, TuningTrial } from './types';

/** Current-page user attestation boundary. Never restore it from localStorage. */
export interface BaselineObservationBoundary {
  confirmedAt: number;
  fromTelemetryTimestamp: number;
  generation: number;
  sessionId: string;
  epoch: number;
  params: PidValues;
  configurationSignature: string;
}

/** Capture only after a complete window passes the current confirmation guard. */
export interface EvaluatedTrialContext {
  trialId: string;
  configurationSignature: string;
  generation: number;
  sessionId: string;
  epoch: number;
  params: PidValues;
  windowStart: number;
  windowEnd: number;
  confirmedAt: number;
  metrics: TuningMetrics;
}

/** Bounded provenance accompanying the exact metrics sent to a candidate tool. */
export interface TelemetryEvidence {
  source: 'evaluated-trial' | 'baseline-window';
  configurationSignature: string;
  generation: number;
  sessionId: string;
  epoch: number;
  params: PidValues;
  /** Telemetry clock, distinct from wall-clock confirmation time. */
  windowStart: number;
  windowEnd: number;
  trialId?: string;
  baselineConfirmedAt?: number;
  /** The UI fills this after reading the bounded baseline window. */
  sampleCount?: number;
}

export interface FeedbackEvidenceInput {
  plan: Pick<TuningPlan, 'baseline' | 'evaluationWindowSeconds'>;
  currentConfigurationSignature: string;
  generation: number;
  sessionContext: { sessionId: string | null; epoch: number | null };
  now: number;
  currentTelemetryTimestamp: number;
  lastConfirmed: TuningSession['lastConfirmed'];
  trials: readonly TuningTrial[];
  /** Volatile evidence Map. Saved evaluated trials alone grant no authority. */
  trialContexts: ReadonlyMap<string, EvaluatedTrialContext>;
  baselineBoundary: BaselineObservationBoundary | null;
}

export type FeedbackEvidenceSelection =
  | { status: 'ready'; source: 'evaluated-trial'; metrics: TuningMetrics; evidence: TelemetryEvidence }
  | { status: 'ready'; source: 'baseline-window'; afterTimestamp: number; throughTimestamp: number; evidence: TelemetryEvidence }
  | { status: 'pending'; reason: string };

const PARAM_KEYS = ['kp', 'ki', 'kd'] as const;
const METRIC_KEYS = ['steadyError', 'peakError', 'rmsTrackingError', 'overshootPercent', 'maximumOutputMagnitude', 'sampleCount'] as const;
const MAX_SIGNATURE_LENGTH = 262_144;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && Boolean(value.trim());
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identityNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validParams = (value: unknown): value is PidValues => record(value) && Object.keys(value).length === PARAM_KEYS.length
  && PARAM_KEYS.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
const sameParams = (first: unknown, second: unknown): boolean => validParams(first) && validParams(second)
  && PARAM_KEYS.every(key => first[key] === second[key]);
const validMetrics = (value: unknown): value is TuningMetrics => record(value) && Object.keys(value).length === METRIC_KEYS.length
  && METRIC_KEYS.every(key => key === 'overshootPercent' && value[key] === null
    || typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)
  && Number.isSafeInteger(value.sampleCount) && (value.sampleCount as number) >= 10;
const sameMetrics = (first: unknown, second: unknown): boolean => validMetrics(first) && validMetrics(second)
  && METRIC_KEYS.every(key => first[key] === second[key]);

/** Format check only; the service must also compare params and sampleCount. */
export function validTelemetryEvidenceShape(value: unknown): value is TelemetryEvidence {
  if (!record(value) || Object.keys(value).some(key => ![
    'source', 'configurationSignature', 'generation', 'sessionId', 'epoch', 'params', 'windowStart', 'windowEnd', 'trialId', 'baselineConfirmedAt', 'sampleCount',
  ].includes(key)) || !['evaluated-trial', 'baseline-window'].includes(value.source as string)
    || !text(value.configurationSignature, MAX_SIGNATURE_LENGTH) || !identityNumber(value.generation)
    || !text(value.sessionId, 256) || !identityNumber(value.epoch) || !validParams(value.params)
    || !timestamp(value.windowStart) || !timestamp(value.windowEnd) || value.windowEnd <= value.windowStart
    || value.sampleCount !== undefined && (!Number.isSafeInteger(value.sampleCount) || (value.sampleCount as number) < 10)) return false;
  return value.source === 'evaluated-trial'
    ? text(value.trialId, 160) && value.baselineConfirmedAt === undefined
    : timestamp(value.baselineConfirmedAt) && value.trialId === undefined;
}

/**
 * Select a single current-parameter observation. Never mix historic controller
 * windows and never turn a saved trial into current-page confirmation evidence.
 * Existing response evaluation owns the math and minimum synchronized samples.
 */
export function selectFeedbackEvidence(input: FeedbackEvidenceInput): FeedbackEvidenceSelection {
  const pending = (reason: string): FeedbackEvidenceSelection => ({ status: 'pending', reason });
  const params = input.plan.baseline.params;
  const sessionId = input.sessionContext.sessionId;
  const epoch = input.sessionContext.epoch;
  if (!input.plan.baseline.confirmed || !validParams(params)) return pending('先在当前页面核对并确认设备正在使用的基线参数。');
  if (!text(input.currentConfigurationSignature, MAX_SIGNATURE_LENGTH) || !identityNumber(input.generation)
    || !text(sessionId, 256) || !identityNumber(epoch) || !timestamp(input.now) || !timestamp(input.currentTelemetryTimestamp)) {
    return pending('当前配置、设备会话或遥测时间身份不完整，不能选择反馈依据。');
  }
  const common = {
    configurationSignature: input.currentConfigurationSignature,
    generation: input.generation,
    sessionId,
    epoch,
    params: { ...params },
  };

  if (input.lastConfirmed) {
    const confirmation = input.lastConfirmed;
    if (!sameParams(confirmation.params, params) || !timestamp(confirmation.at) || confirmation.at > input.now) {
      return pending('最近设备确认与当前参数或时间身份不一致，请重新核对当前基线。');
    }
    if (!Array.isArray(input.trials) || !(input.trialContexts instanceof Map)) return pending('缺少当前页面的完整试验评价上下文。');
    const matches = input.trials.filter(trial => {
      if (!trial || trial.status !== 'evaluated' || !text(trial.id, 160) || !text(trial.writeRequestId, 256)
        || !timestamp(trial.writeCompletedAt) || trial.writeCompletedAt > confirmation.at
        || trial.confirmationMode !== confirmation.mode || !sameParams(trial.candidate, params)
        || trial.sourceChannelGeneration !== input.generation || trial.writeChannelGeneration !== input.generation
        || trial.writeSessionId !== sessionId || trial.writeEpoch !== epoch || !validMetrics(trial.metrics)
        || !timestamp(trial.sampleWindowStart) || !timestamp(trial.sampleWindowEnd)
        || trial.sampleWindowEnd <= trial.sampleWindowStart || trial.sampleWindowEnd > input.currentTelemetryTimestamp) return false;
      const proof = input.trialContexts.get(trial.id);
      return Boolean(proof && proof.trialId === trial.id && proof.configurationSignature === input.currentConfigurationSignature
        && proof.generation === input.generation && proof.sessionId === sessionId && proof.epoch === epoch
        && proof.confirmedAt === confirmation.at && sameParams(proof.params, params)
        && proof.windowStart === trial.sampleWindowStart && proof.windowEnd === trial.sampleWindowEnd
        && sameMetrics(proof.metrics, trial.metrics));
    });
    if (matches.length !== 1) return pending(matches.length > 1
      ? '最近设备确认对应多个评价窗口，依据不明确，不能混合或猜选。'
      : '最近写入尚无当前参数和设备会话对应的完整评价窗口；不会借用旧 PID 的遥测统计。');
    const trial = matches[0];
    return {
      status: 'ready', source: 'evaluated-trial', metrics: { ...trial.metrics! },
      evidence: { ...common, source: 'evaluated-trial', windowStart: trial.sampleWindowStart!, windowEnd: trial.sampleWindowEnd!, trialId: trial.id, sampleCount: trial.metrics!.sampleCount },
    };
  }

  const boundary = input.baselineBoundary;
  if (!boundary || boundary.configurationSignature !== input.currentConfigurationSignature || boundary.generation !== input.generation
    || boundary.sessionId !== sessionId || boundary.epoch !== epoch || !sameParams(boundary.params, params)
    || !timestamp(boundary.confirmedAt) || !timestamp(boundary.fromTelemetryTimestamp) || boundary.confirmedAt > input.now) {
    return pending('基线观察边界未建立或已失效；请在当前页面重新核对并确认参数，再采集新窗口。');
  }
  const seconds = input.plan.evaluationWindowSeconds;
  const windowMs = typeof seconds === 'number' ? seconds * 1000 : NaN;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return pending('先设置有效的基线观察窗口时长。');
  const remaining = windowMs - (input.now - boundary.confirmedAt);
  if (remaining > 0) return pending(`基线确认后还需观察至少 ${Math.ceil(remaining / 1000)} 秒新遥测；不使用确认前的历史数据。`);
  if (input.currentTelemetryTimestamp <= boundary.fromTelemetryTimestamp) return pending('基线确认后尚未取得推进的新遥测窗口。');
  return {
    status: 'ready', source: 'baseline-window', afterTimestamp: boundary.fromTelemetryTimestamp, throughTimestamp: input.currentTelemetryTimestamp,
    evidence: { ...common, source: 'baseline-window', windowStart: boundary.fromTelemetryTimestamp, windowEnd: input.currentTelemetryTimestamp, baselineConfirmedAt: boundary.confirmedAt },
  };
}
