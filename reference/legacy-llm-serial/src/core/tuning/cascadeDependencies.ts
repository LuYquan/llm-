import type { LoopStructure } from '../project/types';
import { validatePlantModel } from '../control/transferFunction';
import { getScenarioPhysicalFields, getScenarioSuite, validateCustomStages } from './scenarios';
import type { ScenarioStage, TuningScenarioId } from './scenarios';
import type { TuningPlan, TuningSession } from './types';

/** Configuration identity only. A saved binding grants no device authority. */
export interface CascadeDependencySnapshot {
  version: 1;
  groupId: string;
  scenarioId: TuningScenarioId;
  topologyId: string;
  targetStageId: string;
  stages: Array<{ id: string; structure: LoopStructure }>;
  dependencies: Array<{ stageId: string; sessionId: string; configSignature: string }>;
}

/** Insert only after a current-page write confirmation and passing evaluation. */
export interface CascadeRuntimeEvidence {
  groupId: string;
  sessionId: string;
  scenarioId: TuningScenarioId;
  topologyId: string;
  stageId: string;
  configSignature: string;
  generation: number;
  trialId: string;
}

export interface CascadeDependencyInput {
  plan: TuningPlan;
  groupId: string;
  /** Saved configuration snapshots; their confirmation flags are not authority. */
  sessions: readonly TuningSession[];
}

export interface CascadeDependencyCheck {
  ready: boolean;
  snapshot: CascadeDependencySnapshot | null;
  issues: string[];
}

const MAX_STAGES = 6;
const MAX_SIGNATURE_LENGTH = 262_144;
const STRUCTURES: readonly LoopStructure[] = ['P', 'PI', 'PD', 'PID'];
const SCENARIOS: readonly string[] = ['balance-car', 'flight-control', 'custom'];
const stageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value);
const text = (value: unknown, maximum = 160): value is string => typeof value === 'string' && value.length <= maximum && Boolean(value.trim());
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

/** Reject ambiguous, oversized and out-of-order saved dependency declarations. */
export function isCascadeDependencySnapshot(value: unknown): value is CascadeDependencySnapshot {
  if (!record(value) || !keysAre(value, ['version', 'groupId', 'scenarioId', 'topologyId', 'targetStageId', 'stages', 'dependencies'])
    || value.version !== 1 || !text(value.groupId) || !SCENARIOS.includes(value.scenarioId as string)
    || !stageId(value.topologyId) || !stageId(value.targetStageId)
    || !Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > MAX_STAGES
    || !Array.isArray(value.dependencies) || value.dependencies.length >= value.stages.length) return false;
  const ids = new Set<string>();
  for (const entry of value.stages) {
    if (!record(entry) || !keysAre(entry, ['id', 'structure']) || !stageId(entry.id) || ids.has(entry.id) || !STRUCTURES.includes(entry.structure as LoopStructure)) return false;
    ids.add(entry.id);
  }
  const stages = value.stages as CascadeDependencySnapshot['stages'];
  const targetIndex = stages.findIndex(entry => entry.id === value.targetStageId);
  if (targetIndex < 0 || value.dependencies.length !== targetIndex) return false;
  const sessionIds = new Set<string>();
  return value.dependencies.every((entry, index) => {
    if (!record(entry) || !keysAre(entry, ['stageId', 'sessionId', 'configSignature']) || entry.stageId !== stages[index].id
      || !text(entry.sessionId) || sessionIds.has(entry.sessionId) || !text(entry.configSignature, MAX_SIGNATURE_LENGTH)) return false;
    sessionIds.add(entry.sessionId);
    return true;
  });
}

