import type { PlantModel, SolvePidResult } from '../control/types';
import { solvePid } from '../control/solvePid';
import { getPlantControlGain, validatePlantModel, withPlantGainMultiplier } from '../control/transferFunction';
import { isCascadeDependencySnapshot } from './cascadeDependencies';
import { isTuningCommandFormat } from './commandContract';
import { identifyStepReference } from './stepResponse';
import type { LoopStructure, PidValues } from '../project/types';
import type {
  CandidateValidation,
  ParameterBounds,
  PidParameter,
  TuningGoal,
  TuningMetrics,
  TuningPlan,
  TuningTrial,
  TuningCapabilityPackage,
} from './types';

export function parametersForStructure(structure: LoopStructure, params: PidValues): PidValues {
  return {
    kp: params.kp,
    ki: structure === 'P' || structure === 'PD' ? 0 : params.ki,
    kd: structure === 'P' || structure === 'PI' ? 0 : params.kd,
  };
}

/** Requirements for producing a candidate, independent of device execution. */
export function validateCandidateInputs(plan: TuningPlan): string[] {
  if (plan.route === 'feedback') return validatePlan(plan);
  const errors: string[] = [];
  if (plan.commandFormat !== undefined && !isTuningCommandFormat(plan.commandFormat)) errors.push('调参命令的转义和行尾格式无效。');
  if (!plan.name.trim()) errors.push('请填写实验名称。');
  if (!plan.project.trim()) errors.push('请填写项目名称。');
  if (!plan.loopId.trim()) errors.push('请选择或填写控制环名称。');
  if (!plan.controlDirection) errors.push('请确认控制方向，并与执行器到反馈变量的实际方向一致。');
  if (!plan.model) errors.push('对象模型路线需要已确认的模型参数；不会使用示例模型代替。');
  if (plan.suite && !plan.suite.modelConfirmed) errors.push('请先核对物理模型的输入、假设及适用工作点，并明确确认模型。');
  if (plan.model) {
    errors.push(...validatePlantModel(plan.model));
    const modelGain = getPlantControlGain(plan.model);
    if (plan.controlDirection && ((plan.controlDirection === 'direct' && modelGain < 0) || (plan.controlDirection === 'reverse' && modelGain > 0))) {
      errors.push('对象模型增益方向与已选控制方向不一致，请检查符号和接线。');
    }
  }
  if (!isPositive(plan.goal.targetCrossoverRadPerSec) || !isPositive(plan.goal.targetPhaseMarginDeg) || plan.goal.targetPhaseMarginDeg >= 180) {
    errors.push('模型计算需要正的目标剪切频率与小于 180° 的相位裕度。');
  }
  if (!isPositive(plan.sampleTimeSeconds)) errors.push('采样周期必须是已确认的正数。');
  if (plan.suite && !plan.suite.tools.includes('local.pid-solver')) errors.push('当前场景套组未声明本机 PID 计算能力。');
  return [...new Set(errors)];
}

