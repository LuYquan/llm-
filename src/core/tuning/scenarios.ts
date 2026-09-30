import type { PidStructure, TransferFunctionModel } from '../control/types';
import { multiplyPolynomials, validatePlantModel } from '../control/transferFunction';

export type TuningScenarioId = 'balance-car' | 'flight-control' | 'custom';
export type ScenarioToolId = 'local.pid-solver' | 'ai.feedback-candidate';
export interface ScenarioPhysicalField {
  id: string;
  label: string;
  unit: string;
  description?: string;
  required: boolean;
  min?: number;
  max?: number;
  /** Empty/absent means every stage. */
  stageIds?: string[];
}
export interface ScenarioStage {
  id: string;
  title: string;
  structure: PidStructure;
  supportedStructures: PidStructure[];
}
export interface ScenarioTopology {
  id: string;
  title: string;
  description: string;
  /** Inner loop first. These are selectable stages, not a promise of automatic cascade tuning. */
  stages: ScenarioStage[];
}
export interface ScenarioSkill { id: string; title: string; instructions: string }
export interface TuningScenarioSuite {
  id: TuningScenarioId;
  version: 1;
  title: string;
  description: string;
  prompt: string;
  physicalModel: string;
  physicalFields: ScenarioPhysicalField[];
  topologies: ScenarioTopology[];
  skills: ScenarioSkill[];
  tools: ScenarioToolId[];
}
/** A reasoning model's proposal is declarative data. It never runs JavaScript. */
export interface TransferFunctionDraft {
  numerator: string[];
  denominator: string[];
  tau: string;
  physicalFields: ScenarioPhysicalField[];
  assumptions: string[];
  explanation?: string;
}
export interface TuningScenarioContext {
  id: TuningScenarioId;
  title: string;
  version: 1;
  topologyId: string;
  stageId: string;
  prompt: string;
  skills: ScenarioSkill[];
  tools: ScenarioToolId[];
  physicalInputs: Record<string, number | null>;
  modelOrigin: 'pending' | 'physical-inputs' | 'user-transfer-function' | 'ai-proposal';
  assumptions: string[];
  modelConfirmed: boolean;
  customStages?: ScenarioStage[];
  modelDraft?: TransferFunctionDraft;
}
export interface ScenarioPlantResult {
  status: 'ready' | 'needs-input' | 'unsupported';
  model: TransferFunctionModel | null;
  pendingInputs: string[];
  assumptions: string[];
  warnings: string[];
}

const structures: PidStructure[] = ['P', 'PI', 'PD', 'PID'];
const stage = (id: string, title: string, structure: PidStructure, supportedStructures: PidStructure[] = structures): ScenarioStage => ({ id, title, structure, supportedStructures: [...supportedStructures] });
const sharedPrompt = '只分析绑定的当前控制环及本轮串口遥测。分清用户输入、辨识结果、模型假设与设备确认值。候选必须通过本地计算、边界和当前证据检查。提示词不能绕过本地限幅、写入确认、遥测新鲜度、试验预算或停止规则；不编造测量或稳定性验收。';
const sharedSkills: ScenarioSkill[] = [
  { id: 'telemetry-evidence', title: '遥测证据检查', instructions: '按绑定的设定、反馈、输出变量及时间窗口解读数据；缺失、错单位、数据陈旧和饱和必须明确报告。' },
  { id: 'bounded-candidate', title: '有界参数建议', instructions: '每轮仅给当前控制环一个候选和可检验理由。不得执行脚本或直接写设备；由本地执行器检查范围、确认和停止。' },
  { id: 'model-assumptions', title: '模型假设核对', instructions: '列出模型的输入输出、单位、线性化工作点和忽略的动力学。模型建议需用户确认，不把离线结果当成硬件表现。' },
];
const field = (id: string, label: string, unit: string, stageIds: string[], description: string, min = 0): ScenarioPhysicalField => ({ id, label, unit, required: true, min, stageIds, description });

