/**
 * LLM 串口 IPC 契约定义 (PRD 2.4 / PR-001 冻结规范)
 * 严格与 src-tauri/src/model.rs 保持 100% 对齐
 */

export interface SerialConfig {
  port: string;
  baud_rate: number;
  data_bits?: number;
  stop_bits?: number;
  parity?: 'None' | 'Odd' | 'Even';
}

/**
 * 统一时序采样点数据模型 (PRD 2.4.2 PR-001)
 * values 采用稀疏通道表示法：当前采样周期更新的通道为 number，未更新的为 null
 */
export interface SamplePoint {
  timestamp_us: number;
  values: (number | null)[];
}

/**
 * 60Hz IPC 聚合分发给前端的波形批次数据结构 (PRD 2.4.2 PR-001)
 */
export interface WaveformBatch {
  session_id: string;
  channel_epoch: number;
  channel_names: string[];
  points: SamplePoint[];
  timestamps: number[];
  series: number[][];
  dropped_bytes?: number;
}

export type LogDirection = 'Rx' | 'Tx';
export type LogLevel = 'Info' | 'Warn' | 'Error' | 'Data';

/**
 * 格式化日志行数据结构 (PRD 2.4.2 PR-001)
 */
export interface LogLine {
  timestamp_us: number;
  direction: LogDirection;
  level: LogLevel;
  text: string;
  raw_hex?: string | null;
}

/**
 * 阶跃性能四大工程指标 (PRD 2.4.2 PR-001)
 */
export interface StepMetrics {
  rise_time_s: number | null;
  overshoot_percent: number | null;
  overshoot_pct?: number | null; // 向后兼容
  settling_time_s: number | null;
  steady_state_error: number | null;
  y0?: number | null;
  y_target?: number | null;
  y_ss?: number | null;
  y_max?: number | null;
  is_stable?: boolean | null;
}

/**
 * 阶跃分析状态 (PRD 2.4.2 PR-001)
 */
export type StepAnalysisStatus =
  | 'Pending'
  | 'Rising'
  | 'Settling'
  | 'Completed'
  | 'Interrupted'
  | 'InsufficientData'
  | 'TimedOut'
  | 'Diverged';

/**
 * 五维品质雷达评分 (0 ~ 100)
 */
export interface QualityScores {
  overshoot_score: number;
  speed_score: number;
  steady_score: number;
  damping_score: number;
  robust_score: number;
}

export interface ChannelMapping {
  target: string;
  actual: string;
  output: string;
}

/**
 * 独立的阶跃响应切片快照 (PRD 2.4.2 PR-001)
 */
export interface StepSnapshot {
  id: string;
  session_id: string;
  timestamp_us: number;
  target_before: number;
  target_after: number;
  channel_binding: ChannelMapping;
  step_amplitude: number | null;
  metrics: StepMetrics;
  status: StepAnalysisStatus;
  quality_scores: QualityScores;
  offline_advice: string | null;
  samples: SamplePoint[];
  // 向后兼容字段
  target_channel?: string | null;
  actual_channel?: string | null;
  relative_times?: number[];
  target_series?: number[];
  actual_series?: number[];
  output_series?: number[];
}

export interface PidParams {
  kp: number;
  ki: number;
  kd: number;
}

/**
 * 硬件校验计算结果 (PR-001 calculate_checksums)
 */
export interface ChecksumResult {
  crc16_modbus: number;
  crc16_modbus_hex_le: string;
  crc16_modbus_hex_be: string;
  crc32: number;
  crc32_hex: string;
  sum8: number;
  sum8_hex: string;
  xor8: number;
  xor8_hex: string;
}

/**
 * 串口状态事件负载 (PRD 2.4.4 serial://status)
 */
export interface SerialStatusEvent {
  is_connected: boolean;
  port: string | null;
  session_id: string;
  channel_epoch: number;
  error: string | null;
  reappeared?: boolean;
}
