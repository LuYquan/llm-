import type { TuningPlan, TuningSession, TuningTrial } from './types';

export interface ManualCandidateEligibilityInput {
  planErrorCount: number;
  isWorking: boolean;
  sessionStatus: string;
  route: 'model' | 'feedback';
  connected: boolean;
  telemetryFresh: boolean;
}

export interface ManualCandidateEligibility {
  allowed: boolean;
  reason?: string;
}

/**
 * The manual-candidate button is a UI action, but its safety boundary should
 * be a plain boolean function so a Vue ref object can never be treated as a
 * truthy value by accident. Sending remains a separate, disabled-by-default
 * path in TuningWorkbench.
 */
export function manualCandidateEligibility(input: ManualCandidateEligibilityInput): ManualCandidateEligibility {
  if (input.planErrorCount > 0) return { allowed: false, reason: '调参计划仍有未解决的校验错误。' };
  if (input.isWorking) return { allowed: false, reason: '当前实验仍在进行，不能同时生成新的候选。' };
  if (input.sessionStatus === 'completed') return { allowed: false, reason: '当前实验已经完成，请新建实验后再生成候选。' };
  if (input.route === 'feedback' && (!input.connected || !input.telemetryFresh)) {
    return { allowed: false, reason: '反馈路线需要已连接且遥测数据保持新鲜。' };
  }
  return { allowed: true };
}

/** Deterministic decision; callers own the configured transport stop action. */
export function executionSafetyStopReason(input: { connected: boolean; telemetryFresh: boolean; output: number | undefined; maximumOutputMagnitude: number | null }): string | null {
  if (!input.connected) return '串口已断开，设备停止字节可能无法送达。';
  if (!input.telemetryFresh || !Number.isFinite(input.output)) return '实时遥测过期、会话变化或控制输出无效。';
  if (!Number.isFinite(input.maximumOutputMagnitude) || Math.abs(input.output!) > input.maximumOutputMagnitude!) return '控制输出超过用户设置的绝对上限。';
  return null;
}

/** Recheck after asynchronous waits, before evaluation or runtime evidence. */
export function confirmedTrialContextFailure(input: {
  trial: TuningTrial;
  plan: TuningPlan;
  lastConfirmed: TuningSession['lastConfirmed'];
  generation: number;
  sessionContext: { sessionId: string | null; epoch: number | null };
  authorizedScopeMatches: boolean;
  working: boolean;
  stopped: boolean;
  connected: boolean;
  executionEnabled: boolean;
}): string | null {
  const { trial, plan, lastConfirmed } = input;
  if (!input.working || input.stopped || !input.connected || !input.executionEnabled || !input.authorizedScopeMatches) return '试验授权、连接或执行条件已变化，不能记录本轮评价。';
  if (!['confirmed', 'evaluated'].includes(trial.status) || !trial.writeRequestId
    || !Number.isFinite(trial.writeCompletedAt) || trial.writeCompletedAt! < 0 || !Number.isSafeInteger(input.generation) || input.generation < 0
    || trial.sourceChannelGeneration !== input.generation || trial.writeChannelGeneration !== input.generation
    || !input.sessionContext.sessionId || trial.writeSessionId !== input.sessionContext.sessionId
    || !Number.isSafeInteger(input.sessionContext.epoch) || input.sessionContext.epoch! < 0 || trial.writeEpoch !== input.sessionContext.epoch) return '本轮驱动确认与当前设备会话不一致，不能记录已验证结果。';
  if (!lastConfirmed || !Number.isFinite(lastConfirmed.at) || lastConfirmed.at < trial.writeCompletedAt!
    || lastConfirmed.mode !== trial.confirmationMode || !plan.baseline.confirmed || !plan.baseline.params
    || !(['kp', 'ki', 'kd'] as const).every(key => Number.isFinite(trial.candidate[key])
      && lastConfirmed.params[key] === trial.candidate[key] && plan.baseline.params![key] === trial.candidate[key])) return '设备确认参数或当前基线已变化，本轮评价依据已失效。';
  return null;
}

