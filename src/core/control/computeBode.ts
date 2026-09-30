/**
 * 波特图计算引擎 (compute_bode / computeBode)
 * 纯数学解析计算，支持 FOPDT / SOPDT / 积分+惯性 开环频率响应
 * 必须纳入离散化延迟：ZOH 保持与计算延时引入 e^{-1.5 s Ts} 纯滞后 (-1.5 ω Ts * 180 / π)
 * 精确计算剪切频率 ωc、相位裕度 γ、幅值裕度 GM
 */

import type {
  PlantModel,
  BodeOptions,
  BodePoint,
  BodeResult,
} from './types';
import { evaluatePolynomialAtImaginary, polynomialStability, validatePlantModel } from './transferFunction';

/**
 * 计算被控对象 G(jω) 在特定频率下的复数响应
 */
export function evalPlantFreq(
  plant: PlantModel,
  omega: number
): { mag: number; phaseRad: number } {
  const errors = validatePlantModel(plant, { allowZeroGain: true });
  if (errors.length) throw new Error(errors.join(' '));
  if (!Number.isFinite(omega) || omega <= 0) throw new Error('角频率必须大于 0。');
  const safeW = omega;
  const tau = plant.tau || 0;

  if (plant.family === 'transfer_function') {
    const numerator = evaluatePolynomialAtImaginary(plant.numerator, safeW);
    const denominator = evaluatePolynomialAtImaginary(plant.denominator, safeW);
    const divisor = Math.hypot(denominator.re, denominator.im);
    const mag = Math.hypot(numerator.re, numerator.im) / divisor;
    if (!(divisor > 0) || !Number.isFinite(mag)) throw new Error('当前频率处对象响应奇异或超出数值范围。');
    let phaseRad = Math.atan2(numerator.im, numerator.re) - Math.atan2(denominator.im, denominator.re);
    while (phaseRad > 0) phaseRad -= 2 * Math.PI;
    while (phaseRad <= -2 * Math.PI) phaseRad += 2 * Math.PI;
    return { mag, phaseRad: phaseRad - safeW * tau };
  }

  if (plant.family === 'fopdt') {
    const k = plant.k;
    const t = plant.t;
    const denomMag = Math.sqrt(1 + (safeW * t) * (safeW * t));
    const denomPhase = Math.atan2(safeW * t, 1);
    const kPhase = k >= 0 ? 0 : -Math.PI;

    const mag = Math.abs(k) / denomMag;
    const phaseRad = kPhase - denomPhase - safeW * tau;
    return { mag, phaseRad };
  }

  if (plant.family === 'sopdt') {
    const k = plant.k;
    const wn = plant.wn;
    const zeta = plant.zeta;
    const re = wn * wn - safeW * safeW;
    const im = 2 * zeta * wn * safeW;
    const denomMag = Math.sqrt(re * re + im * im);
    const denomPhase = Math.atan2(im, re);
    const kPhase = k >= 0 ? 0 : -Math.PI;

    const mag = (Math.abs(k) * wn * wn) / denomMag;
    const phaseRad = kPhase - denomPhase - safeW * tau;
    return { mag, phaseRad };
  }

  // plant.family === 'integral_lag'
  const k = plant.k;
  const t = plant.t;
  const denomMag = safeW * Math.sqrt(1 + (safeW * t) * (safeW * t));
  const denomPhase = Math.PI / 2 + Math.atan2(safeW * t, 1);
  const kPhase = k >= 0 ? 0 : -Math.PI;

  const mag = Math.abs(k) / denomMag;
  const phaseRad = kPhase - denomPhase - safeW * tau;
  return { mag, phaseRad };
}

/**
 * 计算控制器 C(jω) 在特定频率下的复数响应
 */