export const SCENARIO_SUITES: TuningScenarioSuite[] = [
  {
    id: 'balance-car', version: 1, title: '平衡车调参', description: '先直立，再速度；模型计算与遥测反馈共用当前串口和参数命令。',
    prompt: `${sharedPrompt} 平衡车直立模型开环不稳定；未确认稳定基线时禁止自动探索。确认角度符号、轮转方向与输入增益，外环开始前必须先验证内环。`,
    physicalModel: '小角度倒立摆近似：车轮合力矩使底座加速，质量、重心、惯量和执行器标定共同决定直立环。外速度环使用已验证内环和实测等效模型。',
    physicalFields: [
      field('body_mass', '车体质量', 'kg', ['upright'], '仅车体摆动部分的质量；不代替整车质量。'),
      field('total_mass', '整车等效移动质量', 'kg', ['upright'], '用于轮端力矩到水平加速度的简化关系，应不小于车体质量。'),
      field('center_height', '重心到轮轴高度', 'm', ['upright'], '竖直平衡附近的重心高度。'),
      field('body_inertia', '车体俯仰惯量', 'kg·m²', ['upright'], '绕车体重心的惯量，不能只凭质量猜测。'),
      field('wheel_radius', '轮半径', 'm', ['upright'], '实际滚动半径。'),
      field('torque_gain', '合轮端力矩 / 命令增益', 'N·m/命令单位', ['upright'], '含两轮合力矩的实测标定；带符号。', -Number.MAX_VALUE),
      field('pitch_damping', '等效俯仰阻尼', 'N·m·s/rad', ['upright'], '需用户测量或明确采用忽略阻尼假设。'),
      field('actuator_time', '执行器时间常数', 's', ['upright'], '明确采用瞬时执行器近似时可填 0。'),
      field('speed_gain', '等效速度 / 命令增益', 'm/s/命令单位', ['velocity'], '仅在直立内环已验证后测量，保留方向符号。', -Number.MAX_VALUE),
      field('speed_time', '等效速度时间常数', 's', ['velocity'], '从稳定内环上的速度试验取得。'),
      field('delay', '当前环实测纯滞后', 's', ['upright', 'velocity'], '串口传输时间不等同于下位机闭环滞后。'),
    ],
    topologies: [
      { id: 'upright', title: '单直立环', description: '只整定角度反馈环，确认轮向和角度符号。', stages: [stage('upright', '直立环', 'PD', ['PD', 'PID'])] },
      { id: 'upright-velocity', title: '直立 + 速度串级', description: '先验证直立内环，再处理速度外环；逐环设置通道和写入命令。', stages: [stage('upright', '直立内环', 'PD', ['PD', 'PID']), stage('velocity', '速度外环', 'PI', ['P', 'PI', 'PID'])] },
    ], skills: [...sharedSkills, { id: 'balance-safety', title: '平衡车环路核对', instructions: '识别倾倒、角度越界和轮速饱和；直立稳定基线未确认时只给解释和离线候选。' }], tools: ['local.pid-solver', 'ai.feedback-candidate'],
  },
  {
    id: 'flight-control', version: 1, title: '飞控调参', description: '围绕用户选定的一根轴，先角速度内环，再姿态外环。',
    prompt: `${sharedPrompt} 飞控按已选轴做单输入单输出近似，先验证坐标和角速度方向。只在用户已确认的地面安全试验条件下反馈调参；不要假设空中联调或三轴耦合已验证。`,
    physicalModel: '单轴刚体：J·dω/dt = 标定力矩 - 阻尼·ω，执行器用一阶滞后近似；姿态外环依赖已验证角速度内环带宽。',
    physicalFields: [
      field('axis_inertia', '当前轴转动惯量', 'kg·m²', ['rate'], '滚转、俯仰或偏航的实际惯量，各轴不可混用。'),
      field('torque_gain', '当前轴力矩 / 命令增益', 'N·m/命令单位', ['rate'], '实测标定，包含电机混控及方向符号。', -Number.MAX_VALUE),
      field('axis_damping', '当前轴等效阻尼', 'N·m·s/rad', ['rate'], '可明确填 0 采用无阻尼刚体假设。'),
      field('actuator_time', '电机 / 执行器时间常数', 's', ['rate'], '明确采用瞬时执行器近似时可填 0。'),
      field('inner_bandwidth', '已验证角速度内环带宽', 'rad/s', ['attitude'], '不能由尚未试验的 PID 候选代替实测闭环带宽。'),
      field('delay', '当前环实测纯滞后', 's', ['rate', 'attitude'], '仅填写当前控制环的有效滞后。'),
    ],
    topologies: [
      { id: 'rate', title: '单轴角速度环', description: '用当前选定轴的反馈与混控后的执行器命令。', stages: [stage('rate', '角速度环', 'PID', ['PI', 'PD', 'PID'])] },
      { id: 'rate-attitude', title: '角速度 + 姿态串级', description: '先验证角速度内环，再调整姿态外环。逐轴重复验收。', stages: [stage('rate', '角速度内环', 'PID', ['PI', 'PD', 'PID']), stage('attitude', '姿态外环', 'P', ['P', 'PI', 'PD', 'PID'])] },
    ], skills: [...sharedSkills, { id: 'flight-ground-test', title: '单轴地面试验核对', instructions: '确认轴、单位、坐标系、执行器限幅与地面试验条件；软件离线分析不提供飞行适航结论。' }], tools: ['local.pid-solver', 'ai.feedback-candidate'],
  },
  {
    id: 'custom', version: 1, title: '自定义调参', description: '构建自己的单环或串级，输入 s 域模型或请 AI 草拟模型与数据表。',
    prompt: `${sharedPrompt} 用户自定义控制结构、对象与约束。描述不足时先列待提供参数；模型推导必须声明假设和输入输出单位，确认后才能作为本地解算输入。`,
    physicalModel: '用户提供降幂排列的分子、分母系数和纯滞后，或由 AI 提出待确认的公式与物理数据字段。', physicalFields: [],
    topologies: [
      { id: 'single', title: '单控制环', description: '选择 P、PI、PD 或 PID。', stages: [stage('custom-loop', '自定义控制环', 'PID')] },
      { id: 'cascade', title: '自定义串级', description: '从最内环到最外环定义每个控制阶段；逐环绑定与验证。', stages: [stage('inner', '内环', 'PID'), stage('outer', '外环', 'PI')] },
    ], skills: [...sharedSkills], tools: ['local.pid-solver', 'ai.feedback-candidate'],
  },
];

