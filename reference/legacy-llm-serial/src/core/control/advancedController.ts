/**
 * 高级控制器结构与固件 C 语言生成器 (AdvancedController)
 * 提供工业级前馈控制 (Feedforward)、微分先行 (Derivative on PV)、带滤波微分 (Filtered Derivative)
 * 以及针对不同环路拓扑特征的架构选型建议与嵌入式 C 模板
 */

import type { ControlLoop } from '../project/types';
import type { PlantModel } from './types';

export interface AdvancedControllerOptions {
  kp: number;
  ki: number;
  kd: number;
  sampleTime: number;
  tf?: number;
  outputLimits?: [number, number];
  loopName?: string;
}

export interface FeedforwardPidOptions extends AdvancedControllerOptions {
  /** 速度前馈增益 Kv_ff (如电机反电势补偿 Ke) */
  kv_ff?: number;
  /** 加速度前馈增益 Ka_ff (如转动惯量补偿 J) */
  ka_ff?: number;
  /** 库伦摩擦力/静摩擦前馈补偿值 (默认 0) */
  friction_ff?: number;
}

export interface AdvancedStructureRecommendation {
  recommended_structure: string;
  rationale: string[];
  key_features: string[];
  c_code: string;
}

export class AdvancedControllerGenerator {
  /**
   * 生成微分先行 PID (Derivative on PV / Measurement) C 语言代码
   * 原理：对反馈测量值 y(k) 求微分而不是对误差 e(k) 求微分：
   * u(k) = Kp * e(k) + Ki_term * Σe - (Kd / Ts) * (y(k) - y(k-1))
   * 优势：彻底消除目标值阶跃突变引起的“微分冲击 (Derivative Kick)”，执行器输出平滑。
   */
  public static generateDerivativeOnPVCode(options: AdvancedControllerOptions): string {
    const { kp, ki, kd, sampleTime } = options;
    const ts = Math.max(1e-6, sampleTime);
    const limits = options.outputLimits || [-100, 100];
    const uMin = limits[0];
    const uMax = limits[1];
    const kiTerm = Number((ki * ts).toFixed(6));
    const kdTerm = Number((kd / ts).toFixed(6));
    const name = options.loopName || 'Loop';

    return `/* ===================================================================
 * 微分先行 PID (Derivative on PV / Measurement) - 固件驱动
 * 环路名称: ${name}
 * 控制特性: 对测量反馈求微分，杜绝目标设定阶跃引起的微分脉冲冲击
 * 采样周期 Ts: ${(ts * 1000).toFixed(2)} ms (fs = ${(1 / ts).toFixed(0)} Hz)
 * 参数: Kp=${kp}, Ki=${ki}, Kd=${kd}
 * =================================================================== */

#ifndef PID_ON_PV_${name.toUpperCase()}_H
#define PID_ON_PV_${name.toUpperCase()}_H

#include <stdint.h>
#include <math.h>

typedef struct {
    float kp;             /* 比例增益: ${kp} */
    float ki_term;        /* Ki * Ts = ${kiTerm} */
    float kd_term;        /* Kd / Ts = ${kdTerm} */
    float integral;       /* 积分累加量 */
    float prev_feedback;  /* 上一拍测量反馈 y(k-1) */
    float out_min;        /* 下限幅: ${uMin} */
    float out_max;        /* 上限幅: ${uMax} */
} PidOnPv_${name}_t;

static inline void PidOnPv_${name}_Init(PidOnPv_${name}_t *pid) {
    pid->kp = ${kp}f;
    pid->ki_term = ${kiTerm}f;
    pid->kd_term = ${kdTerm}f;
    pid->integral = 0.0f;
    pid->prev_feedback = 0.0f;
    pid->out_min = ${uMin}f;
    pid->out_max = ${uMax}f;
}

static inline float PidOnPv_${name}_Update(PidOnPv_${name}_t *pid, float setpoint, float feedback) {
    float error = setpoint - feedback;
    
    /* 1. 比例项: P = Kp * e(k) */
    float p_out = pid->kp * error;
    
    /* 2. 候选积分累加 */
    float int_cand = pid->integral + pid->ki_term * error;
    
    /* 3. 微分先行项: D = - (Kd / Ts) * [y(k) - y(k-1)] */
    float d_out = -pid->kd_term * (feedback - pid->prev_feedback);
    pid->prev_feedback = feedback;
    
    float u_raw = p_out + int_cand + d_out;
    
    /* 4. 抗积分饱和限幅 (Anti-Windup Clamping) */
    if (u_raw > pid->out_max) {
        if (error <= 0.0f) pid->integral = int_cand; /* 仅当误差有助于退出饱和时积分 */
        return pid->out_max;
    } else if (u_raw < pid->out_min) {
        if (error >= 0.0f) pid->integral = int_cand;
        return pid->out_min;
    } else {
        pid->integral = int_cand;
        return u_raw;
    }
}

#endif /* PID_ON_PV_${name.toUpperCase()}_H */`;
  }

