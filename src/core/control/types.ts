/**
 * 控制工具链与单环智能整定类型定义 (Phase 3: Control Toolchain Types)
 */

import type { StepResponseMetrics } from '../analysis/types';
import type { AnalysisProvenance } from '../analysis/provenance';

// ==========================================
// 1. 受控对象传递函数模型 (Plant Models)
// ==========================================

/** 一阶惯性加纯滞后模型 (First Order Plus Dead Time, FOPDT) */
export interface FopdtModel {
  family: 'fopdt';
  /** 系统稳态增益 K */
  k: number;
  /** 惯性时间常数 T (秒, T > 0) */
  t: number;
  /** 纯滞后时间 / 死区时间 τ (秒, τ >= 0) */
  tau: number;
}

/** 二阶欠阻尼 / 临界 / 过阻尼模型 (Second Order Plus Dead Time, SOPDT) */
export interface SopdtModel {
  family: 'sopdt';
  /** 系统稳态增益 K */
  k: number;
  /** 无阻尼自然振荡角频率 ωn (rad/s, ωn > 0) */
  wn: number;
  /** 阻尼比 ζ (ζ > 0) */
  zeta: number;
  /** 纯滞后时间 τ (秒, τ >= 0, 默认为 0) */
  tau: number;
}

/** 积分 + 惯性模型 (Integral + First Order Lag) */
export interface IntegralLagModel {
  family: 'integral_lag';
  /** 积分增益 K (速度/开度) */
  k: number;
  /** 惯性时间常数 T (秒, T > 0) */
  t: number;
  /** 纯滞后时间 τ (秒, τ >= 0, 默认为 0) */
  tau: number;
}

/** 用户提供或确认的有理 s 域对象；系数按 s 的降幂排列，tau 为独立纯滞后。 */
export interface TransferFunctionModel {
  family: 'transfer_function';
  numerator: number[];
  denominator: number[];
  tau: number;
}

export type IdentifiablePlantModel = FopdtModel | SopdtModel | IntegralLagModel;
export type PlantModel = IdentifiablePlantModel | TransferFunctionModel;

// ==========================================
// 2. 系统辨识引擎类型 (System Identification)
// ==========================================

export type IdentificationMode = 'open_loop' | 'closed_loop';
export type PlantFamilyChoice = 'auto' | 'fopdt' | 'sopdt' | 'integral_lag';

export interface ControllerParams {
  kp: number;
  ki?: number;
  kd?: number;
  tf?: number;
  sampleTime?: number;
}

export interface IdentifyPlantOptions {
  /** 辨识模式: 开环阶跃响应拟合 | 闭环反推 */
  mode: IdentificationMode;
  /** 目标模型族: 自动择优 | 强制指定 */
  family?: PlantFamilyChoice;
  /** 显式指定的阶跃发生时间 (秒) */
  stepTime: number;
  /** 用户实测或配置的阶跃输入幅值 Δu。 */
  stepAmplitude: number;
  /** 闭环反推模式下当前下位机运行的控制器参数 */
  controller?: ControllerParams;
  /** 采样时间 Ts (秒，用于时域离散步长与时序对齐) */
  sampleTime?: number;
  /** 可选协作取消钩子，仅由后台分析 Worker 使用。 */
  shouldCancel?: () => boolean;
}

export interface IdentifyPlantResult {
  /** 辨识出的最优模型 */
  model: IdentifiablePlantModel;
  /** 拟合优度 R^2 (决定系数, 0 ~ 1) */
  r_squared: number;
  /** 置信度评级: high (>=0.95), medium (0.90~0.95), low (<0.90) */
  confidence: 'high' | 'medium' | 'low';
  /** 是否达到定量参数输出门槛 (R^2 >= 0.90 且激励足够) */
  usable: boolean;
  /** 评估说明或重测建议 */
  message: string;
  /** 拟合预测输出曲线与原始采样对比 */
  fit_curve?: {
    times: number[];
    y_fitted: number[];
  };
  provenance?: AnalysisProvenance;
}

// ==========================================
// 3. 波特图计算引擎类型 (Bode Engine)
// ==========================================

export interface BodeOptions {
  /** 最小角频率 (rad/s, 默认 0.1) */
  omegaMin?: number;
  /** 最大角频率 (rad/s, 默认 min(10000, π / Ts)) */
  omegaMax?: number;
  /** 对数网格采样点数 (默认 200) */
  pointsCount?: number;
  /** 采样周期 Ts (秒, 用于评估 ZOH 与计算延时 e^{-1.5 s Ts}) */
  sampleTime?: number;
  /** 微分滤波时间常数 Tf (秒, 默认 0) */
  tf?: number;
}

export interface BodePoint {
  /** 角频率 ω (rad/s) */
  omega: number;
  /** 开环总对数幅值 20lg|L(jω)| (dB) */
  mag_db: number;
  /** 开环总相角 ∠L(jω) (度, 包含纯延时与离散化延时) */
  phase_deg: number;
  /** 控制器幅值 (dB) */
  c_mag_db: number;
  /** 控制器相角 (度) */
  c_phase_deg: number;
  /** 被控对象幅值 (dB) */
  g_mag_db: number;
  /** 被控对象相角 (度) */
  g_phase_deg: number;
  /** 离散化 ZOH + 计算延时相角损失: -1.5 ω Ts * 180 / π (度) */
  delay_phase_deg: number;
}

