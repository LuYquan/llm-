/** Deterministic frequency-domain PID candidate calculation, followed by explicit offline checks. */
import type { PlantModel, PidStructure, SolvePidOptions, SolvePidResult } from './types';
import { computeBode, evalControllerFreq, evalPlantFreq } from './computeBode';
import { closedLoopPolynomial, polynomialStability, validatePlantModel } from './transferFunction';

export function solvePid(plant: PlantModel, options: SolvePidOptions): SolvePidResult {
  const structure: PidStructure = options.structure ?? 'PID';
  const ts = options.sampleTime ?? 0.001;
  const targetWc = options.target_omega_c;
  const targetPm = options.target_phase_margin;
  const beta = options.pidRatioTdOverTi ?? 0.25;
  const wd = options.derivativeCornerFrequency;
  const tf = options.tf ?? 0;
  const fail = (message: string): SolvePidResult => ({ success: false, kp: 0, ki: 0, kd: 0, tf, structure, message });
  const errors = validatePlantModel(plant);
  if (errors.length) return fail(errors.join(' '));
  if (!['P', 'PI', 'PD', 'PID'].includes(structure)) return fail('控制结构不受支持。');
  if (![targetWc, targetPm, ts, beta, tf].every(Number.isFinite) || targetWc <= 0 || ts <= 0 || tf < 0 || beta <= 0 || targetPm <= 0 || targetPm >= 180) return fail('目标频率、相位裕度、采样周期或 PID 约束无效。');
  if (wd !== undefined && (!Number.isFinite(wd) || wd <= 0)) return fail('微分转折频率必须大于 0。');
  if (targetWc > 0.2 * Math.PI / ts) return fail('目标剪切频率超过当前采样频率的十分之一，请降低目标带宽。');
  let gResp: { mag: number; phaseRad: number };
  try { gResp = evalPlantFreq(plant, targetWc); }
  catch (error) { return fail(error instanceof Error ? error.message : '对象频域响应计算失败。'); }
  if (!(gResp.mag > 1e-12) || !Number.isFinite(gResp.mag)) return fail('目标频率处对象增益太小或响应奇异，无法可靠解算。');
  const gPhaseDeg = gResp.phaseRad * 180 / Math.PI;
  const delayPhaseDeg = -1.5 * targetWc * ts * 180 / Math.PI;
  let requiredPhase = targetPm - 180 - gPhaseDeg - delayPhaseDeg;
  while (requiredPhase > 180) requiredPhase -= 360;
  while (requiredPhase < -180) requiredPhase += 360;
  const requiredMag = 1 / gResp.mag;
  const real = requiredMag * Math.cos(requiredPhase * Math.PI / 180);
  const imaginary = requiredMag * Math.sin(requiredPhase * Math.PI / 180);
  const q = 1 + (targetWc * tf) ** 2;
  const derivativeReal = targetWc ** 2 * tf / q;
  const derivativeImaginary = targetWc / q;
  let kp = 0;
  let ki = 0;
  let kd = 0;
  if (structure === 'P') {
    if (Math.abs(requiredPhase) > 2) return fail(`纯 P 无法同时达到指定带宽与相位裕度；目标需控制器补偿 ${requiredPhase.toFixed(1)}°。`);
    kp = requiredMag;
  } else if (structure === 'PI') {
    if (real <= 0 || imaginary > requiredMag * 1e-9) return fail('当前目标需要超前相位或负比例增益，PI 无正增益解；调整目标或控制结构。');
    kp = real;
    ki = Math.max(0, -targetWc * imaginary);
  } else if (structure === 'PD') {
    if (imaginary < -requiredMag * 1e-9) return fail('当前目标需要滞后相位，PD 无正增益解；调整目标或控制结构。');
    kd = Math.max(0, imaginary / derivativeImaginary);
    kp = real - derivativeReal * kd;
    if (kp <= 0) return fail('微分滤波削弱了可用超前相位，当前 PD 目标无正比例增益解。');
  } else if (wd !== undefined) {
    kp = real / (1 + derivativeReal / wd);
    kd = kp / wd;
    ki = targetWc * (derivativeImaginary * kd - imaginary);
    if (kp <= 0 || ki <= 0 || kd <= 0) return fail('指定微分转折频率与当前目标、滤波时间常数不相容，PID 无正增益解。');
  } else {
    const a = targetWc * derivativeImaginary - beta * derivativeReal ** 2;
    const b = 2 * beta * real * derivativeReal - targetWc * imaginary;
    const c = -beta * real ** 2;
    const candidates: number[] = [];
    if (Math.abs(a) < 1e-12 * Math.max(1, Math.abs(b), Math.abs(c))) {
      if (b !== 0) candidates.push(-c / b);
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const stableQ = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant));
        if (stableQ !== 0) candidates.push(stableQ / a, c / stableQ);
      }
    }
    const chosen = candidates.filter(value => Number.isFinite(value) && value > 0 && real - derivativeReal * value > 0 && derivativeImaginary * value - imaginary > 0).sort((left, right) => left - right)[0];
    if (chosen === undefined) return fail('当前带宽、相位目标和滤波约束下，PID 无可验证的正实数解。');
    kd = chosen;
    kp = real - derivativeReal * kd;
    ki = targetWc * (derivativeImaginary * kd - imaginary);
  }
  if (![kp, ki, kd].every(Number.isFinite) || kp <= 0 || ki < 0 || kd < 0) return fail('解算产生了无效控制器参数。');
  [kp, ki, kd] = [kp, ki, kd].map(value => Number(value.toPrecision(12)));
  const controller = evalControllerFreq({ kp, ki, kd, tf }, targetWc);
  const expectedPhase = 180 + (controller.phaseRad + gResp.phaseRad) * 180 / Math.PI + delayPhaseDeg;
  let phaseError = expectedPhase - targetPm;
  while (phaseError > 180) phaseError -= 360;
  while (phaseError < -180) phaseError += 360;
  if (Math.abs(controller.mag * gResp.mag - 1) > 1e-6 || Math.abs(phaseError) > (structure === 'P' ? 2 : 0.01)) return fail('参数代入后未达到指定频域目标，候选已拒绝。');
  if (polynomialStability(closedLoopPolynomial(plant, { kp, ki, kd, tf })) !== 'stable') return fail('闭环特征多项式未通过稳定性检查；单个频率处相位裕度不能证明该对象稳定。');
  if (plant.family === 'transfer_function' && plant.tau > 0 && polynomialStability(plant.denominator) === 'unstable') return fail('含纯滞后的开环不稳定自定义对象需要完整延时稳定性分析，当前闭式解算不足以确认候选。');
  let bode;
  try {
    bode = computeBode(plant, { kp, ki, kd, tf }, { sampleTime: ts, tf, omegaMin: targetWc * 0.01, omegaMax: Math.min(targetWc * 100, Math.PI / ts), pointsCount: 500 });
  } catch (error) { return fail(error instanceof Error ? error.message : '参数代入重算失败。'); }
  if (bode.omega_c === null || bode.phase_margin === null || Math.abs(bode.omega_c - targetWc) > targetWc * 0.03 || Math.abs(bode.phase_margin - targetPm) > 2 || bode.phase_margin <= 0 || (bode.gain_margin_db !== null && bode.gain_margin_db <= 0)) return fail('完整频率扫描未复现目标或裕度不足，可能存在多次穿越；候选已拒绝。');
  return {
    success: true, kp, ki, kd, tf, structure,
    achieved_omega_c: bode.omega_c, achieved_phase_margin: bode.phase_margin,
    message: `${structure} 离线候选已通过目标代入、闭环多项式及频率扫描：Kp=${kp}, Ki=${ki}, Kd=${kd}。`,
    warnings: ['验算基于线性模型和采样延迟近似，不代表设备已写入、离散固件一致或硬件稳定性验收。'],
  };
}

export const solve_pid = solvePid;
