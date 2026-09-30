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