export interface BodeResult {
  /** 频域曲线点阵 */
  curve: BodePoint[];
  /** 剪切频率 ωc (开环幅值穿过 0 dB 的角频率, rad/s) */
  omega_c: number | null;
  /** 相位裕度 γ = 180° + ∠L(jωc) (度) */
  phase_margin: number | null;
  /** 相位穿越频率 ωπ (开环相角穿过 -180° 的角频率, rad/s) */
  omega_pi: number | null;
  /** 幅值裕度 GM = -20lg|L(jωπ)| (dB) */
  gain_margin_db: number | null;
  /** 闭环频域稳定性判据；缺少有效剪切频率时为 null（未知） */
  is_stable: boolean | null;
}

// ==========================================
// 4. PID 闭式解算器类型 (Analytical PID Solver)
// ==========================================

export type PidStructure = 'P' | 'PI' | 'PD' | 'PID';

export interface SolvePidOptions {
  /** 目标剪切频率 ωc* (rad/s) */
  target_omega_c: number;
  /** 期望相位裕度 γ* (度, 推荐 45° ~ 65°) */
  target_phase_margin: number;
  /** 控制器结构裁剪 (默认 'PID') */
  structure?: PidStructure;
  /** 单片机采样周期 Ts (秒, 纳入 -1.5 ωc* Ts 相位损失) */
  sampleTime?: number;
  /** PID 第三约束比值: Td / Ti (工程默认 0.25 即 Td = Ti / 4, Kd*Ki = Kp^2 / 4) */
  pidRatioTdOverTi?: number;
  /** 微分转折频率 ωd (rad/s, 供完整 PID 确定第三约束 Kd = Kp / ωd) */
  derivativeCornerFrequency?: number;
  /** 微分滤波时间常数 Tf (秒, 默认 0) */
  tf?: number;
}

export interface SolvePidResult {
  success: boolean;
  kp: number;
  ki: number;
  kd: number;
  tf: number;
  structure: PidStructure;
  /** 实际代入重算实现的剪切频率 */
  achieved_omega_c?: number;
  /** 实际代入重算实现的相位裕度 */
  achieved_phase_margin?: number;
  /** 解算诊断信息 */
  message: string;
  /** 离线验算说明，不代表设备或硬件验收。 */
  warnings?: string[];
}

// ==========================================
// 5. 目标推荐与闭环仿真类型 (Recommend & Simulation)
// ==========================================

export interface RecommendTargetsOptions {
  plant: PlantModel;
  sampleTime: number;
  desired_phase_margin?: number;
  structure?: PidStructure;
}

export interface RecommendTargetsResult {
  /** 推荐的剪切频率 ωc* (rad/s) */
  recommended_omega_c: number;
  /** 推荐的相位裕度 γ* (度) */
  recommended_phase_margin: number;
  /** 采样定理安全硬上限 ω_max = 0.2π / Ts (rad/s) */
  max_allowed_omega_c: number;
  /** 推荐理由与物理机理推导链条 */
  reasoning: string[];
}

export interface SimulateClosedLoopOptions {
  plant: PlantModel;
  pid: {
    kp: number;
    ki?: number;
    kd?: number;
    tf?: number;
  };
  sampleTime: number;
  simTime?: number;
  stepValue?: number;
  initialValue?: number;
  /** 控制量输出限幅 [min, max] (默认 [-100, 100]) */
  outputLimits?: [number, number];
  /** 是否启用积分抗饱和 (Anti-Windup, 默认 true) */
  antiWindup?: boolean;
  /**
   * Optional cooperative cancellation hook used by the analysis Worker.
   * The normal synchronous API leaves it unset and remains deterministic.
   */
  shouldCancel?: () => boolean;
}

export interface SimulateClosedLoopResult {
  times: number[];
  references: number[];
  values: number[];
  controls: number[];
  metrics: StepResponseMetrics | null;
  metrics_error: string | null;
  provenance?: AnalysisProvenance;
}

// ==========================================
// 6. 离散化与差分方程输出 (Discretization)
// ==========================================

export interface DiscretizePidOptions {
  kp: number;
  ki: number;
  kd: number;
  sampleTime: number;
  tf?: number;
  outputLimits?: [number, number];
}

export interface DiscretizePidResult {
  positional: {
    kp: number;
    ki_factor: number;
    kd_factor: number;
    c_code: string;
  };
  incremental: {
    a: number;
    b: number;
    c: number;
    c_code: string;
  };
}

// ==========================================
// 7. 软件在环测试台类型 (SIL Testbench)
// ==========================================

export interface SilTestbenchOptions {
  truePlant: IdentifiablePlantModel;
  sampleTime?: number;
  simDuration?: number;
  noiseStdDev?: number;
  targetPhaseMargin?: number;
}

export interface SilTestbenchResult {
  ground_truth_plant: IdentifiablePlantModel;
  identified_plant: IdentifiablePlantModel;
  identification_error_pct: {
    k: number;
    time_constant_or_wn: number;
    delay?: number;
  };
  identification_passed: boolean;
  recommended_pid: {
    kp: number;
    ki: number;
    kd: number;
  };
  predicted_metrics: StepResponseMetrics | null;
  actual_sil_metrics: StepResponseMetrics | null;
  overshoot_error_pct: number | null;
  sil_passed: boolean;
  summary: string;
}
