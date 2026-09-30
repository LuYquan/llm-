/**
 * 目标频域指标智能推荐引擎 (recommend_targets / recommendTargets)
 * 依据物理对象特性、延迟与单片机采样周期推荐科学的剪切频率与期望裕度
 * 严格遵循采样频率 1/10 准则与滞后约束
 */

import type {
  RecommendTargetsOptions,
  RecommendTargetsResult,
} from './types';
import { evalPlantFreq } from './computeBode';
import { validatePlantModel } from './transferFunction';

export function recommendTargets(
  options: RecommendTargetsOptions
): RecommendTargetsResult {
  const { plant, sampleTime, desired_phase_margin, structure } = options;
  const errors = validatePlantModel(plant);
  if (errors.length) throw new Error(errors.join(' '));
  if (!Number.isFinite(sampleTime) || sampleTime <= 0) throw new Error('采样周期必须大于 0。');
  const ts = Math.max(1e-6, sampleTime);
  const reasoning: string[] = [];

  // 1. 采样定理与单片机计算延迟硬约束:
  // 采样角频率 ωs = 2π / Ts
  // 工业闭环带宽硬性门禁: ωc <= 0.1 * ωs = 0.2π / Ts (约为 fs / 10)
  const maxAllowedWc = (0.2 * Math.PI) / ts;
  reasoning.push(
    `采样周期 Ts=${(ts * 1000).toFixed(2)}ms (采样频率 fs=${(1 / ts).toFixed(0)}Hz) 施加采样定理硬约束: 剪切频率上限 ωc_max <= ${(maxAllowedWc).toFixed(1)} rad/s (fs / 10)`
  );

  // 2. 纯滞后与有效延迟硬约束:
  // 系统总延时 τ_eff = τ + 1.5 * Ts (ZOH 与单拍计算延时)
  const tauEff = (plant.tau || 0) + 1.5 * ts;
  const delayConstraintWc = 0.6 / Math.max(1e-4, tauEff);
  reasoning.push(
    `等效纯滞后 τ_eff = ${(tauEff * 1000).toFixed(2)}ms (包含 1.5Ts 离散保持延时) 施加相位衰减约束: ωc_delay <= ${delayConstraintWc.toFixed(1)} rad/s`
  );

  // 3. 基于对象物理极点的动态期望带宽
  let naturalWc = 10.0;
  if (plant.family === 'fopdt') {
    const wp = 1 / Math.max(1e-4, plant.t);
    // 典型闭环提升 1.5 ~ 3.0 倍对象极点带宽
    naturalWc = 2.0 * wp;
    reasoning.push(
      `一阶惯性对象时间常数 T=${plant.t.toFixed(3)}s (极点频角 ωp=${wp.toFixed(2)} rad/s)，推荐提升闭环响应 2.0 倍极点频角 (ωc_plant = ${naturalWc.toFixed(1)} rad/s)`
    );
  } else if (plant.family === 'sopdt') {
    naturalWc = Math.max(0.5, plant.wn);
    reasoning.push(
      `二阶对象固有振荡角频率 ωn=${plant.wn.toFixed(1)} rad/s (阻尼比 ζ=${plant.zeta.toFixed(2)})，推荐配置基准剪切频率 ωc_plant = ${naturalWc.toFixed(1)} rad/s`
    );
  } else if (plant.family === 'integral_lag') {
    // integral_lag
    const wp = 1 / Math.max(1e-4, plant.t);
    naturalWc = wp;
    reasoning.push(
      `积分+惯性对象自带原点极点 (-90° 固有滞后)，推荐保守配置 ωc_plant = ${naturalWc.toFixed(1)} rad/s`
    );
  } else {
    // General rational objects have no universal recommended pole/bandwidth.
    naturalWc = Math.min(1, maxAllowedWc * 0.1, delayConstraintWc * 0.1);
    reasoning.push('自定义传递函数没有通用最佳带宽。当前 1 rad/s 上限仅为保守离线起点，需按极点、零点与实际目标调整并验算。');
  }

  // 4. 综合取交集并下限防护
  let recWc = Math.min(naturalWc, maxAllowedWc, delayConstraintWc);
  recWc = Math.max(0.1, Number(recWc.toFixed(2)));

  // 5. 针对控制器结构能力进行剪切频率二次校验与回退 (PI/P 无法提供超前相位)
  const struct = structure || 'PID';
  const recPmBase = desired_phase_margin !== undefined ? desired_phase_margin : 55;
  if (struct === 'PI' || struct === 'P') {
    const minPlantPhase = recPmBase - 180 + (struct === 'PI' ? 5 : 0);
    let safeWc = recWc;
    for (let iter = 0; iter < 40; iter++) {
      const gResp = evalPlantFreq(plant, safeWc);
      const gPhaseDeg = (gResp.phaseRad * 180) / Math.PI;
      const delayDeg = (-1.5 * safeWc * ts * 180) / Math.PI;
      const totalPhase = gPhaseDeg + delayDeg;
      if (totalPhase >= minPlantPhase || safeWc <= 0.1) {
        break;
      }
      safeWc *= 0.85;
    }
    if (safeWc < recWc * 0.95) {
      reasoning.push(
        `${struct} 结构天然无法提供超前相位，剪切频率由 ${recWc.toFixed(1)} rad/s 回退至 ${safeWc.toFixed(1)} rad/s 确保目标裕度可解`
      );
      recWc = Math.max(0.1, Number(safeWc.toFixed(2)));
    }
  }

  // 5. 期望相位裕度推荐 (默认 55°，滞后偏大时建议 60° 以确保无冲击)
  let recPm = desired_phase_margin !== undefined ? desired_phase_margin : 55;
  if (tauEff > 0.05) {
    recPm = Math.max(recPm, 60);
    reasoning.push('系统滞后相对偏大，相位裕度提升至 60° 强化鲁棒抗振阻尼');
  } else {
    reasoning.push('系统响应动态良好，推荐基准相位裕度 55° (兼顾快速无振荡与稳健性)');
  }

  return {
    recommended_omega_c: recWc,
    recommended_phase_margin: recPm,
    max_allowed_omega_c: Number(maxAllowedWc.toFixed(2)),
    reasoning,
  };
}

export const recommend_targets = recommendTargets;