function resolveStages(plan: TuningPlan): { stages: ScenarioStage[]; index: number; issues: string[] } {
  if (!plan.suite) return { stages: [], index: -1, issues: [] };
  const context = plan.suite;
  if (!record(context)) return { stages: [], index: -1, issues: ['场景套组无效。'] };
  const suite = getScenarioSuite(context.id);
  const topology = suite?.topologies.find(item => item.id === context.topologyId);
  if (!suite || !topology || context.version !== 1) return { stages: [], index: -1, issues: ['场景套组或控制拓扑无效，不能建立串级依赖。'] };
  const stages = context.id === 'custom' ? context.customStages : topology.stages;
  if (!Array.isArray(stages)) return { stages: [], index: -1, issues: ['自定义串级缺少明确的有序控制阶段。'] };
  const issues = validateCustomStages(stages);
  if (issues.length) return { stages: [], index: -1, issues };
  for (const entry of stages) {
    if (!entry || !Array.isArray(entry.supportedStructures) || !entry.supportedStructures.length || entry.supportedStructures.length > STRUCTURES.length
      || new Set(entry.supportedStructures).size !== entry.supportedStructures.length
      || !entry.supportedStructures.every(item => STRUCTURES.includes(item)) || !entry.supportedStructures.includes(entry.structure)) {
      issues.push('控制阶段的可选结构无效或重复。');
    }
  }
  if (context.id !== 'custom' && context.customStages !== undefined) issues.push('预设场景不能用自定义阶段替换真实拓扑。');
  if (context.id === 'custom' && context.topologyId === 'single' && stages.length !== 1) issues.push('自定义单环拓扑只能包含一个阶段。');
  if (context.id === 'custom' && context.topologyId === 'cascade' && stages.length < 2) issues.push('自定义串级拓扑至少需要两个阶段。');
  if (issues.length) return { stages: [], index: -1, issues: [...new Set(issues)] };
  const index = stages.findIndex(item => item.id === context.stageId);
  if (index < 0 || plan.loopId !== context.stageId) issues.push('当前阶段与控制环 ID 不匹配，不能建立串级依赖。');
  else if (!stages[index].supportedStructures.includes(plan.structure)
    || context.id === 'custom' && stages[index].structure !== plan.structure) issues.push('当前控制器结构与阶段定义不匹配。');
  return { stages, index, issues: [...new Set(issues)] };
}

