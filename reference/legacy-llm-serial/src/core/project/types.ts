/**
 * ProjectModel 领域类型定义 (环路拓扑与受控对象配置)
 */

import type { PlantModel } from '../control/types';

export type LoopStructure = 'P' | 'PI' | 'PD' | 'PID';

export type PlantFamily =
  | 'first_order'
  | 'first_order_plus_delay'
  | 'second_order'
  | 'integrator_plus_lag'
  | 'custom';

export type LoopState = 'untuned' | 'identified' | 'tuned';

export interface ChannelBinding {
  setpoint: string | number;
  feedback: string | number; // 实际响应 actual
  output: string | number;
}

export interface ParamLimits {
  kp: [number, number];
  ki: [number, number];
  kd: [number, number];
}

export interface PidValues {
  kp: number;
  ki: number;
  kd: number;
}

export interface ControlLoop {
  id: string;
  name?: string;
  order: number; // 串级层级：0 为最内环，依次递增
  structure: LoopStructure;
  plant_family: PlantFamily;
  channels: ChannelBinding;
  param_limits: ParamLimits;
  current_params?: PidValues;
  /** 仅由有效辨识或用户明确确认的模型写入；plant_family 只是候选族，不是实测参数。 */
  identified_model?: PlantModel;
  cmd_template: string;
  state: LoopState;
  sample_time?: number;
  sample_period_s?: number;
}

export interface ProjectModel {
  version: number;
  template: string;
  sample_period_s: number;
  active_loop_id: string;
  loops: ControlLoop[];
  sensor_notes?: Record<string, string>;
}

export interface SafetyCheckResult {
  passed: boolean;
  risk_level: 'low' | 'medium' | 'high';
  requires_confirmation: boolean;
  warnings: string[];
  errors: string[];
}