  /**
   * 生成带一阶低通滤波的微分 PID (Filtered Derivative PID) C 语言代码
   * 原理：D(s) = Kd * s / (Tf * s + 1)
   * 离散化：α = Tf / (Tf + Ts)
   * d_filt(k) = α * d_filt(k-1) + (1 - α) * (Kd / Ts) * [e(k) - e(k-1)]
   * 优势：强力抑制高频传感器量化噪声 (ADC/编码器抖动)，防止执行器高频啸叫发热。
   */
  public static generateFilteredDerivativeCode(options: AdvancedControllerOptions): string {
    const { kp, ki, kd, sampleTime } = options;
    const ts = Math.max(1e-6, sampleTime);
    const limits = options.outputLimits || [-100, 100];
    const uMin = limits[0];
    const uMax = limits[1];
    const tf = options.tf && options.tf > 0 ? options.tf : Math.max(ts * 2.0, 0.005);
    const alpha = Number((tf / (tf + ts)).toFixed(5));
    const kiTerm = Number((ki * ts).toFixed(6));
    const kdTerm = Number((kd / ts).toFixed(6));
    const name = options.loopName || 'Loop';

    return `/* ===================================================================
 * 带一阶低通滤波的微分 PID (Filtered Derivative PID) - 固件驱动
 * 环路名称: ${name}
 * 控制特性: 微分项串联一阶低通滤波器，有效阻断编码器量化噪声与高频电磁纹波
 * 滤波时间常数 Tf: ${(tf * 1000).toFixed(2)} ms, 滤波系数 α: ${alpha}
 * 采样周期 Ts: ${(ts * 1000).toFixed(2)} ms (fs = ${(1 / ts).toFixed(0)} Hz)
 * =================================================================== */

#ifndef PID_FILTERED_${name.toUpperCase()}_H
#define PID_FILTERED_${name.toUpperCase()}_H

#include <stdint.h>
#include <math.h>

typedef struct {
    float kp;             /* ${kp} */
    float ki_term;        /* ${kiTerm} */
    float kd_term;        /* ${kdTerm} */
    float alpha;          /* 滤波惯性系数 Tf/(Tf+Ts) = ${alpha} */
    float integral;
    float prev_error;
    float d_filtered;     /* 一阶滤波后的微分输出状态量 */
    float out_min;        /* ${uMin} */
    float out_max;        /* ${uMax} */
} PidFiltered_${name}_t;

static inline void PidFiltered_${name}_Init(PidFiltered_${name}_t *pid) {
    pid->kp = ${kp}f;
    pid->ki_term = ${kiTerm}f;
    pid->kd_term = ${kdTerm}f;
    pid->alpha = ${alpha}f;
    pid->integral = 0.0f;
    pid->prev_error = 0.0f;
    pid->d_filtered = 0.0f;
    pid->out_min = ${uMin}f;
    pid->out_max = ${uMax}f;
}

static inline float PidFiltered_${name}_Update(PidFiltered_${name}_t *pid, float setpoint, float feedback) {
    float error = setpoint - feedback;
    
    /* 1. 比例项 */
    float p_out = pid->kp * error;
    
    /* 2. 积分项候选 */
    float int_cand = pid->integral + pid->ki_term * error;
    
    /* 3. 原始微分值 */
    float d_raw = pid->kd_term * (error - pid->prev_error);
    pid->prev_error = error;
    
    /* 4. 一阶低通滤波: d_filt(k) = α * d_filt(k-1) + (1 - α) * d_raw */
    pid->d_filtered = pid->alpha * pid->d_filtered + (1.0f - pid->alpha) * d_raw;
    
    float u_raw = p_out + int_cand + pid->d_filtered;
    
    /* 5. 动态限幅与积分抗饱和 */
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
}

#endif /* PID_FILTERED_${name.toUpperCase()}_H */`;
  }

