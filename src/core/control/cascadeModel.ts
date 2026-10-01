import type { ControllerParams, PlantModel, TransferFunctionModel } from './types';
import { addPolynomials, multiplyPolynomials, polynomialStability, toTransferFunction, trimLeadingZeros, validatePlantModel } from './transferFunction';

function requireValidPlant(model: PlantModel): void {
  const errors = validatePlantModel(model);
  if (errors.length) throw new Error(errors.join(' '));
}

/**
 * Nominal continuous 1DOF parallel PID: Kp + Ki/s + Kd*s/(Tf*s + 1).
 * The derivative acts on error. sampleTime is metadata, not a discretization;
 * this calculation does not establish equivalence with firmware or hardware.
 */
export function continuousPidTransfer(pid: ControllerParams): { numerator: number[]; denominator: number[] } {
  const kp = pid.kp;
  const ki = pid.ki ?? 0;
  const kd = pid.kd ?? 0;
  const tf = pid.tf ?? 0;
  if (![kp, ki, kd, tf].every(Number.isFinite) || tf < 0) throw new Error('连续 PID 系数必须是有限数值，微分滤波时间常数不能为负。');
  if (pid.sampleTime !== undefined && (!Number.isFinite(pid.sampleTime) || pid.sampleTime <= 0)) throw new Error('控制器采样周期必须为正有限数值；连续合成不代表离散固件一致性。');
  if (kp === 0 && ki === 0 && kd === 0) throw new Error('零控制器不能作为已闭合内环合成外环对象。');
  let numerator = tf > 0 ? [kp * tf + kd, kp + ki * tf, ki] : [kd, kp, ki];
  let denominator = tf > 0 ? [tf, 1, 0] : [1, 0];
  // Ki=0 has no integrator state. Remove only this exact bookkeeping
  // factor; never cancel plant poles or approximately equal factors.
  if (ki === 0) {
    numerator = numerator.slice(0, -1);
    denominator = denominator.slice(0, -1);
  }
  numerator = trimLeadingZeros(numerator);
  if (!numerator.concat(denominator).every(Number.isFinite)) throw new Error('连续 PID 多项式系数溢出，需调整系数或单位。');
  return { numerator, denominator };
}

/**
 * Exact algebra for the supplied zero-delay continuous model and constant
 * sensor gain H under negative feedback: T=P*C/(1+P*C*H).
 * The unreduced characteristic polynomial must be strictly stable; hidden
 * modes are not discarded through numerator/denominator cancellation.
 */
export function composeContinuousInnerLoop(plant: PlantModel, pid: ControllerParams, feedbackGain = 1): TransferFunctionModel {
  requireValidPlant(plant);
  if (plant.tau !== 0) throw new Error('内环反馈中含纯滞后，不能把延迟移到闭环外部；请提供已核对的内环闭环等效模型。');
  if (!Number.isFinite(feedbackGain) || feedbackGain === 0) throw new Error('内环反馈增益必须是非零有限数值。');
  const p = toTransferFunction(plant);
  const c = continuousPidTransfer(pid);
  const numerator = multiplyPolynomials(p.numerator, c.numerator);
  const denominator = addPolynomials(multiplyPolynomials(p.denominator, c.denominator), numerator.map(value => value * feedbackGain));
  if (polynomialStability(denominator) !== 'stable') throw new Error('内环原始闭环特征多项式未证明严格稳定；不能用于外环对象合成。');
  const model: TransferFunctionModel = { family: 'transfer_function', numerator, denominator, tau: 0 };
  requireValidPlant(model);
  return model;
}

/**
 * Check a caller-supplied closed-loop input/output model. Caller evidence must
 * cover its source, controller, units and operating point; a stable fitted
 * denominator does not prove the real device is stable.
 */
export function checkedInnerClosedLoopModel(model: PlantModel): TransferFunctionModel {
  requireValidPlant(model);
  const transfer = toTransferFunction(model);
  if (polynomialStability(transfer.denominator) !== 'stable') throw new Error('提供的内环闭环等效模型必须有可证明严格稳定的分母；需要重新核对模型或试验。');
  return transfer;
}

/** Exact series product of two already defined input/output models. */
export function cascadeSeriesProduct(first: PlantModel, second: PlantModel): TransferFunctionModel {
  requireValidPlant(first);
  requireValidPlant(second);
  const a = toTransferFunction(first);
  const b = toTransferFunction(second);
  const model: TransferFunctionModel = {
    family: 'transfer_function',
    numerator: multiplyPolynomials(a.numerator, b.numerator),
    denominator: multiplyPolynomials(a.denominator, b.denominator),
    tau: a.tau + b.tau,
  };
  requireValidPlant(model);
  return model;
}
