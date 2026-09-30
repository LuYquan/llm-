import type { StepResponseMetrics } from '../analysis/types';
import type { PidValues } from '../project/types';

export type AnomalyType =
  | 'hardfault'
  | 'assert'
  | 'watchdog'
  | 'overtemp'
  | 'overcurrent'
  | 'undervoltage'
  | 'oscillation'
  | 'divergence'
  | 'param_limit'
  | 'error';

export type AnomalyLevel = 'critical' | 'warning';

export interface FirmwareAnomaly {
  id: string;
  timestamp: number;
  type: AnomalyType;
  level: AnomalyLevel;
  message: string;
  rawLine?: string;
  channel?: string;
  details?: Record<string, any>;
}

export interface OscillationCheckConfig {
  /** 检查的最新点数窗口 (默认 40) */
  windowSize?: number;
  /** 跨越均值或导数反转次数阈值 (默认 5) */
  reversalThreshold?: number;
  /** 最小峰峰值振幅阈值，低于此振幅视为底噪微小抖动 (默认 1.0) */
  amplitudeThreshold?: number;
  /** 发散绝对限幅阈值 (若未指定，基于当前值大幅激增判定) */
  divergenceThreshold?: number;
  /** 连续单调增长或指数漂移点数 (默认 15) */
  divergenceStreak?: number;
}

export interface IdentifiedModelSummary {
  type?: string;
  gain?: number; // K
  time_constant?: number; // T
  dead_time?: number; // L
  phase_margin?: number; // γ (度)
  cutoff_frequency?: number; // ωc (rad/s)
  raw_summary?: string;
}

export interface CopilotContextPayload {
  timestamp: number;
  active_loop?: {
    id: string;
    name: string;
    order: number;
    structure?: string;
    current_params?: PidValues;
    param_limits?: any;
    cmd_template: string;
    sample_time?: number;
  };
  topology_summary: {
    name: string;
    loops_count: number;
    active_loop_id?: string;
    all_loops: Array<{
      id: string;
      name: string;
      order: number;
      state: string;
    }>;
  };
  step_metrics?: StepResponseMetrics | null;
  identified_model?: IdentifiedModelSummary | null;
  recent_logs: Array<{
    time: string;
    level: string;
    tag: string;
    text: string;
    is_anomaly?: boolean;
  }>;
  recent_anomalies: FirmwareAnomaly[];
  /** 波形结构化统计摘要 (严禁推送百万原始数据点) */
  waveform_summary?: Array<{
    channel: string;
    count: number;
    latest: number;
    min: number;
    max: number;
    mean: number;
  }>;
}

export interface CopilotOutputSchema {
  diagnosis: string;
  evidence: string | string[];
  recommendation: string;
  command: string;
  risk_level: 'low' | 'medium' | 'high';
  requires_confirmation: boolean;
  params?: {
    kp?: number;
    ki?: number;
    kd?: number;
    [key: string]: number | undefined;
  };
  predicted?: {
    mp?: number;
    ts?: number;
    ess?: number;
    phase_margin?: number;
    [key: string]: number | undefined;
  };
  /**
   * 前端数值溯源来源声明
   * 必须明确标注来源工具，如: "tool:bode_analyzer" | "tool:step_identification" | "tool:rule_engine"
   */
  tool_call_source?: string;
}

export interface CopilotValidationResult {
  valid: boolean;
  data?: CopilotOutputSchema;
  errors: string[];
  traceability: {
    is_traceable: boolean;
    source?: string;
    unverified_fields: string[];
  };
  can_fill_send_area: boolean;
}

export interface CopilotSafetyCheckResult {
  passed: boolean;
  risk_level: 'low' | 'medium' | 'high';
  requires_confirmation: boolean;
  warnings: string[];
  errors: string[];
  sanitized_command?: string;
}

export interface CopilotChatMessage {
  id: string;
  sender: 'user' | 'copilot' | 'system';
  timestamp: number;
  text: string;
  card?: CopilotOutputSchema;
  canFillSendArea?: boolean;
  validationErrors?: string[];
  anomalyId?: string;
}
