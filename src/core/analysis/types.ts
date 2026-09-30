/**
 * 阶跃响应分析服务类型定义
 */

import type { AnalysisProvenance } from './provenance';

export interface StepAnalysisOptions {
  bandPercent?: number; // 稳态误差带比例 (默认 0.02 即 ±2%)
  minSustainSeconds?: number; // 维持在误差带内的最短持续时间 (默认 0.2 秒)
  stepTimeThreshold?: number; // 目标值突变判据阈值
  stepTime?: number; // 显式指定的阶跃发生时间 (秒)
  stepIdx?: number; // 显式指定的阶跃发生索引
}

export interface StepResponseMetrics {
  rise_time_s: number | null; // 上升时间 tr (10% -> 90%)
  settling_time_s: number | null; // 调节时间 ts (进入并维持在 ±2% 误差带)
  overshoot_pct: number; // 超调量 Mp (%)
  steady_state_error: number; // 稳态误差 ess
  oscillation_freq_hz: number | null; // 震荡频率 (Hz)
  damping_ratio: number | null; // 阻尼比 ζ 估计
  y0: number; // 阶跃前基线值
  y_target: number; // 阶跃目标值
  y_ss: number; // 稳态终值 (末尾 10% 均值)
  y_max: number; // 极值 (正阶跃为最大值，负阶跃为最小值)
  step_amplitude: number; // 阶跃总幅值 |y_target - y0|
  is_stable: boolean; // 是否在时间窗结束前收敛稳定
  provenance?: AnalysisProvenance;
}