export function getScenarioSuite(id: TuningScenarioId | string): TuningScenarioSuite | undefined {
  return SCENARIO_SUITES.find(suite => suite.id === id);
}

export function validateCustomStages(stages: readonly ScenarioStage[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 6) return ['请定义 1 到 6 个控制阶段。'];
  const seen = new Set<string>();
  for (const entry of stages) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(entry.id) || seen.has(entry.id)) errors.push('阶段 ID 需唯一，且由字母开头的字母、数字、下划线或短横线组成。');
    else seen.add(entry.id);
    if (typeof entry?.title !== 'string' || !entry.title.trim() || entry.title.length > 80) errors.push('每个阶段需填写不超过 80 字的名称。');
    if (!structures.includes(entry?.structure)) errors.push('阶段控制结构必须为 P、PI、PD 或 PID。');
  }
  return errors;
}

export function createScenarioContext(id: TuningScenarioId, topologyId?: string, stageId?: string, customStages?: ScenarioStage[]): TuningScenarioContext {
  const suite = getScenarioSuite(id);
  if (!suite) throw new Error('场景套组不存在。');
  const topology = suite.topologies.find(item => item.id === topologyId) ?? suite.topologies[0];
  const stages = customStages && id === 'custom' ? customStages : topology.stages;
  const errors = validateCustomStages(stages);
  if (errors.length) throw new Error(errors.join(' '));
  const selected = stages.find(item => item.id === stageId) ?? stages[0];
  return {
    id, title: suite.title, version: 1, topologyId: topology.id, stageId: selected.id,
    prompt: suite.prompt, skills: structuredClone(suite.skills), tools: [...suite.tools],
    physicalInputs: Object.fromEntries(suite.physicalFields.map(item => [item.id, null])),
    modelOrigin: 'pending', assumptions: [], modelConfirmed: false,
    ...(id === 'custom' ? { customStages: stages.map(stage => ({ id: stage.id, title: stage.title, structure: stage.structure, supportedStructures: [...stage.supportedStructures] })) } : {}),
  };
}

export function getScenarioPhysicalFields(id: TuningScenarioId, stageId: string): ScenarioPhysicalField[] {
  return (getScenarioSuite(id)?.physicalFields ?? []).filter(item => !item.stageIds?.length || item.stageIds.includes(stageId));
}

