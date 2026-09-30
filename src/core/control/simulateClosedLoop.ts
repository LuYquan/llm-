/**
 * 时域离散闭环阶跃仿真引擎 (simulate_closed_loop / simulateClosedLoop)
 * 纯数学数值仿真，支持 FOPDT / SOPDT / 积分+惯性
 * 内置单片机离散 PID、积分抗饱和 (Anti-Windup)、输出限幅与纯滞后缓冲
 * 先仿真出预测超调量与调节时间，杜绝大模型口头空头承诺
 */

import type {
  SimulateClosedLoopOptions,
  SimulateClosedLoopResult,
} from './types';
import { extract_step_features } from '../analysis/extractStepFeatures';
import { createTransferFunctionRealization, validatePlantModel } from './transferFunction';

export function simulateClosedLoop(
  options: SimulateClosedLoopOptions
): SimulateClosedLoopResult {
  const { plant, pid, sampleTime } = options;
  const modelErrors = validatePlantModel(plant);
  if (modelErrors.length) throw new Error(modelErrors.join(' '));
  if (!Number.isFinite(sampleTime) || sampleTime <= 0 || ![pid.kp, pid.ki ?? 0, pid.kd ?? 0, pid.tf ?? 0].every(Number.isFinite) || (pid.tf ?? 0) < 0) throw new Error('仿真采样周期或控制器参数无效。');
  const ts = sampleTime;
  const kp = pid.kp;
  const ki = pid.ki || 0;
  const kd = pid.kd || 0;
  const tf = Math.max(0, pid.tf || 0);

  const stepVal = options.stepValue !== undefined ? options.stepValue : 1.0;
  const y0 = options.initialValue !== undefined ? options.initialValue : 0.0;
  const limits = options.outputLimits || [-100, 100];
  const uMin = limits[0];
  const uMax = limits[1];
  const antiWindup = options.antiWindup !== undefined ? options.antiWindup : true;
  const shouldCancel = options.shouldCancel;
  if (![stepVal, y0, uMin, uMax].every(Number.isFinite) || uMin >= uMax) throw new Error('仿真阶跃、初值或输出限幅无效。');

  // 估算合适仿真时长: 至少 5~10 倍对象响应时间
  let plantT = 0.5;
  if (plant.family === 'fopdt' || plant.family === 'integral_lag') {
    plantT = plant.t + (plant.tau || 0);
  } else if (plant.family === 'sopdt') {
    plantT = 4.0 / Math.max(0.1, plant.wn * plant.zeta) + (plant.tau || 0);
  }
  const defaultSimTime = Math.max(1.0, Math.min(20.0, plantT * 8));
  const simTime = options.simTime !== undefined ? options.simTime : defaultSimTime;
  if (!Number.isFinite(simTime) || simTime <= 0 || simTime / ts > 1e6 || plant.tau / ts > 1e6) throw new Error('仿真时长或滞后缓冲超出当前计算预算。');

  const totalSteps = Math.ceil(simTime / ts) + 1;
  const times: number[] = new Array(totalSteps);
  const references: number[] = new Array(totalSteps);
  const values: number[] = new Array(totalSteps);
  const controls: number[] = new Array(totalSteps);

  // 状态变量初始化
  let x1 = y0;
  let x2 = 0;
  let integral = 0;
  let prevErr = stepVal - y0;
  let prevD = 0;
  const realization = plant.family === 'transfer_function' ? createTransferFunctionRealization(plant) : null;
  let heldPlantInput = 0;

  // 纯滞后缓冲队列 (以 Ts 为网格采样)
  const delaySteps = Math.max(0, Math.round((plant.tau || 0) / ts));
  const delayBuffer: number[] = new Array(delaySteps + 1).fill(0);
  let delayIdx = 0;

  const plantRateBound = realization?.rateBound ?? (plant.family === 'sopdt' ? Math.max(plant.wn, 2 * plant.zeta * plant.wn) : plant.family === 'fopdt' || plant.family === 'integral_lag' ? 2 / plant.t : 0);
  const subSteps = Math.max(8, Math.ceil(ts * plantRateBound / 0.3));
  if (subSteps > 2048 || totalSteps * subSteps > 8e6) throw new Error('模型过于刚性或仿真预算不足；请缩短仿真、调整采样或缩放模型。');
  const h = ts / subSteps;

  for (let k = 0; k < totalSteps; k++) {
    if (shouldCancel && (k & 0xff) === 0 && shouldCancel()) {
      throw new Error('ANALYSIS_CANCELLED');
    }
    const t = k * ts;
    if (realization) x1 = y0 + realization.output(heldPlantInput);
    if (!Number.isFinite(x1) || Math.abs(x1 - y0) > 1e12) throw new Error('闭环仿真发散或超出模型有效数值范围，未生成稳定性结论。');
    times[k] = Number(t.toFixed(5));
    references[k] = stepVal;
    values[k] = Number(x1.toFixed(5));

    // 1. 离散 PID 控制器计算
    const err = stepVal - x1;

    // 候选积分增量
    const integralCandidate = integral + ki * ts * err;

    // 微分项 (带一阶低通滤波)
    let deriv = 0;
    if (kd > 0) {
      if (tf > 0) {
        const alpha = tf / (tf + ts);
        deriv = alpha * prevD + (kd / (tf + ts)) * (err - prevErr);
        prevD = deriv;
      } else {
        deriv = (kd / ts) * (err - prevErr);
      }
    }

    const uRaw = kp * err + integralCandidate + deriv;

    // 输出限幅
    const uClamped = Math.max(uMin, Math.min(uMax, uRaw));

    // 积分抗饱和逻辑 (Anti-Windup):
    // 若饱和且误差方向相同 (继续加深饱和)，则冻结积分
    if (antiWindup) {
      const isSaturatedHigh = uRaw > uMax && err > 0;
      const isSaturatedLow = uRaw < uMin && err < 0;
      if (!isSaturatedHigh && !isSaturatedLow) {
        integral = integralCandidate;
      }
    } else {
      integral = integralCandidate;
    }

    prevErr = err;
    controls[k] = Number(uClamped.toFixed(4));

    // 2. 存入纯延时队列
    delayBuffer[delayIdx] = uClamped;
    const uPlantInput = delayBuffer[(delayIdx + 1) % delayBuffer.length];
    delayIdx = (delayIdx + 1) % delayBuffer.length;

    // 3. RK4 亚步数值积分驱动物理对象
    for (let sub = 0; sub < subSteps; sub++) {
      if (plant.family === 'fopdt') {
        const safeT = plant.t;
        // dx = (- (x - y0) + k * u) / T
        const f = (xVal: number) => (-(xVal - y0) + plant.k * uPlantInput) / safeT;
        const k1 = f(x1);
        const k2 = f(x1 + 0.5 * h * k1);
        const k3 = f(x1 + 0.5 * h * k2);
        const k4 = f(x1 + h * k3);
        x1 += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      } else if (plant.family === 'sopdt') {
        const safeWn = plant.wn;
        const f1 = (_x1: number, x2Val: number) => x2Val;
        const f2 = (x1Val: number, x2Val: number) =>
          -2 * plant.zeta * safeWn * x2Val -
          safeWn * safeWn * (x1Val - y0) +
          plant.k * safeWn * safeWn * uPlantInput;

        const k1_1 = f1(x1, x2);
        const k1_2 = f2(x1, x2);

        const k2_1 = f1(x1 + 0.5 * h * k1_1, x2 + 0.5 * h * k1_2);
        const k2_2 = f2(x1 + 0.5 * h * k1_1, x2 + 0.5 * h * k1_2);

        const k3_1 = f1(x1 + 0.5 * h * k2_1, x2 + 0.5 * h * k2_2);
        const k3_2 = f2(x1 + 0.5 * h * k2_1, x2 + 0.5 * h * k2_2);

        const k4_1 = f1(x1 + h * k3_1, x2 + h * k3_2);
        const k4_2 = f2(x1 + h * k3_1, x2 + h * k3_2);

        x1 += (h / 6) * (k1_1 + 2 * k2_1 + 2 * k3_1 + k4_1);
        x2 += (h / 6) * (k1_2 + 2 * k2_2 + 2 * k3_2 + k4_2);
      } else if (plant.family === 'integral_lag') {
        // integral_lag
        const safeT = plant.t;
        const f1 = (_x1: number, x2Val: number) => x2Val;
        const f2 = (_x1: number, x2Val: number) => (-x2Val + plant.k * uPlantInput) / safeT;

        const k1_1 = f1(x1, x2);
        const k1_2 = f2(x1, x2);

        const k2_1 = f1(x1 + 0.5 * h * k1_1, x2 + 0.5 * h * k1_2);
        const k2_2 = f2(x1 + 0.5 * h * k1_1, x2 + 0.5 * h * k1_2);

        const k3_1 = f1(x1 + 0.5 * h * k2_1, x2 + 0.5 * h * k2_2);
        const k3_2 = f2(x1 + 0.5 * h * k2_1, x2 + 0.5 * h * k2_2);

        const k4_1 = f1(x1 + h * k3_1, x2 + h * k3_2);
        const k4_2 = f2(x1 + h * k3_1, x2 + h * k3_2);

        x1 += (h / 6) * (k1_1 + 2 * k2_1 + 2 * k3_1 + k4_1);
        x2 += (h / 6) * (k1_2 + 2 * k2_2 + 2 * k3_2 + k4_2);
      } else if (realization) {
        realization.advance(uPlantInput, h);
      }
    }
    heldPlantInput = uPlantInput;
  }

  // 4. 调用特征提取服务得出标准控制指标
  const rawMetrics = extract_step_features(times, values, stepVal, {
    bandPercent: 0.02,
    minSustainSeconds: Math.min(0.2, simTime * 0.1),
    stepTime: 0,
  });

  return {
    times,
    references,
    values,
    controls,
    metrics: rawMetrics,
    metrics_error: rawMetrics ? null : '仿真样本不足或阶跃分析前提不满足，指标未计算',
  };
}

export const simulate_closed_loop = simulateClosedLoop;