  /**
   * 生成带速度/加速度前馈的高级复合 PID (Feedforward PID) C 语言代码
   * 原理：u(k) = u_pid(k) + Kv_ff * target_vel + Ka_ff * target_acc + friction_ff * sgn(vel)
   * 优势：前馈直接根据目标轨迹计算控制量，反馈 PID 仅用于消除未建模扰动与模型偏差，
   * 显著消除跟踪相位滞后，实现接近 0 滞后的高动态轮廓跟随。
   */
  public static generateFeedforwardPidCode(options: FeedforwardPidOptions): string {
    const { kp, ki, kd, sampleTime } = options;
    const ts = Math.max(1e-6, sampleTime);
    const limits = options.outputLimits || [-100, 100];
    const uMin = limits[0];
    const uMax = limits[1];
    const kvFf = options.kv_ff ?? 1.0;
    const kaFf = options.ka_ff ?? 0.0;
    const friction = options.friction_ff ?? 0.0;
    const kiTerm = Number((ki * ts).toFixed(6));
    const kdTerm = Number((kd / ts).toFixed(6));
    const name = options.loopName || 'Motion';

    return `/* ===================================================================
 * 工业级复合前馈 PID 控制器 (Feedforward + PID) - 固件驱动
 * 环路名称: ${name}
 * 控制特性: 结合速度/加速度前馈补偿与反馈 PID，实现近乎零相位滞后轨迹跟踪
 * 前馈增益: Kv_ff = ${kvFf} (速度前馈), Ka_ff = ${kaFf} (加速度前馈), 摩擦补偿 = ${friction}
 * 采样周期 Ts: ${(ts * 1000).toFixed(2)} ms
 * =================================================================== */

#ifndef FEEDFORWARD_PID_${name.toUpperCase()}_H
#define FEEDFORWARD_PID_${name.toUpperCase()}_H

#include <stdint.h>
#include <math.h>

typedef struct {
    float kp;             /* 反馈比例增益: ${kp} */
    float ki_term;        /* Ki * Ts: ${kiTerm} */
    float kd_term;        /* Kd / Ts: ${kdTerm} */
    float kv_ff;          /* 速度前馈增益: ${kvFf} */
    float ka_ff;          /* 加速度前馈增益: ${kaFf} */
    float friction_ff;    /* 静摩擦补偿幅值: ${friction} */
    float integral;
    float prev_error;
    float out_min;        /* ${uMin} */
    float out_max;        /* ${uMax} */
} FeedforwardPid_${name}_t;

static inline void FeedforwardPid_${name}_Init(FeedforwardPid_${name}_t *pid) {
    pid->kp = ${kp}f;
    pid->ki_term = ${kiTerm}f;
    pid->kd_term = ${kdTerm}f;
    pid->kv_ff = ${kvFf}f;
    pid->ka_ff = ${kaFf}f;
    pid->friction_ff = ${friction}f;
    pid->integral = 0.0f;
    pid->prev_error = 0.0f;
    pid->out_min = ${uMin}f;
    pid->out_max = ${uMax}f;
}

static inline float FeedforwardPid_${name}_Update(
    FeedforwardPid_${name}_t *pid,
    float pos_target,
    float pos_feedback,
    float vel_target,
    float acc_target
) {
    float error = pos_target - pos_feedback;
    
    /* 1. 反馈 PID 计算 */
    float p_out = pid->kp * error;
    float int_cand = pid->integral + pid->ki_term * error;
    float d_out = pid->kd_term * (error - pid->prev_error);
    pid->prev_error = error;
    
    float fb_out = p_out + int_cand + d_out;
    
    /* 2. 前馈计算 (Feedforward): 克服反电势阻抗与惯性 */
    float ff_out = pid->kv_ff * vel_target + pid->ka_ff * acc_target;
    
    /* 摩擦力符号补偿 (对低速平滑过零至关重要) */
    if (pid->friction_ff > 0.0f) {
        if (vel_target > 1e-3f) ff_out += pid->friction_ff;
        else if (vel_target < -1e-3f) ff_out -= pid->friction_ff;
    }
    
    /* 3. 复合总输出 */
    float u_raw = fb_out + ff_out;
    
    /* 4. 抗饱和截断 */
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
}

#endif /* FEEDFORWARD_PID_${name.toUpperCase()}_H */`;
  }