export function evalControllerFreq(
  pid: { kp: number; ki?: number; kd?: number; tf?: number },
  omega: number
): { mag: number; phaseRad: number; re: number; im: number } {
  const safeW = Math.max(1e-7, omega);
  const kp = pid.kp;
  const ki = pid.ki || 0;
  const kd = pid.kd || 0;
  const tf = Math.max(0, pid.tf || 0);

  let re = kp;
  let im = -ki / safeW;

  if (kd > 0) {
    if (tf > 0) {
      const denom = 1 + (safeW * tf) * (safeW * tf);
      re += (kd * safeW * safeW * tf) / denom;
      im += (kd * safeW) / denom;
    } else {
      im += kd * safeW;
    }
  }

  const mag = Math.sqrt(re * re + im * im);
  const phaseRad = Math.atan2(im, re);
  return { mag, phaseRad, re, im };
}

/**
 * 核心波特图计算入口
 */
export function computeBode(
  plant: PlantModel,
  pid: { kp: number; ki?: number; kd?: number; tf?: number },
  options: BodeOptions = {}
): BodeResult {
  const ts = Math.max(1e-6, options.sampleTime || 0.001);
  const tf = options.tf || pid.tf || 0;
  const pointsCount = options.pointsCount || 200;
  if (![pid.kp, pid.ki ?? 0, pid.kd ?? 0, tf].every(Number.isFinite) || tf < 0) throw new Error('控制器参数必须为有限数值，滤波时间常数不能为负。');
  if (!Number.isInteger(pointsCount) || pointsCount < 2 || pointsCount > 10000) throw new Error('波特图采样点数需为 2 到 10000 的整数。');
  if (options.sampleTime !== undefined && (!Number.isFinite(options.sampleTime) || options.sampleTime <= 0)) throw new Error('采样周期必须大于 0。');

  // 频率网格对数范围设置
  const nyquistW = Math.PI / ts;
  const omegaMin = Math.max(1e-3, options.omegaMin || 0.1);
  const omegaMax = Math.min(1e5, options.omegaMax || Math.min(10000, nyquistW * 1.5));
  if (!Number.isFinite(omegaMin) || !Number.isFinite(omegaMax) || omegaMax <= omegaMin) throw new Error('波特图频率范围必须为递增的有限正数。');

  const logMin = Math.log10(omegaMin);
  const logMax = Math.log10(omegaMax);
  const logStep = (logMax - logMin) / (pointsCount - 1);

  const curve: BodePoint[] = [];

  for (let i = 0; i < pointsCount; i++) {
    const w = Math.pow(10, logMin + i * logStep);

    // 1. 被控对象频率响应
    const gResp = evalPlantFreq(plant, w);
    const gMagDb = 20 * Math.log10(Math.max(1e-12, gResp.mag));
    const gPhaseDeg = (gResp.phaseRad * 180) / Math.PI;

    // 2. 控制器频率响应
    const cResp = evalControllerFreq({ ...pid, tf }, w);
    const cMagDb = 20 * Math.log10(Math.max(1e-12, cResp.mag));
    const cPhaseDeg = (cResp.phaseRad * 180) / Math.PI;

    // 3. 离散化采样保持 ZOH + 计算延时: e^{-1.5 s Ts}
    // 相位损失: -1.5 * ω * Ts * 180 / π
    const delayPhaseDeg = (-1.5 * w * ts * 180) / Math.PI;

    // 4. 开环传递函数 L(jω) = C(jω) * G(jω) * e^{-1.5 j ω Ts}
    const openLoopMag = cResp.mag * gResp.mag;
    const magDb = 20 * Math.log10(Math.max(1e-12, openLoopMag));
    const rawTotalPhaseDeg = cPhaseDeg + gPhaseDeg + delayPhaseDeg;

    curve.push({
      omega: Number(w.toFixed(5)),
      mag_db: Number(magDb.toFixed(3)),
      phase_deg: Number(rawTotalPhaseDeg.toFixed(3)),
      c_mag_db: Number(cMagDb.toFixed(3)),
      c_phase_deg: Number(cPhaseDeg.toFixed(3)),
      g_mag_db: Number(gMagDb.toFixed(3)),
      g_phase_deg: Number(gPhaseDeg.toFixed(3)),
      delay_phase_deg: Number(delayPhaseDeg.toFixed(3)),
    });
  }

  // 相位平滑展开 (Phase Unwrap) 消除 atan2 的 ±180° 跳变
  let phaseShift = 0;
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].phase_deg;
    let curr = curve[i].phase_deg + phaseShift;
    while (curr - prev > 180) {
      phaseShift -= 360;
      curr -= 360;
    }
    while (curr - prev < -180) {
      phaseShift += 360;
      curr += 360;
    }
    curve[i].phase_deg = Number(curr.toFixed(3));
  }

  // 5. 求解剪切频率 ωc (0 dB 穿越点) 与相位裕度 γ
  let omegaC: number | null = null;
  let phaseMargin: number | null = null;

  for (let i = 0; i < curve.length - 1; i++) {
    const p1 = curve[i];
    const p2 = curve[i + 1];
    if ((p1.mag_db >= 0 && p2.mag_db <= 0) || (p1.mag_db <= 0 && p2.mag_db >= 0)) {
      // 对数线性插值精准求解 ωc
      const logW1 = Math.log10(p1.omega);
      const logW2 = Math.log10(p2.omega);
      const dMag = p2.mag_db - p1.mag_db;
      const frac = Math.abs(dMag) > 1e-9 ? (0 - p1.mag_db) / dMag : 0.5;
      const logWc = logW1 + frac * (logW2 - logW1);
      omegaC = Math.pow(10, logWc);

      // 插值计算 ωc 处的相角
      const phaseAtWc = p1.phase_deg + frac * (p2.phase_deg - p1.phase_deg);
      // 相位裕度: γ = 180° + ∠L(jωc)
      let pm = 180 + phaseAtWc;
      // 规范到 [-180, 180] 视角
      while (pm < -180) pm += 360;
      while (pm > 180) pm -= 360;
      phaseMargin = Number(pm.toFixed(2));
      break;
    }
  }

  // 6. 求解穿越频率 ωπ (-180° 向下穿越点) 与幅值裕度 GM
  let omegaPi: number | null = null;
  let gainMarginDb: number | null = null;

  for (let i = 0; i < curve.length - 1; i++) {
    const p1 = curve[i];
    const p2 = curve[i + 1];
    // 严格定位相位向下穿过 -180° 的穿越点 (排除低频超前抬升段)
    if (p1.phase_deg >= -180 && p2.phase_deg <= -180 && (omegaC === null || p2.omega >= omegaC * 0.5)) {
      const dPhase = p2.phase_deg - p1.phase_deg;
      const frac = Math.abs(dPhase) > 1e-9 ? (-180 - p1.phase_deg) / dPhase : 0.5;
      const logW1 = Math.log10(p1.omega);
      const logW2 = Math.log10(p2.omega);
      const logWpi = logW1 + frac * (logW2 - logW1);
      omegaPi = Math.pow(10, logWpi);

      // 插值计算 ωπ 处的幅值
      const magAtWpi = p1.mag_db + frac * (p2.mag_db - p1.mag_db);
      gainMarginDb = Number((-magAtWpi).toFixed(2));
      break;
    }
  }

  // 7. 闭环稳定性判据: 相位裕度 > 0 且幅值裕度 > 0 (最小相位系统经典判据)
  // Without a 0 dB crossover there is no phase-margin experiment to support
  // a stability claim. Keep this as unknown instead of presenting a low-gain
  // or empty model as a confirmed unstable system.
  const rationalMarginsCanCertify = plant.family !== 'transfer_function'
    || (['stable', 'marginal'].includes(polynomialStability(plant.denominator)) && polynomialStability(plant.numerator) === 'stable');
  const isStable = phaseMargin === null || !rationalMarginsCanCertify
    ? null
    : phaseMargin > 0 && (gainMarginDb === null || gainMarginDb > 0);

  return {
    curve,
    omega_c: omegaC !== null ? Number(omegaC.toFixed(4)) : null,
    phase_margin: phaseMargin,
    omega_pi: omegaPi !== null ? Number(omegaPi.toFixed(4)) : null,
    gain_margin_db: gainMarginDb !== null ? gainMarginDb : (omegaPi === null ? Infinity : null),
    is_stable: isStable,
  };
}

export const compute_bode = computeBode;