export function validatePlan(plan: TuningPlan): string[] {
  const errors: string[] = plan.route === 'model' ? validateCandidateInputs(plan) : [];
  if (plan.commandFormat !== undefined && !isTuningCommandFormat(plan.commandFormat)) errors.push('调参命令的转义和行尾格式无效。');
  if (!plan.name.trim()) errors.push('请填写实验名称。');
  if (!plan.project.trim()) errors.push('请填写项目名称。');
  if (!plan.loopId.trim()) errors.push('请选择或填写控制环名称。');
  if (!plan.controlDirection) errors.push('请确认控制方向，并与执行器到反馈变量的实际方向一致。');
  if (!plan.commandTemplate.trim()) errors.push('请填写当前控制环的参数写入命令模板。');
  if (plan.suite && plan.route === 'feedback' && !plan.suite.tools.includes('ai.feedback-candidate')) errors.push('当前场景套组未声明 AI 反馈候选能力。');
  if (!Number.isFinite(plan.sampleTimeSeconds) || plan.sampleTimeSeconds === null || plan.sampleTimeSeconds <= 0) {
    errors.push('采样周期必须是已确认的正数。');
  }
  if (!Number.isFinite(plan.maximumTelemetryAgeSeconds) || plan.maximumTelemetryAgeSeconds === null || plan.maximumTelemetryAgeSeconds <= 0) {
    errors.push('请设定有效的遥测最大延迟。');
  }
  if (!Number.isFinite(plan.evaluationWindowSeconds) || plan.evaluationWindowSeconds === null || plan.evaluationWindowSeconds <= 0) {
    errors.push('请设定正数观察时长。');
  }
  if (!Number.isInteger(plan.maximumTrials) || plan.maximumTrials === null || plan.maximumTrials < 1 || plan.maximumTrials > 100) {
    errors.push('最大试验轮数必须是 1 到 100 之间的整数。');
  }
  if (!Number.isFinite(plan.maxParameterChangePercent) || plan.maxParameterChangePercent === null || plan.maxParameterChangePercent <= 0 || plan.maxParameterChangePercent > 100) {
    errors.push('单轮参数变化上限必须大于 0 且不超过 100%。');
  }
  if (!plan.baseline.confirmed || !plan.baseline.params) {
    errors.push('请填写或绑定当前参数，并确认它们确实是设备当前生效值。');
  } else {
    for (const key of ['kp', 'ki', 'kd'] as const) {
      if (!Number.isFinite(plan.baseline.params[key])) errors.push(`${key.toUpperCase()} 基线参数无效。`);
    }
  }
  for (const key of ['kp', 'ki', 'kd'] as const) {
    const bound = plan.bounds[key];
    if (!isActiveParameter(plan.structure, key)) {
      if (plan.baseline.params && plan.baseline.params[key] !== 0) errors.push(`${plan.structure} 结构不使用 ${key.toUpperCase()}，请先核对当前配置。`);
      continue;
    }
    if (!bound || !Number.isFinite(bound.min) || !Number.isFinite(bound.max) || bound.min < 0 || bound.max < bound.min) {
      errors.push(`请确认 ${key.toUpperCase()} 的有效非负上下限。`);
    } else if (plan.baseline.params && (plan.baseline.params[key] < bound.min || plan.baseline.params[key] > bound.max)) {
      errors.push(`${key.toUpperCase()} 当前设备基线超出本次参数边界，请先核对设备状态或调整范围。`);
    }
  }
  if (!plan.channels.setpoint || !plan.channels.feedback || !plan.channels.output) {
    errors.push('请绑定设定值、实际反馈与控制输出通道。');
  }
  for (const key of ['setpoint', 'feedback', 'output'] as const) {
    if (!plan.units[key]?.trim()) errors.push(`请填写${key === 'setpoint' ? '设定值' : key === 'feedback' ? '反馈' : '控制输出'}单位。`);
  }
  if (plan.units.setpoint?.trim() && plan.units.feedback?.trim()
    && plan.units.setpoint.trim().toLocaleLowerCase() !== plan.units.feedback.trim().toLocaleLowerCase()) {
    errors.push('设定值与反馈单位不一致；当前版本不执行单位换算，不能直接比较它们的误差。');
  }
  for (const key of ['kp', 'ki', 'kd'] as const) {
    if (isActiveParameter(plan.structure, key) && !plan.units.parameters[key]?.trim()) {
      errors.push(`请填写 ${key.toUpperCase()} 参数的工程单位或公式。`);
    }
  }
  if (new Set([plan.channels.setpoint, plan.channels.feedback, plan.channels.output].filter(Boolean)).size < 3) {
    errors.push('设定值、实际反馈和控制输出必须绑定到不同的遥测通道。');
  }
  if (plan.confirmation.mode === 'acknowledgement') {
    const acknowledgement = plan.confirmation.acknowledgementText.trim();
    if (!acknowledgement) errors.push('请填写设备确认应答文本。');
    else if (!acknowledgement.includes('{request_id}')) errors.push('设备应答必须包含 {request_id} 占位符；无法关联请求的通用文本只能使用逐轮人工核对。');
    if (!plan.commandTemplate.includes('{request_id}')) errors.push('参数命令必须发送 {request_id}，设备才可回传本次请求对应的应答。');
  }
  if (plan.confirmation.mode !== 'manual' && !isPositive(plan.confirmation.timeoutSeconds)) errors.push('设备确认需要设置正的超时时间。');
  if (plan.confirmation.mode === 'parameter-channels') {
    for (const key of ['kp', 'ki', 'kd'] as const) {
      if (isActiveParameter(plan.structure, key) && !plan.channels.parameters[key]) errors.push(`设备确认需要绑定 ${key.toUpperCase()} 参数回传通道。`);
    }
    if (!isPositive(plan.confirmation.parameterTolerance)) errors.push('请设置正的参数回传容差。');
  }
  if (plan.goal.mode === 'settle' && (!isPositive(plan.goal.maximumSteadyError) || !isPositive(plan.maximumOutputMagnitude))) {
    errors.push('稳定目标需要正的稳态误差限值及控制输出绝对上限。');
  }
  if (plan.goal.mode === 'step-response' && (!isPositive(plan.goal.maximumSteadyError) || !isNonNegative(plan.goal.maximumOvershootPct) || !isPositive(plan.maximumOutputMagnitude))) {
    errors.push('阶跃目标需要稳态误差、超调与控制输出上限。');
  }
  if (plan.goal.mode === 'step-response' && (typeof plan.goal.stepSetpointTolerance !== 'number' || !Number.isFinite(plan.goal.stepSetpointTolerance) || plan.goal.stepSetpointTolerance < 0)) {
    errors.push('阶跃目标需要明确的非负设定值容差，单位与设定值相同。');
  }
  if (plan.goal.mode === 'track' && (!isPositive(plan.goal.maximumTrackingError) || !isPositive(plan.maximumOutputMagnitude))) {
    errors.push('轨迹跟踪目标需要正的 RMS 跟踪误差限值及控制输出绝对上限。');
  }
  if (plan.mode === 'bounded-auto') {
    if (plan.confirmation.mode === 'manual') errors.push('连续自动试验需要设备参数回传或写入应答，不能使用逐轮人工核对。');
    if (!plan.baseline.stableBaseConfirmed) errors.push('自动试验前需要确认现有控制器在可运行的保守基线下稳定控制，并具备独立设备保护。');
    if (!isPositive(plan.confirmation.timeoutSeconds)) errors.push('请设置写入确认超时。');
    if (plan.confirmation.mode === 'parameter-channels') {
      for (const key of ['kp', 'ki', 'kd'] as const) {
        if (!isActiveParameter(plan.structure, key)) continue;
        if (!plan.channels.parameters[key]) errors.push(`自动试验需要绑定 ${key.toUpperCase()} 参数回传通道。`);
      }
      if (!isPositive(plan.confirmation.parameterTolerance)) errors.push('请设置正的参数回传容差。');
    }
  }
  return [...new Set(errors)];
}

