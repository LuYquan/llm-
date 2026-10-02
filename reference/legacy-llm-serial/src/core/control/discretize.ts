/**
 * 差分方程离散化与单片机代码生成器 (discretize_pid / discretizePid / discretize)
 * 输出工业级位置式与增量式 PID 差分系数及 C 语言工程模板
 */

import type {
  DiscretizePidOptions,
  DiscretizePidResult,
} from './types';

export function discretizePid(options: DiscretizePidOptions): DiscretizePidResult {
  const { kp, ki, kd, sampleTime } = options;
  const ts = Math.max(1e-6, sampleTime);
  const limits = options.outputLimits || [-100, 100];
  const uMin = limits[0];
  const uMax = limits[1];

  // 1. 位置式 PID 系数:
  // u(k) = Kp * e(k) + (Ki * Ts) * Σe + (Kd / Ts) * (e(k) - e(k-1))
  const kiFactor = Number((ki * ts).toFixed(6));
  const kdFactor = Number((kd / ts).toFixed(6));

  const positionalCCode = `/* ===================================================
 * 位置式 PID 离散实现 (Positional PID for MCU)
 * Ts = ${(ts * 1000).toFixed(2)} ms (fs = ${(1 / ts).toFixed(0)} Hz)
 * Kp = ${kp}, Ki = ${ki}, Kd = ${kd}
 * =================================================== */

typedef struct {
    float kp;          /* ${kp} */
    float ki_term;     /* Ki * Ts = ${kiFactor} */
    float kd_term;     /* Kd / Ts = ${kdFactor} */
    float integral;
    float prev_error;
    float out_min;     /* ${uMin} */
    float out_max;     /* ${uMax} */
} PositionalPID_t;

void PositionalPID_Init(PositionalPID_t *pid) {
    pid->kp = ${kp}f;
    pid->ki_term = ${kiFactor}f;
    pid->kd_term = ${kdFactor}f;
    pid->integral = 0.0f;
    pid->prev_error = 0.0f;
    pid->out_min = ${uMin}f;
    pid->out_max = ${uMax}f;
}

float PositionalPID_Update(PositionalPID_t *pid, float target, float feedback) {
    float error = target - feedback;
    
    /* 候选积分累加 */
    float int_cand = pid->integral + pid->ki_term * error;
    
    /* 微分项 */
    float deriv = pid->kd_term * (error - pid->prev_error);
    pid->prev_error = error;
    
    float u_raw = pid->kp * error + int_cand + deriv;
    
    /* 抗积分饱和 (Anti-Windup Clamp) */
    if (u_raw > pid->out_max) {
        if (error <= 0.0f) pid->integral = int_cand;
        return pid->out_max;
    } else if (u_raw < pid->out_min) {
        if (error >= 0.0f) pid->integral = int_cand;
        return pid->out_min;
    } else {
        pid->integral = int_cand;
        return u_raw;
    }
}`;

  // 2. 增量式 PID 系数:
  // Δu(k) = A * e(k) + B * e(k-1) + C * e(k-2)
  // A = Kp + Ki * Ts + Kd / Ts
  // B = -Kp - 2 * Kd / Ts
  // C = Kd / Ts
  const a = Number((kp + ki * ts + kd / ts).toFixed(6));
  const b = Number((-kp - (2 * kd) / ts).toFixed(6));
  const c = Number((kd / ts).toFixed(6));

  const incrementalCCode = `/* ===================================================
 * 增量式 PID 离散实现 (Incremental PID for MCU)
 * 适用于电机驱动 PWM 增量调控，天然具备防飞车抗饱和特性
 * Ts = ${(ts * 1000).toFixed(2)} ms (fs = ${(1 / ts).toFixed(0)} Hz)
 * =================================================== */

typedef struct {
    float a;           /* Kp + Ki*Ts + Kd/Ts = ${a} */
    float b;           /* -Kp - 2*Kd/Ts     = ${b} */
    float c;           /* Kd/Ts             = ${c} */
    float prev_err1;   /* e(k-1) */
    float prev_err2;   /* e(k-2) */
    float output;      /* u(k) */
    float out_min;     /* ${uMin} */
    float out_max;     /* ${uMax} */
} IncrementalPID_t;

void IncrementalPID_Init(IncrementalPID_t *pid) {
    pid->a = ${a}f;
    pid->b = ${b}f;
    pid->c = ${c}f;
    pid->prev_err1 = 0.0f;
    pid->prev_err2 = 0.0f;
    pid->output = 0.0f;
    pid->out_min = ${uMin}f;
    pid->out_max = ${uMax}f;
}

float IncrementalPID_Update(IncrementalPID_t *pid, float target, float feedback) {
    float error = target - feedback;
    
    /* 差分增量方程: Δu = A*e(k) + B*e(k-1) + C*e(k-2) */
    float delta_u = pid->a * error + pid->b * pid->prev_err1 + pid->c * pid->prev_err2;
    
    pid->prev_err2 = pid->prev_err1;
    pid->prev_err1 = error;
    
    pid->output += delta_u;
    
    /* 执行器限幅 */
    if (pid->output > pid->out_max) pid->output = pid->out_max;
    if (pid->output < pid->out_min) pid->output = pid->out_min;
    
    return pid->output;
}`;

  return {
    positional: {
      kp: Number(kp.toFixed(5)),
      ki_factor: kiFactor,
      kd_factor: kdFactor,
      c_code: positionalCCode,
    },
    incremental: {
      a,
      b,
      c,
      c_code: incrementalCCode,
    },
  };
}

export const discretize_pid = discretizePid;
export const discretize = discretizePid;