  /**
   * 针对指定环路类型与辨识模型，智能推荐高级控制器拓扑结构
   */
  public static recommendAdvancedController(
    loop: ControlLoop,
    _plant?: PlantModel
  ): AdvancedStructureRecommendation {
    const loopName = (loop.name || loop.id).toLowerCase();
    const isCurrent = loopName.includes('current') || loopName.includes('电流');
    const isSpeed = loopName.includes('speed') || loopName.includes('速度') || loopName.includes('rate');
    const isPos = loopName.includes('pos') || loopName.includes('位置') || loopName.includes('angle');
    const isTemp = loopName.includes('temp') || loopName.includes('温');

    const params = loop.current_params || { kp: 1.0, ki: 0.1, kd: 0.0 };
    const ts = loop.sample_period_s || loop.sample_time || 0.001;

    // 1. 电流内环推荐: 纯 PI + Anti-Windup (严禁微分)
    if (isCurrent) {
      return {
        recommended_structure: 'PI + 抗积分饱和 (Anti-Windup)',
        rationale: [
          '电流内环电气时间常数极短 (通常 < 1ms)，开关纹波与高频噪声强烈；',
          '拓扑铁律：严禁引入微分项 Kd (微分项会直接放大 PWM 开关噪声造成电流杂音)；',
          '必须配置快速积分抗饱和，防止大占空比饱和后电流失控。',
        ],
        key_features: ['Kd 恒为 0', '快速抗积分饱和截断', '反电势前馈接口支持'],
        c_code: this.generateDerivativeOnPVCode({
          kp: params.kp,
          ki: params.ki,
          kd: 0,
          sampleTime: ts,
          loopName: loop.id,
        }),
      };
    }

    // 2. 位置外环推荐: P + 速度前馈 (Feedforward) 或微分先行
    if (isPos) {
      return {
        recommended_structure: 'P + 速度/加速度前馈 (Feedforward) + 目标平滑滤波',
        rationale: [
          '位置外环作为串级最外层，受控对象内部自带速度到位置的物理积分 (1/s)；',
          '工程推荐外环采用纯 P 比例控制器配合速度前馈 Kv_ff，避免多重积分引起闭环剧烈震荡；',
          '若需要微分环节，必须采用“微分先行 (Derivative on PV)”，避免轨迹突变引发微分冲击。',
        ],
        key_features: ['零阶跃冲击 (No Derivative Kick)', '前馈消除跟踪相角滞后', '单比例 P 结构高相位裕度'],
        c_code: this.generateFeedforwardPidCode({
          kp: params.kp,
          ki: loop.structure === 'P' ? 0 : params.ki,
          kd: params.kd,
          sampleTime: ts,
          kv_ff: 1.0,
          ka_ff: 0.02,
          loopName: loop.id,
        }),
      };
    }

    // 3. 速度中环推荐: PI + 带滤波微分 (Filtered Derivative) 或加速度前馈
    if (isSpeed) {
      return {
        recommended_structure: 'PI + 带滤波微分 (Filtered Derivative)',
        rationale: [
          '速度测量依赖编码器 M/T 测速或高频反电势观测器，离散差分存在固有量化台阶噪声；',
          '若启用微分项 Kd，必须配合一阶低通滤波 (Tf ≈ 2~5 * Ts)，将截止频率限制在采样频率 1/10 以下；',
          '配合加速度/转矩前馈可大幅削减电机启动与突加负载时的动态转速降落。',
        ],
        key_features: ['微分一阶低通平滑', '抑制编码器离散量化阶跃', '抗饱和与转矩限幅'],
        c_code: this.generateFilteredDerivativeCode({
          kp: params.kp,
          ki: params.ki,
          kd: params.kd,
          sampleTime: ts,
          tf: ts * 3.0,
          loopName: loop.id,
        }),
      };
    }

    // 4. 温度环等大惯性带迟滞过程: 带滤波 PID + 积分分离与抗饱和
    if (isTemp) {
      return {
        recommended_structure: '带一阶滤波的 PID + 积分分离 (Integral Separation)',
        rationale: [
          '温控对象具有大热容惯性与显著纯滞后时间 τ；',
          '微分项对温升趋势预测至关重要，但热敏电阻/PT100 信号易受工频与开关电源干扰，必须做一阶滤波；',
          '在温差较大时关闭积分以防超调，在温差小于阈值时投入积分以消除静态误差。',
        ],
        key_features: ['大惯性超前预判', '防止热累积严重超调', '稳态零残差'],
        c_code: this.generateFilteredDerivativeCode({
          kp: params.kp,
          ki: params.ki,
          kd: params.kd,
          sampleTime: ts,
          tf: 0.05,
          loopName: loop.id,
        }),
      };
    }

    // 默认通用推荐
    return {
      recommended_structure: '带滤波微分的标准抗饱和 PID',
      rationale: ['通用工业控制闭环标准结构，平衡抗扰动能力与高频噪声抑制。'],
      key_features: ['一阶低通平滑', '积分抗饱和', '执行器平滑限幅'],
      c_code: this.generateFilteredDerivativeCode({
        kp: params.kp,
        ki: params.ki,
        kd: params.kd,
        sampleTime: ts,
        loopName: loop.id,
      }),
    };
  }
}
