import type { PlantModel, TransferFunctionModel } from './types';

export const MAX_TRANSFER_FUNCTION_ORDER = 8;
export type PolynomialStability = 'stable' | 'unstable' | 'marginal' | 'unknown';

export function trimLeadingZeros(coefficients: readonly number[]): number[] {
  let first = 0;
  while (first < coefficients.length - 1 && coefficients[first] === 0) first++;
  return coefficients.slice(first);
}

/** Exact arithmetic shape checks; no coefficient is silently repaired. */
export function validatePlantModel(plant: PlantModel | null | undefined, options: { allowZeroGain?: boolean } = {}): string[] {
  if (!plant || typeof plant !== 'object') return ['尚无对象模型。'];
  const errors: string[] = [];
  if (!Number.isFinite(plant.tau) || plant.tau < 0) errors.push('对象纯滞后必须是非负有限数值。');
  if (plant.family === 'transfer_function') {
    const numerator = plant.numerator;
    const denominator = plant.denominator;
    if (!Array.isArray(numerator) || !numerator.length || !numerator.every(Number.isFinite)) errors.push('分子系数必须是非空有限数值数组。');
    if (!Array.isArray(denominator) || !denominator.length || !denominator.every(Number.isFinite)) errors.push('分母系数必须是非空有限数值数组。');
    if (errors.length) return errors;
    const num = trimLeadingZeros(numerator);
    const den = trimLeadingZeros(denominator);
    if (denominator[0] === 0) errors.push('分母最高次系数不能为 0；请删除无意义的前导零。');
    if (den.every(value => value === 0)) errors.push('分母不能是零多项式。');
    if (!options.allowZeroGain && num.every(value => value === 0)) errors.push('分子不能是零多项式。');
    if (num.length > den.length) errors.push('非真有理传递函数需要输入微分，当前离线工具不支持。');
    if (den.length - 1 > MAX_TRANSFER_FUNCTION_ORDER) errors.push(`当前离线工具支持最高 ${MAX_TRANSFER_FUNCTION_ORDER} 阶对象。`);
    if (num.concat(den).some(value => !Number.isFinite(value / den[0]))) errors.push('系数量级无法可靠归一化。');
    const nonzero = num.concat(den).map(Math.abs).filter(value => value > 0);
    if (nonzero.length && Math.max(...nonzero) / Math.min(...nonzero) > 1e16) errors.push('系数量级相差过大，需先缩放单位或化简模型。');
    return errors;
  }
  if (!['fopdt', 'sopdt', 'integral_lag'].includes(plant.family)) return ['对象模型类型不受支持。'];
  if (!Number.isFinite(plant.k) || (!options.allowZeroGain && Math.abs(plant.k) < 1e-12)) errors.push('对象模型增益必须是非零有限数值。');
  if (plant.family === 'sopdt') {
    if (!Number.isFinite(plant.wn) || plant.wn <= 0) errors.push('固有频率必须大于 0。');
    if (!Number.isFinite(plant.zeta) || plant.zeta <= 0) errors.push('阻尼比必须大于 0。');
  } else if (!Number.isFinite(plant.t) || plant.t <= 0) errors.push('时间常数必须大于 0。');
  return errors;
}

/** High-frequency input/output polarity; this is not a DC gain claim for unstable plants. */
export function getPlantControlGain(plant: PlantModel): number {
  return plant.family === 'transfer_function'
    ? trimLeadingZeros(plant.numerator)[0] / plant.denominator[0]
    : plant.k;
}

export function withPlantGainMultiplier(plant: PlantModel, multiplier: number): PlantModel {
  if (!Number.isFinite(multiplier)) throw new Error('对象增益缩放必须是有限数值。');
  return plant.family === 'transfer_function'
    ? { ...plant, numerator: plant.numerator.map(value => value * multiplier), denominator: [...plant.denominator] }
    : { ...plant, k: plant.k * multiplier };
}

export function toTransferFunction(plant: PlantModel): TransferFunctionModel {
  if (plant.family === 'transfer_function') return { ...plant, numerator: trimLeadingZeros(plant.numerator), denominator: [...plant.denominator] };
  if (plant.family === 'fopdt') return { family: 'transfer_function', numerator: [plant.k], denominator: [plant.t, 1], tau: plant.tau };
  if (plant.family === 'sopdt') return { family: 'transfer_function', numerator: [plant.k * plant.wn ** 2], denominator: [1, 2 * plant.zeta * plant.wn, plant.wn ** 2], tau: plant.tau };
  return { family: 'transfer_function', numerator: [plant.k], denominator: [plant.t, 1, 0], tau: plant.tau };
}

export function multiplyPolynomials(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(a.length + b.length - 1).fill(0);
  a.forEach((av, ai) => b.forEach((bv, bi) => { result[ai + bi] += av * bv; }));
  return trimLeadingZeros(result);
}