/** Stable exact-value comparison, not a cryptographic device attestation. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('配置包含非有限数值。');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('配置包含不能保存的值。');
}

/** Ignore attestations/history/bindings; preserve all actual baseline values. */
export function cascadeStageConfigurationSignature(plan: TuningPlan): { ready: boolean; signature: string | null; issues: string[] } {
  const resolved = resolveStages(plan);
  const issues = [...resolved.issues];
  if (!text(plan.loopId)) issues.push('缺少控制环 ID。');
  if (!STRUCTURES.includes(plan.structure)) issues.push('控制器结构无效。');
  if (!['direct', 'reverse'].includes(plan.controlDirection as string)) issues.push('缺少已核对的控制方向。');
  if (!positive(plan.sampleTimeSeconds)) issues.push('缺少有效的固件采样周期。');
  if (plan.route === 'model' && !plan.model) issues.push('模型路线缺少对象模型。');
  if (plan.model) issues.push(...validatePlantModel(plan.model));
  if (!['model', 'feedback'].includes(plan.route)) issues.push('当前环的调参路线无效。');
  if (plan.suite && plan.route === 'model') {
    if (plan.suite.modelOrigin === 'pending') issues.push('模型路线缺少明确的对象模型来源。');
    const fields = plan.suite.modelOrigin === 'physical-inputs' ? getScenarioPhysicalFields(plan.suite.id, plan.suite.stageId)
      : plan.suite.modelOrigin === 'ai-proposal' ? plan.suite.modelDraft?.physicalFields : [];
    if (!Array.isArray(fields)) issues.push('AI 模型缺少明确的物理输入字段。');
    else for (const field of fields) {
      const value = plan.suite.physicalInputs?.[field.id];
      if (field.required && (value === null || value === undefined) || value !== null && value !== undefined
        && (!Number.isFinite(value) || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max)) issues.push(`物理输入“${field.label}”不完整或超出有效范围。`);
    }
  }
  const params = plan.baseline?.params;
  if (!params || !['kp', 'ki', 'kd'].every(key => typeof params[key as keyof typeof params] === 'number' && Number.isFinite(params[key as keyof typeof params]) && params[key as keyof typeof params] >= 0)) {
    issues.push('缺少完整、有限且非负的当前 PID 参数。');
  } else {
    if ((plan.structure === 'P' || plan.structure === 'PD') && params.ki !== 0 || (plan.structure === 'P' || plan.structure === 'PI') && params.kd !== 0) issues.push('当前 PID 参数与控制结构不一致。');
    for (const key of ['kp', 'ki', 'kd'] as const) {
      const bound = plan.bounds?.[key];
      if (bound && (!Number.isFinite(bound.min) || !Number.isFinite(bound.max) || bound.min < 0 || bound.max < bound.min
        || params[key] < bound.min || params[key] > bound.max)) issues.push(`${key.toUpperCase()} 已提供的当前参数边界无效。`);
      if (key === 'ki' && (plan.structure === 'P' || plan.structure === 'PD') || key === 'kd' && (plan.structure === 'P' || plan.structure === 'PI')) continue;
      if (!text(plan.units?.parameters?.[key])) issues.push(`${key.toUpperCase()} 参数单位不完整。`);
    }
  }
  if (!['setpoint', 'feedback', 'output'].every(key => text(plan.units?.[key as 'setpoint']))) issues.push('设定值、反馈和输出单位不完整。');
  if (text(plan.units?.setpoint) && text(plan.units?.feedback) && plan.units.setpoint.trim().toLowerCase() !== plan.units.feedback.trim().toLowerCase()) issues.push('设定值与反馈单位不一致，当前依赖不执行单位换算。');
  if (issues.length) return { ready: false, signature: null, issues: [...new Set(issues)] };
  try {
    const { id: _id, name: _name, baseline, suite, cascadeBinding: _binding, ...configuration } = plan as TuningPlan & { cascadeBinding?: unknown };
    const scenario = suite ? (({ modelConfirmed: _confirmed, ...rest }) => ({ ...rest,
      ...(suite.id === 'custom' ? { customStages: suite.customStages?.slice(0, resolved.index + 1) } : {}),
    }))(suite) : undefined;
    const signature = canonical({ ...configuration, baseline: { params: baseline.params }, suite: scenario });
    if (signature.length > MAX_SIGNATURE_LENGTH) return { ready: false, signature: null, issues: ['当前环配置过大，不能建立串级依赖。'] };
    return { ready: true, signature, issues: [] };
  } catch (error) {
    return { ready: false, signature: null, issues: [error instanceof Error ? error.message : '当前环配置不能规范化。'] };
  }
}

export function buildCascadeDependencySnapshot(input: CascadeDependencyInput): CascadeDependencyCheck {
  const { plan, groupId, sessions } = input;
  const resolved = resolveStages(plan);
  if (resolved.issues.length) return { ready: false, snapshot: null, issues: resolved.issues };
  if (!plan.suite || resolved.index === 0) return { ready: true, snapshot: null, issues: [] };
  if (!text(groupId)) return { ready: false, snapshot: null, issues: ['当前场景缺少有效的实验组 ID。'] };
  if (!Array.isArray(sessions)) return { ready: false, snapshot: null, issues: ['前置内环配置列表无效。'] };
  const context = plan.suite;
  const stages = resolved.stages.map(item => ({ id: item.id, structure: item.structure }));
  const dependencies: CascadeDependencySnapshot['dependencies'] = [];
  const issues: string[] = [];
  for (const stage of resolved.stages.slice(0, resolved.index)) {
    const sources = sessions.filter(session => session?.scenarioGroupId === groupId && session.plan?.suite?.id === context.id
      && session.plan.suite.topologyId === context.topologyId && session.plan.suite.stageId === stage.id);
    if (sources.length !== 1) {
      issues.push(sources.length ? `内环“${stage.title}”存在重复来源，请明确唯一的阶段会话。` : `内环“${stage.title}”尚未保存当前组的完整配置。`);
      continue;
    }
    const source = sources[0];
    if (!text(source.id) || dependencies.some(item => item.sessionId === source.id)) {
      issues.push(`内环“${stage.title}”的会话身份无效或重复。`);
      continue;
    }
    const sourceStages = resolveStages(source.plan);
    const prefix = stages.slice(0, stages.findIndex(entry => entry.id === stage.id) + 1);
    const sourcePrefix = sourceStages.stages.slice(0, sourceStages.index + 1).map(item => ({ id: item.id, structure: item.structure }));
    if (sourceStages.issues.length || canonical(sourcePrefix) !== canonical(prefix)) {
      issues.push(`内环“${stage.title}”的阶段顺序或结构定义已变化；请统一当前组拓扑。`);
      continue;
    }
    const inspected = cascadeStageConfigurationSignature(source.plan);
    if (!inspected.ready || !inspected.signature) {
      issues.push(...inspected.issues.map(issue => `内环“${stage.title}”：${issue}`));
      continue;
    }
    dependencies.push({ stageId: stage.id, sessionId: source.id, configSignature: inspected.signature });
  }
  if (issues.length) return { ready: false, snapshot: null, issues: [...new Set(issues)] };
  return { ready: true, snapshot: { version: 1, groupId, scenarioId: context.id, topologyId: context.topologyId, targetStageId: context.stageId, stages, dependencies }, issues: [] };
}