export function deriveScenarioPlant(id: TuningScenarioId, topologyId: string, stageId: string, inputs: Record<string, number | null>): ScenarioPlantResult {
  const suite = getScenarioSuite(id);
  const topology = suite?.topologies.find(item => item.id === topologyId);
  const unavailable: ScenarioPlantResult = { status: 'unsupported', model: null, pendingInputs: [], assumptions: [], warnings: ['当前场景与控制阶段不匹配。'] };
  if (!suite || !topology || !topology.stages.some(item => item.id === stageId)) return unavailable;
  if (id === 'custom') return { ...unavailable, warnings: ['自定义场景请提供 s 域传递函数，或生成并确认 AI 模型草稿。'] };
  const fields = getScenarioPhysicalFields(id, stageId);
  const pending = fields.filter(item => inputs[item.id] === null || inputs[item.id] === undefined).map(item => item.label);
  if (pending.length) return { status: 'needs-input', model: null, pendingInputs: pending, assumptions: [], warnings: [] };
  const warnings = fields.filter(item => !Number.isFinite(inputs[item.id]) || (item.min !== undefined && inputs[item.id]! < item.min) || (item.max !== undefined && inputs[item.id]! > item.max)).map(item => `${item.label}超出有效范围。`);
  const positive = (ids: string[]) => ids.forEach(key => { if (!(inputs[key]! > 0)) warnings.push(`${fields.find(item => item.id === key)?.label ?? key}必须大于 0。`); });
  const assumptions: string[] = ['输入为用户提供的物理数据，未由设备自动确认。', '模型为当前工作点的单输入单输出线性近似；离线结果需实测验证。'];
  let numerator: number[];
  let denominator: number[];
  if (id === 'balance-car' && stageId === 'upright') {
    positive(['body_mass', 'total_mass', 'center_height', 'body_inertia', 'wheel_radius']);
    if (inputs.total_mass! < inputs.body_mass!) warnings.push('整车等效移动质量不能小于车体质量。');
    if (inputs.torque_gain === 0) warnings.push('轮端力矩增益不能为 0。');
    const inertiaAtPivot = inputs.body_inertia! + inputs.body_mass! * inputs.center_height! ** 2;
    numerator = [-inputs.body_mass! * inputs.center_height! * inputs.torque_gain! / (inputs.total_mass! * inputs.wheel_radius!)];
    denominator = multiplyPolynomials([inertiaAtPivot, inputs.pitch_damping!, -inputs.body_mass! * 9.80665 * inputs.center_height!], inputs.actuator_time! > 0 ? [inputs.actuator_time!, 1] : [1]);
    assumptions.push('小角度、刚体、轮胎不打滑；忽略轮转动惯量和底座与摆杆之间的反作用耦合。', 'a≈合轮端力矩/(整车质量×轮半径)；角度随底座正向加速度反向偏转，必须核对实际控制方向。', '绕轮轴惯量=重心惯量+m·h²；重力加速度采用 9.80665 m/s²。');
    warnings.push('直立对象开环不稳定；先核对符号并离线验算，自动反馈需要已确认的稳定基线。');
  } else if (id === 'balance-car') {
    positive(['speed_time']);
    if (inputs.speed_gain === 0) warnings.push('速度增益不能为 0。');
    numerator = [inputs.speed_gain!]; denominator = [inputs.speed_time!, 1];
    assumptions.push('速度外环模型来自直立内环稳定后的等效实测增益与时间常数；不从质量单独推断。');
  } else if (stageId === 'rate') {
    positive(['axis_inertia']);
    if (inputs.torque_gain === 0) warnings.push('轴力矩增益不能为 0。');
    numerator = [inputs.torque_gain!];
    denominator = multiplyPolynomials([inputs.axis_inertia!, inputs.axis_damping!], inputs.actuator_time! > 0 ? [inputs.actuator_time!, 1] : [1]);
    assumptions.push('当前选定轴的刚体动力学，忽略三轴耦合、弹性与气动非线性；标定包含混控后的轴力矩。');
  } else {
    positive(['inner_bandwidth']);
    numerator = [1]; denominator = [1 / inputs.inner_bandwidth!, 1, 0];
    assumptions.push('已验证角速度内环近似为单位增益一阶闭环；外姿态是角速度积分。外环带宽应低于内环，逐环验收。');
  }
  const model: TransferFunctionModel = { family: 'transfer_function', numerator, denominator, tau: inputs.delay! };
  const errors = validatePlantModel(model);
  const inputErrors = warnings.filter(item => !item.startsWith('直立对象'));
  return errors.length || inputErrors.length
    ? { status: 'unsupported', model: null, pendingInputs: [], assumptions, warnings: [...warnings, ...errors] }
    : { status: 'ready', model, pendingInputs: [], assumptions, warnings };
}

export function parseTransferFunctionInput(numeratorText: string, denominatorText: string, tau: number): { model: TransferFunctionModel | null; errors: string[] } {
  const parse = (text: string): number[] => {
    const trimmed = text.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!trimmed || text.length > 1024) return [];
    return trimmed.split(/[\s,，;；]+/).map(token => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token) ? Number(token) : NaN);
  };
  const model: TransferFunctionModel = { family: 'transfer_function', numerator: parse(numeratorText), denominator: parse(denominatorText), tau };
  const errors = validatePlantModel(model);
  return { model: errors.length ? null : model, errors };
}