export function addPolynomials(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(Math.max(a.length, b.length)).fill(0);
  a.forEach((value, i) => { result[result.length - a.length + i] += value; });
  b.forEach((value, i) => { result[result.length - b.length + i] += value; });
  return trimLeadingZeros(result);
}

/** Routh sufficient/exact test for nonsingular rows. Singular tables remain unknown. */
export function polynomialStability(coefficients: readonly number[]): PolynomialStability {
  const trimmed = trimLeadingZeros(coefficients);
  if (!trimmed.length || !trimmed.every(Number.isFinite) || trimmed[0] === 0) return 'unknown';
  const normalized = trimmed.map(value => value / trimmed[0]);
  if (normalized.length === 1) return 'stable';
  if (normalized[normalized.length - 1] === 0) {
    const reduced = normalized.slice(0, -1);
    const status = polynomialStability(reduced);
    return status === 'stable' || status === 'marginal' ? 'marginal' : status;
  }
  if (normalized.some(value => value < 0)) return 'unstable';
  const columns = Math.ceil(normalized.length / 2);
  let previous = Array.from({ length: columns }, (_, i) => normalized[2 * i] ?? 0);
  let current = Array.from({ length: columns }, (_, i) => normalized[2 * i + 1] ?? 0);
  for (let row = 2; row < normalized.length; row++) {
    const scale = Math.max(1, ...previous.map(Math.abs), ...current.map(Math.abs));
    if (Math.abs(current[0]) <= 1e-12 * scale) return 'unknown';
    if (current[0] < 0) return 'unstable';
    const next = Array.from({ length: columns }, (_, i) => (current[0] * (previous[i + 1] ?? 0) - previous[0] * (current[i + 1] ?? 0)) / current[0]);
    if (!next.every(Number.isFinite)) return 'unknown';
    if (next[0] < -1e-12 * Math.max(1, ...next.map(Math.abs))) return 'unstable';
    previous = current;
    current = next;
  }
  return current[0] > 0 ? 'stable' : 'unknown';
}

export function closedLoopPolynomial(plant: PlantModel, pid: { kp: number; ki?: number; kd?: number; tf?: number }): number[] {
  const transfer = toTransferFunction(plant);
  const ki = pid.ki ?? 0;
  const kd = pid.kd ?? 0;
  const tf = pid.tf ?? 0;
  let numerator = trimLeadingZeros(tf > 0 ? [pid.kp * tf + kd, pid.kp + ki * tf, ki] : [kd, pid.kp, ki]);
  let denominator = tf > 0 ? [tf, 1, 0] : [1, 0];
  if (ki === 0) {
    numerator = numerator.slice(0, -1);
    denominator = denominator.slice(0, -1);
  }
  return addPolynomials(multiplyPolynomials(transfer.denominator, denominator), multiplyPolynomials(transfer.numerator, numerator));
}

export function evaluatePolynomialAtImaginary(coefficients: readonly number[], omega: number): { re: number; im: number } {
  let re = coefficients[0];
  let im = 0;
  for (let i = 1; i < coefficients.length; i++) {
    const nextRe = coefficients[i] - im * omega;
    im = re * omega;
    re = nextRe;
  }
  return { re, im };
}

/** Controllable canonical realization under a held input. Initial state is zero around the supplied bias. */
export function createTransferFunctionRealization(plant: TransferFunctionModel): {
  output: (input: number) => number;
  advance: (input: number, seconds: number) => void;
  rateBound: number;
} {
  const errors = validatePlantModel(plant);
  if (errors.length) throw new Error(errors.join(' '));
  const den = plant.denominator.map(value => value / plant.denominator[0]);
  const normalizedNum = plant.numerator.map(value => value / plant.denominator[0]);
  const num = new Array<number>(den.length - normalizedNum.length).fill(0).concat(normalizedNum);
  const degree = den.length - 1;
  const feedthrough = num[0];
  const outputFactors = Array.from({ length: degree }, (_, i) => num[degree - i] - feedthrough * den[degree - i]);
  let state = new Array<number>(degree).fill(0);
  const derivative = (values: number[], input: number): number[] => values.map((_, i) => i < degree - 1 ? values[i + 1] : input - values.reduce((sum, value, at) => sum + den[degree - at] * value, 0));
  const rateBound = degree ? 2 * Math.max(1, ...den.slice(1).map((value, i) => Math.abs(value) ** (1 / (i + 1)))) : 0;
  return {
    rateBound,
    output: input => state.reduce((sum, value, i) => sum + outputFactors[i] * value, feedthrough * input),
    advance(input, seconds) {
      if (!degree) return;
      const k1 = derivative(state, input);
      const k2 = derivative(state.map((value, i) => value + seconds * k1[i] / 2), input);
      const k3 = derivative(state.map((value, i) => value + seconds * k2[i] / 2), input);
      const k4 = derivative(state.map((value, i) => value + seconds * k3[i]), input);
      state = state.map((value, i) => value + seconds * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6);
      if (!state.every(Number.isFinite)) throw new Error('传递函数数值积分发散；请检查模型、采样周期和工作点。');
    },
  };
}