/** The caller explicitly stores the newly built snapshot when reconfirming a model. */
export function checkCascadeDependencySnapshot(input: CascadeDependencyInput & { boundSnapshot?: CascadeDependencySnapshot | null }): CascadeDependencyCheck {
  const current = buildCascadeDependencySnapshot(input);
  if (!current.ready || !current.snapshot) return current;
  const bound = input.boundSnapshot;
  if (!isCascadeDependencySnapshot(bound)) return { ...current, ready: false, issues: ['外环模型尚未绑定完整的前置内环配置，请核对后重新绑定。'] };
  const issues: string[] = [];
  if (bound.groupId !== current.snapshot.groupId || bound.scenarioId !== current.snapshot.scenarioId
    || bound.topologyId !== current.snapshot.topologyId || bound.targetStageId !== current.snapshot.targetStageId) issues.push('外环绑定的实验组、场景、拓扑或目标阶段不一致。');
  if (canonical(bound.stages) !== canonical(current.snapshot.stages)) issues.push('控制阶段顺序或结构已变化，请重新核对并绑定外环模型。');
  for (const expected of current.snapshot.dependencies) {
    const previous = bound.dependencies.find(item => item.stageId === expected.stageId);
    if (!previous || previous.sessionId !== expected.sessionId || previous.configSignature !== expected.configSignature) issues.push(`前置内环“${expected.stageId}”的来源或配置已变化，请重新核对外环模型与候选。`);
  }
  if (bound.dependencies.length !== current.snapshot.dependencies.length) issues.push('外环依赖的前置内环数量已变化。');
  return { ...current, ready: issues.length === 0, issues: [...new Set(issues)] };
}

/** Historic localStorage trials never substitute for this page's evidence Map. */
export function checkCascadeDeviceDependencies(input: CascadeDependencyInput & {
  boundSnapshot?: CascadeDependencySnapshot | null;
  generation: number;
  evidence: ReadonlyMap<string, CascadeRuntimeEvidence>;
}): CascadeDependencyCheck {
  const current = checkCascadeDependencySnapshot(input);
  if (!current.ready || !current.snapshot) return current;
  if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !(input.evidence instanceof Map)) return { ...current, ready: false, issues: ['缺少当前页面的有效设备会话与内环验收证据。'] };
  const issues: string[] = [];
  for (const dependency of current.snapshot.dependencies) {
    const proof = input.evidence.get(dependency.sessionId);
    if (!proof || proof.groupId !== current.snapshot.groupId || proof.sessionId !== dependency.sessionId
      || proof.scenarioId !== current.snapshot.scenarioId || proof.topologyId !== current.snapshot.topologyId
      || proof.stageId !== dependency.stageId || proof.configSignature !== dependency.configSignature
      || proof.generation !== input.generation || !text(proof.trialId)) {
      issues.push(`内环“${dependency.stageId}”缺少当前设备会话中与这份配置一致的已通过评价证据。`);
    }
  }
  return { ...current, ready: issues.length === 0, issues };
}