/** Small arithmetic grammar for AI model drafts; identifiers are numeric fields only. */
export function evaluateModelExpression(expression: string, inputs: Record<string, number | null>): number {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 256) throw new Error('模型公式为空或过长。');
  const tokens = expression.match(/(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z][A-Za-z0-9_]*|[()+\-*/^]|\S/g) ?? [];
  let at = 0;
  let depth = 0;
  const ensure = (value: number): number => { if (!Number.isFinite(value)) throw new Error('模型公式产生非有限结果。'); return value; };
  const primary = (): number => {
    if (++depth > 24) throw new Error('模型公式嵌套过深。');
    const token = tokens[at++];
    let value: number;
    if (token === '(') { value = sum(); if (tokens[at++] !== ')') throw new Error('模型公式括号不匹配。'); }
    else if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token ?? '')) value = Number(token);
    else if (token === 'sqrt' || token === 'abs') { if (tokens[at++] !== '(') throw new Error('函数需要括号。'); value = sum(); if (tokens[at++] !== ')') throw new Error('函数括号不匹配。'); value = token === 'sqrt' ? Math.sqrt(value) : Math.abs(value); }
    else if (token === 'pi') value = Math.PI;
    else if (token && /^[A-Za-z][A-Za-z0-9_]*$/.test(token) && Object.prototype.hasOwnProperty.call(inputs, token) && Number.isFinite(inputs[token])) value = inputs[token]!;
    else throw new Error(`未知或未填写的模型变量：${token ?? '空值'}。`);
    depth--; return ensure(value);
  };
  const power = (): number => { const base = primary(); return tokens[at] === '^' ? (at++, ensure(base ** unary())) : base; };
  const unary = (): number => tokens[at] === '+' ? (at++, unary()) : tokens[at] === '-' ? (at++, -unary()) : power();
  const product = (): number => { let value = unary(); while (tokens[at] === '*' || tokens[at] === '/') { const operation = tokens[at++]; const right = unary(); value = ensure(operation === '*' ? value * right : value / right); } return value; };
  const sum = (): number => { let value = product(); while (tokens[at] === '+' || tokens[at] === '-') { const operation = tokens[at++]; const right = product(); value = ensure(operation === '+' ? value + right : value - right); } return value; };
  const result = sum();
  if (at !== tokens.length) throw new Error(`不支持的公式内容：${tokens[at]}。`);
  return result;
}

export function materializeTransferFunctionDraft(draft: TransferFunctionDraft, inputs: Record<string, number | null>): ScenarioPlantResult {
  const failed = (message: string): ScenarioPlantResult => ({ status: 'unsupported', model: null, pendingInputs: [], assumptions: Array.isArray(draft?.assumptions) ? draft.assumptions : [], warnings: [message] });
  if (!draft || !Array.isArray(draft.physicalFields) || draft.physicalFields.length > 32 || !Array.isArray(draft.numerator) || !draft.numerator.length || draft.numerator.length > 9 || !Array.isArray(draft.denominator) || !draft.denominator.length || draft.denominator.length > 9) return failed('模型草稿结构或阶数不受支持。');
  if (!draft.physicalFields.every(item => item && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(item.id) && !['sqrt', 'abs', 'pi', 'constructor', '__proto__', 'prototype'].includes(item.id))) return failed('物理字段 ID 非法或与保留字冲突。');
  if (new Set(draft.physicalFields.map(item => item.id)).size !== draft.physicalFields.length) return failed('物理字段 ID 重复。');
  const pendingInputs = draft.physicalFields.filter(item => inputs[item.id] === null || inputs[item.id] === undefined).map(item => item.label);
  if (pendingInputs.length) return { status: 'needs-input', model: null, pendingInputs, assumptions: draft.assumptions, warnings: [] };
  const badField = draft.physicalFields.find(item => !Number.isFinite(inputs[item.id]) || (item.min !== undefined && inputs[item.id]! < item.min) || (item.max !== undefined && inputs[item.id]! > item.max));
  if (badField) return failed(`${badField.label}超出模型草稿有效范围。`);
  const values = Object.fromEntries(draft.physicalFields.map(item => [item.id, inputs[item.id]]));
  try {
    const model: TransferFunctionModel = { family: 'transfer_function', numerator: draft.numerator.map(expression => evaluateModelExpression(expression, values)), denominator: draft.denominator.map(expression => evaluateModelExpression(expression, values)), tau: evaluateModelExpression(draft.tau, values) };
    const errors = validatePlantModel(model);
    return errors.length ? failed(errors.join(' ')) : { status: 'ready', model, pendingInputs: [], assumptions: draft.assumptions, warnings: ['AI 模型草稿及物理输入仍需用户核对；系数通过检查不等于物理模型正确。'] };
  } catch (error) { return failed(error instanceof Error ? error.message : '模型公式计算失败。'); }
}