export function validateCandidate(
  candidate: PidValues,
  plan: TuningPlan,
  previous: PidValues,
): CandidateValidation {
  const errors: string[] = [];
  const normalized = parametersForStructure(plan.structure, candidate);
  const maxChangePct = plan.maxParameterChangePercent;
  for (const key of ['kp', 'ki', 'kd'] as const) {
    const value = candidate[key];
    if (!Number.isFinite(value)) {
      errors.push(`${key.toUpperCase()} 不是有效数字。`);
      continue;
    }
    if (value < 0) errors.push(`${key.toUpperCase()} 不能为负数。`);
    if (normalized[key] !== value) errors.push(`${plan.structure} 结构不允许修改 ${key.toUpperCase()}。`);
    // Inactive terms are already forced to zero by `parametersForStructure`.
    // They do not need user-provided bounds, which are only required for
    // parameters the selected controller can actually change.
    if (!isActiveParameter(plan.structure, key)) continue;
    const bound = plan.bounds[key];
    if (!bound || value < bound.min || value > bound.max) {
      errors.push(`${key.toUpperCase()} 超出用户确认的范围。`);
      continue;
    }
    const change = Math.abs(value - previous[key]);
    const denominator = previous[key] === 0 ? bound.max - bound.min : Math.abs(previous[key]);
    if (change > 0 && (denominator <= 0 || change / denominator * 100 > (maxChangePct ?? 0))) {
      errors.push(`${key.toUpperCase()} 超出按基线或工程范围计算的单轮变化上限。`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function calculateModelCandidate(
  plant: PlantModel,
  plan: TuningPlan,
): { result: SolvePidResult; params: PidValues | null } {
  if (!isPositive(plan.goal.targetCrossoverRadPerSec) || !isPositive(plan.goal.targetPhaseMarginDeg) || !plan.sampleTimeSeconds) {
    return {
      params: null,
      result: {
        success: false,
        kp: 0,
        ki: 0,
        kd: 0,
        tf: 0,
        structure: plan.structure,
        message: '请确认目标剪切频率、相位裕度及采样周期。',
      },
    };
  }
  const modelErrors = validateCandidateInputs({ ...plan, route: 'model', model: plant });
  if (modelErrors.length) return { params: null, result: { success: false, kp: 0, ki: 0, kd: 0, tf: 0, structure: plan.structure, message: modelErrors.join(' ') } };
  // Controller coefficients stay nonnegative; direction is implemented by the
  // firmware's error/actuator sign. Solve the corresponding positive-gain plant.
  const calculationPlant = plan.controlDirection === 'reverse' ? withPlantGainMultiplier(plant, -1) : plant;
  const result = solvePid(calculationPlant, {
    target_omega_c: plan.goal.targetCrossoverRadPerSec,
    target_phase_margin: plan.goal.targetPhaseMarginDeg,
    structure: plan.structure,
    sampleTime: plan.sampleTimeSeconds,
  });
  return {
    result,
    params: result.success ? parametersForStructure(plan.structure, result) : null,
  };
}

export function createCandidateRecord(
  candidate: PidValues,
  plan: TuningPlan,
  previous: PidValues,
  note: string,
): TuningTrial {
  const trialId = createId();
  return {
    id: trialId,
    protocolRequestId: trialId,
    createdAt: Date.now(),
    status: 'proposed',
    before: { ...previous },
    candidate: parametersForStructure(plan.structure, candidate),
    note,
    planSignature: tuningPlanSignature(plan),
  };
}

export function tuningPlanSignature(plan: TuningPlan): string {
  return JSON.stringify(plan);
}

export function isTrialForPlan(trial: TuningTrial, plan: TuningPlan, currentGeneration?: number): boolean {
  return typeof trial.planSignature === 'string' && trial.planSignature === tuningPlanSignature(plan)
    && (currentGeneration === undefined || trial.sourceChannelGeneration === currentGeneration);
}

export function formatTuningParameter(value: number): string {
  if (!Number.isFinite(value)) throw new Error('参数不是有效有限数值。');
  return String(value);
}

/** Attempted device writes consume the budget even without ACK or a full window. */
export function trialBudgetUsed(trials: TuningTrial[]): number {
  return trials.filter((trial) => trial.writeStartedAt !== undefined).length;
}

export function evaluateResponse(
  setpoints: ArrayLike<number>,
  responses: ArrayLike<number>,
  outputs: ArrayLike<number>,
  goal: TuningGoal,
  maximumOutputMagnitude: number,
): { metrics: TuningMetrics | null; passed: boolean; message: string; outputLimitExceeded?: boolean } {
  const count = Math.min(setpoints.length, responses.length, outputs.length);
  if (setpoints.length !== responses.length || responses.length !== outputs.length) return { metrics: null, passed: false, message: '采样数组长度不一致，不能作为同步响应评价。' };
  if (count < 10) return { metrics: null, passed: false, message: '有效数据不足，至少需要 10 组同步采样。' };
  for (let index = 0; index < count; index++) {
    if (![setpoints[index], responses[index], outputs[index]].every(Number.isFinite)) return { metrics: null, passed: false, message: '响应窗口包含无效数字，不能计算或发送 AI 遥测指标。' };
  }
  if (!Number.isFinite(maximumOutputMagnitude) || maximumOutputMagnitude <= 0) return { metrics: null, passed: false, message: '控制输出上限无效，不能评价响应。' };
  for (let index = 0; index < count; index++) {
    if (Math.abs(outputs[index]) > maximumOutputMagnitude) return { metrics: null, passed: false, outputLimitExceeded: true, message: '控制输出超过用户设置的上限，实验应停止并检查设备状态。' };
  }
  if (!goal || !['settle', 'step-response', 'track'].includes(goal.mode)
    || (goal.mode === 'track' ? !isPositive(goal.maximumTrackingError) : !isPositive(goal.maximumSteadyError))
    || goal.mode === 'step-response' && !isNonNegative(goal.maximumOvershootPct)) return { metrics: null, passed: false, message: '响应评价目标或误差上限无效。' };
  const step = goal.mode === 'step-response' ? identifyStepReference(setpoints, goal.stepSetpointTolerance) : null;
  if (step && !step.valid) return { metrics: null, passed: false, message: step.reason };
  if (step?.valid) {
    for (let index = 0; index < step.transitionIndex; index++) {
      if (Math.abs(responses[index] - step.initialTarget) > goal.maximumSteadyError!) {
        return { metrics: null, passed: false, message: '阶跃前反馈尚未稳定在初始目标的误差范围内；不能作为单次阶跃响应，请重新采集完整窗口。' };
      }
    }
  }
  const finalTargetCount = Math.min(5, count);
  const finalTargetStart = count - finalTargetCount;
  const finalTargetSamples = Array.from({ length: finalTargetCount }, (_, i) => setpoints[finalTargetStart + i]);
  const target = step?.valid ? step.finalTarget : median(finalTargetSamples);
  if (!Number.isFinite(target)) return { metrics: null, passed: false, message: '目标通道包含无效数据。' };
  const tailStart = Math.max(0, count - Math.min(10, Math.floor(count / 5)));
  let steadyError = 0;
  let peakError = 0;
  let maxOutput = 0;
  let maximumOvershoot = 0;
  let minimumTarget = Infinity;
  let maximumTarget = -Infinity;
  let rmsScale = 0;
  let scaledSquares = 0;
  for (let index = 0; index < count; index++) {
    const error = Math.abs(responses[index] - setpoints[index]);
    const finalError = index >= tailStart ? Math.abs(responses[index] - target) : 0;
    if (!Number.isFinite(error) || !Number.isFinite(finalError)) return { metrics: null, passed: false, message: '响应误差计算超出有限数值范围，不能作为评价或 AI 依据。' };
    peakError = Math.max(peakError, error);
    steadyError = Math.max(steadyError, finalError);
    maxOutput = Math.max(maxOutput, Math.abs(outputs[index]));
    minimumTarget = Math.min(minimumTarget, setpoints[index]);
    maximumTarget = Math.max(maximumTarget, setpoints[index]);
    if (step?.valid && index >= step.transitionIndex) maximumOvershoot = Math.max(maximumOvershoot, step.direction * (responses[index] - target));
    // Scaled sum of squares avoids squaring finite large errors into Infinity.
    if (error > 0) {
      if (error > rmsScale) {
        scaledSquares = 1 + scaledSquares * (rmsScale / error) ** 2;
        rmsScale = error;
      } else scaledSquares += (error / rmsScale) ** 2;
    }
  }
  const rmsTrackingError = rmsScale * Math.sqrt(scaledSquares / count);
  const targetPlateausValid = goal.mode !== 'settle' || maximumTarget - minimumTarget <= goal.maximumSteadyError!;
  const overshootPercent = step?.valid ? maximumOvershoot / step.amplitude * 100 : null;
  if (![steadyError, peakError, rmsTrackingError, maxOutput].every(Number.isFinite)
    || overshootPercent !== null && !Number.isFinite(overshootPercent)) return { metrics: null, passed: false, message: '响应指标计算超出有限数值范围，不能作为评价或 AI 依据。' };
  const metrics: TuningMetrics = {
    steadyError,
    peakError,
    rmsTrackingError,
    overshootPercent,
    maximumOutputMagnitude: maxOutput,
    sampleCount: count,
  };
  const passed = (goal.mode === 'track'
    ? rmsTrackingError <= (goal.maximumTrackingError ?? 0)
    : steadyError <= (goal.maximumSteadyError ?? 0))
    && (goal.mode !== 'step-response' || (overshootPercent ?? Infinity) <= goal.maximumOvershootPct!)
    && targetPlateausValid
    && maxOutput <= maximumOutputMagnitude;
  const message = passed
    ? '实测指标已满足本次设定目标。'
    : maxOutput > maximumOutputMagnitude
      ? '控制输出超过用户设置的上限，实验应停止并检查设备状态。'
    : !targetPlateausValid
      ? '设定值未满足当前目标类型的平台条件；静态稳定和阶跃响应需要可识别的平台，轨迹变化请使用跟踪目标。'
    : goal.mode === 'track'
      ? '当前 RMS 跟踪误差或控制输出尚未满足目标。'
      : '当前数据尚未同时满足稳态误差与响应目标。';
  return { metrics, passed, message };
}

export function matchesParameterReadback(
  desired: PidValues,
  received: Partial<Record<PidParameter, number>>,
  tolerance: number,
  structure: LoopStructure,
): boolean {
  for (const key of ['kp', 'ki', 'kd'] as const) {
    if (!isActiveParameter(structure, key)) continue;
    const value = received[key];
    if (!Number.isFinite(value)) return false;
    const scale = Math.max(Math.abs(desired[key]), 1e-9);
    if (Math.abs((value as number) - desired[key]) / scale * 100 > tolerance) return false;
  }
  return true;
}

export function packagePlan(plan: TuningPlan, title = plan.name): unknown {
  return {
    schema: 'com.llm-serial.tuning-package',
    version: 1,
    id: `user.${slugify(title)}`,
    title,
    author: '本地用户',
    description: plan.description,
    compatibility: { app: '^0.1.0', features: ['tuning-workspace-v1'] },
    skills: plan.prompt.trim() ? [{ id: 'project-guidance', title: '项目调参知识', instructions: plan.prompt }] : [],
    tools: plan.suite?.tools ?? (plan.route === 'model' ? ['local.pid-solver'] : ['ai.feedback-candidate']),
    plan: { ...JSON.parse(JSON.stringify(plan)), id: createId(), prompt: '', cascadeBinding: undefined, suite: plan.suite ? { ...plan.suite, modelConfirmed: false } : undefined, baseline: { params: null, source: 'unset', confirmed: false, stableBaseConfirmed: false } },
  };
}

export function validateCapabilityPackage(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['文件内容不是项目套件对象。'];
  const pkg = value as Record<string, unknown>;
  if (pkg.schema !== 'com.llm-serial.tuning-package') return ['文件不是 LLM 串口调参套件。'];
  if (pkg.version !== 1) return ['该套件版本暂不受支持。'];
  if (!boundedString(pkg.id, 160, true) || !boundedString(pkg.description, 4000)) return ['套件标识或说明无效。'];
  if (typeof pkg.title !== 'string' || !pkg.title.trim() || pkg.title.length > 120) return ['套件标题无效。'];
  if (typeof pkg.author !== 'string' || pkg.author.length > 120) return ['套件作者信息无效。'];
  if (!pkg.compatibility || typeof pkg.compatibility !== 'object') return ['套件缺少兼容信息。'];
  const compatibility = pkg.compatibility as Record<string, unknown>;
  if (compatibility.app !== '^0.1.0' || !Array.isArray(compatibility.features) || !compatibility.features.includes('tuning-workspace-v1')) return ['套件与当前调参工作区不兼容。'];
  if (!Array.isArray(pkg.skills) || pkg.skills.length > 12) return ['套件的项目知识配置无效或数量超限。'];
  if (!pkg.skills.every(isSkill)) return ['套件项目知识格式无效。'];
  if (pkg.skills.reduce((total, skill) => total + (skill as Record<string, string>).instructions.length, 0) > 12000) return ['套件项目知识总长度超限，请精简后导入。'];
  if (!Array.isArray(pkg.tools) || !pkg.tools.length || pkg.tools.length > 2 || !pkg.tools.every(isSupportedTool)) return ['套件请求了当前不支持的工具。'];
  const tools = pkg.tools;
  const shapeErrors = validatePlanShape(pkg.plan);
  if (shapeErrors.length) return shapeErrors;
  const plan = pkg.plan as TuningPlan;
  if (!pkg.tools.includes(plan.route === 'model' ? 'local.pid-solver' : 'ai.feedback-candidate')) return ['套件未声明当前路线必需的工具。'];
  if (plan.suite?.tools.some((tool) => !tools.includes(tool))) return ['套件场景请求的工具不在顶层能力声明中。'];
  return [];
}

/** Treat saved drafts and imports as untrusted data before UI hydration. */
export function validatePlanShape(value: unknown): string[] {
  if (!isObject(value)) return ['套件缺少调参计划。'];
  const p = value;
  if (p.version !== 1 || !boundedString(p.id, 160, true)) return ['调参计划版本或标识无效。'];
  for (const [key, limit] of [['name', 120], ['project', 120], ['description', 4000], ['prompt', 12000], ['loopId', 160], ['commandTemplate', 512]] as const) {
    if (!boundedString(p[key], limit)) return [`调参计划 ${key} 必须是长度受限的文本。`];
  }
  if (p.commandFormat !== undefined && !isTuningCommandFormat(p.commandFormat)) return ['调参命令的转义和行尾格式无效。'];
  if (!['model', 'feedback'].includes(p.route as string) || !['manual', 'bounded-auto'].includes(p.mode as string)
    || !['P', 'PI', 'PD', 'PID'].includes(p.structure as string) || ![null, 'direct', 'reverse'].includes(p.controlDirection as never)) return ['调参路线、模式、控制结构或方向无效。'];
  for (const key of ['sampleTimeSeconds', 'maxParameterChangePercent', 'maximumTrials', 'evaluationWindowSeconds', 'maximumTelemetryAgeSeconds', 'maximumOutputMagnitude']) {
    if (!nullableNumber(p[key])) return [`调参计划 ${key} 需要有限数值或空值。`];
  }
  if (!isObject(p.baseline) || p.baseline.params !== null && !isPidValues(p.baseline.params)
    || !['unset', 'manual', 'parameter-channels'].includes(p.baseline.source as string)
    || typeof p.baseline.confirmed !== 'boolean' || typeof p.baseline.stableBaseConfirmed !== 'boolean') return ['当前参数基线格式无效。'];
  if (!isObject(p.bounds) || !['kp', 'ki', 'kd'].every((key) => {
    const b = (p.bounds as Record<string, unknown>)[key];
    return b === null || isObject(b) && finiteNumber(b.min) && finiteNumber(b.max);
  })) return ['参数边界格式无效。'];
  if (!isObject(p.channels) || !['setpoint', 'feedback', 'output'].every((key) => boundedString((p.channels as Record<string, unknown>)[key], 160))
    || !isParameterMap(p.channels.parameters, (item) => boundedString(item, 160))) return ['遥测通道格式无效。'];
  if (!isObject(p.units) || !['setpoint', 'feedback', 'output'].every((key) => boundedString((p.units as Record<string, unknown>)[key], 160))
    || !isParameterMap(p.units.parameters, (item) => boundedString(item, 160))) return ['遥测单位格式无效。'];
  if (!isObject(p.confirmation) || !['manual', 'parameter-channels', 'acknowledgement'].includes(p.confirmation.mode as string)
    || !boundedString(p.confirmation.acknowledgementText, 512) || !nullableNumber(p.confirmation.timeoutSeconds) || !nullableNumber(p.confirmation.parameterTolerance)) return ['设备确认格式无效。'];
  if (!isObject(p.goal) || !['settle', 'step-response', 'track'].includes(p.goal.mode as string)
    || !['maximumSteadyError', 'maximumOvershootPct', 'maximumTrackingError', 'targetPhaseMarginDeg', 'targetCrossoverRadPerSec'].every((key) => nullableNumber((p.goal as Record<string, unknown>)[key]))
    || p.goal.stepSetpointTolerance !== undefined && !nullableNumber(p.goal.stepSetpointTolerance)) return ['调参目标格式无效。'];
  if (p.model !== null && (!isObject(p.model) || validatePlantModel(p.model as unknown as PlantModel).length)) return ['对象模型格式无效。'];
  if (p.suite !== undefined && !isScenarioContext(p.suite)) return ['场景套组格式无效。'];
  if (p.cascadeBinding !== undefined && !isCascadeDependencySnapshot(p.cascadeBinding)) return ['串级内环依赖快照格式无效。'];
  return [];
}

/** Import data only; every device value and model attestation must be reconfirmed. */
export function importCapabilityPlan(pkg: TuningCapabilityPackage): TuningPlan {
  const errors = validateCapabilityPackage(pkg);
  if (errors.length) throw new Error(errors.join(' '));
  const plan = JSON.parse(JSON.stringify(pkg.plan)) as TuningPlan;
  plan.id = createId();
  plan.prompt = pkg.skills.map((skill) => skill.instructions).join('\n\n');
  plan.baseline = { params: null, source: 'unset', confirmed: false, stableBaseConfirmed: false };
  if (plan.suite) plan.suite.modelConfirmed = false;
  delete plan.cascadeBinding;
  return plan;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedString(value: unknown, limit: number, required = false): value is string {
  return typeof value === 'string' && value.length <= limit && (!required || Boolean(value.trim()));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nullableNumber(value: unknown): boolean {
  return value === null || finiteNumber(value);
}

function isPidValues(value: unknown): value is PidValues {
  return isObject(value) && ['kp', 'ki', 'kd'].every((key) => finiteNumber(value[key]));
}

function isParameterMap(value: unknown, accept: (item: unknown) => boolean): boolean {
  return isObject(value) && Object.entries(value).every(([key, item]) => ['kp', 'ki', 'kd'].includes(key) && accept(item));
}

function isSkill(value: unknown): boolean {
  return isObject(value) && boundedString(value.id, 160, true) && boundedString(value.title, 120, true) && boundedString(value.instructions, 12000);
}

function isSupportedTool(value: unknown): boolean {
  return value === 'local.pid-solver' || value === 'ai.feedback-candidate';
}

function isScenarioContext(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ['balance-car', 'flight-control', 'custom'].includes(value.id as string) && value.version === 1
    && boundedString(value.title, 120, true) && boundedString(value.topologyId, 160, true) && boundedString(value.stageId, 160, true)
    && boundedString(value.prompt, 12000) && Array.isArray(value.skills) && value.skills.length <= 12 && value.skills.every(isSkill)
    && Array.isArray(value.tools) && value.tools.length <= 2 && value.tools.every(isSupportedTool)
    && isObject(value.physicalInputs) && Object.keys(value.physicalInputs).length <= 32
    && Object.entries(value.physicalInputs).every(([key, v]) => safeFieldId(key) && nullableNumber(v))
    && ['pending', 'physical-inputs', 'user-transfer-function', 'ai-proposal'].includes(value.modelOrigin as string)
    && typeof value.modelConfirmed === 'boolean' && Array.isArray(value.assumptions) && value.assumptions.length <= 24
    && value.assumptions.every((item) => boundedString(item, 1000))
    && (value.customStages === undefined || Array.isArray(value.customStages) && value.customStages.length > 0 && value.customStages.length <= 8 && value.customStages.every(isScenarioStage))
    && (value.modelDraft === undefined || isModelDraft(value.modelDraft));
}

function isScenarioStage(value: unknown): boolean {
  return isObject(value) && boundedString(value.id, 160, true) && boundedString(value.title, 120, true)
    && ['P', 'PI', 'PD', 'PID'].includes(value.structure as string) && Array.isArray(value.supportedStructures)
    && value.supportedStructures.length > 0 && value.supportedStructures.length <= 4
    && value.supportedStructures.every((item) => ['P', 'PI', 'PD', 'PID'].includes(item as string))
    && value.supportedStructures.includes(value.structure);
}

function isModelDraft(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.numerator) || !Array.isArray(value.denominator)) return false;
  return value.numerator.length > 0 && value.numerator.length <= value.denominator.length && value.denominator.length <= 9
    && value.numerator.concat(value.denominator).every((item) => boundedString(item, 256, true)) && boundedString(value.tau, 256, true)
    && Array.isArray(value.physicalFields) && value.physicalFields.length <= 32 && value.physicalFields.every((item) => isObject(item)
      && boundedString(item.id, 48, true) && safeFieldId(item.id)
      && boundedString(item.label, 120, true) && boundedString(item.unit, 80, true) && typeof item.required === 'boolean'
      && (item.min === undefined || finiteNumber(item.min)) && (item.max === undefined || finiteNumber(item.max)))
    && Array.isArray(value.assumptions) && value.assumptions.length <= 24 && value.assumptions.every((item) => boundedString(item, 1000))
    && (value.explanation === undefined || boundedString(value.explanation, 4000));
}

function safeFieldId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value) && !['pi', 'sqrt', 'abs', 'constructor', 'prototype', '__proto__'].includes(value);
}

export async function fingerprint(value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function parameterFields(): PidParameter[] {
  return ['kp', 'ki', 'kd'];
}

export function isActiveParameter(structure: LoopStructure, key: PidParameter): boolean {
  return !(key === 'ki' && (structure === 'P' || structure === 'PD'))
    && !(key === 'kd' && (structure === 'P' || structure === 'PI'));
}

export function limitsFromProject(limits: Record<PidParameter, [number, number]> | null | undefined): Record<PidParameter, ParameterBounds | null> {
  return {
    kp: limits ? { min: limits.kp[0], max: limits.kp[1] } : null,
    ki: limits ? { min: limits.ki[0], max: limits.ki[1] } : null,
    kd: limits ? { min: limits.kd[0], max: limits.kd[1] } : null,
  };
}

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `experiment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'tuning';
}
