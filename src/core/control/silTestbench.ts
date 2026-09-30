/**
 * 软件在环测试台 (sil_testbench / silTestbench)
 * 构建纯确定性仿真环境，以已知真值参数 G(s) 运行离散闭环，验证辨识误差 < 10%
 * 并验证频域闭式解 PID 在真值对象上的实际闭环指标与预测值吻合度在 ±10% 内
 */

import type {
  SilTestbenchOptions,
  SilTestbenchResult,
} from './types';
import { evalFopdtStep, evalSopdtStep, evalIntegralLagStep, identifyPlant } from './identifyPlant';
import { recommendTargets } from './recommendTargets';
import { solvePid } from './solvePid';
import { simulateClosedLoop } from './simulateClosedLoop';

export function runSilTestbench(options: SilTestbenchOptions): SilTestbenchResult {
  const truePlant = options.truePlant;
  const ts = Math.max(1e-4, options.sampleTime || 0.005);
  const simDuration = options.simDuration || 2.5;
  const targetPm = options.targetPhaseMargin || 55;

  // 1. 生成真值对象的开环阶跃测试时序
  const n = Math.ceil(simDuration / ts) + 1;
  const times = new Array<number>(n);
  for (let i = 0; i < n; i++) times[i] = Number((i * ts).toFixed(5));

  let rawValues: number[] = [];
  if (truePlant.family === 'fopdt') {
    rawValues = evalFopdtStep(times, truePlant.k, truePlant.t, truePlant.tau, 0, 0, 1.0);
  } else if (truePlant.family === 'sopdt') {
    rawValues = evalSopdtStep(times, truePlant.k, truePlant.wn, truePlant.zeta, truePlant.tau, 0, 0, 1.0);
  } else {
    // integral_lag
    rawValues = evalIntegralLagStep(times, truePlant.k, truePlant.t, truePlant.tau, 0, 0, 1.0);
  }

  // 注入微弱底噪 (可选)
  const noiseStd = options.noiseStdDev || 0;
  const measuredValues = rawValues.map((v) => {
    if (noiseStd > 0) {
      const u1 = Math.random();
      const u2 = Math.random();
      const z0 = Math.sqrt(-2.0 * Math.log(u1 + 1e-12)) * Math.cos(2.0 * Math.PI * u2);
      return v + z0 * noiseStd;
    }
    return v;
  });

  // 2. 调用辨识引擎反推模型
  const idResult = identifyPlant(times, measuredValues, {
    family: truePlant.family,
    mode: 'open_loop',
    stepTime: 0,
    stepAmplitude: 1,
    sampleTime: ts,
  });

  const identifiedPlant = idResult.model;

  // 3. 计算辨识参数相对误差 (%)
  const errK = Math.abs(identifiedPlant.k - truePlant.k) / Math.abs(truePlant.k) * 100;
  let errTimeConst = 0;

  if (truePlant.family === 'fopdt' && identifiedPlant.family === 'fopdt') {
    errTimeConst = Math.abs(identifiedPlant.t - truePlant.t) / truePlant.t * 100;
  } else if (truePlant.family === 'sopdt' && identifiedPlant.family === 'sopdt') {
    errTimeConst = Math.abs(identifiedPlant.wn - truePlant.wn) / truePlant.wn * 100;
  } else if (truePlant.family === 'integral_lag' && identifiedPlant.family === 'integral_lag') {
    errTimeConst = Math.abs(identifiedPlant.t - truePlant.t) / truePlant.t * 100;
  }

  const errDelay = Math.abs((identifiedPlant.tau || 0) - (truePlant.tau || 0));
  const idPassed = idResult.usable && errK < 10.0 && errTimeConst < 10.0;

  // 4. 调用目标推荐引擎与 PID 闭式解算器
  const recTargets = recommendTargets({ plant: identifiedPlant, sampleTime: ts, desired_phase_margin: targetPm });
  const solved = solvePid(identifiedPlant, {
    target_omega_c: recTargets.recommended_omega_c,
    target_phase_margin: recTargets.recommended_phase_margin,
    structure: 'PID',
    sampleTime: ts,
  });

  const recPid = {
    kp: solved.kp,
    ki: solved.ki,
    kd: solved.kd,
    tf: solved.tf,
  };

  // 5. 在辨识模型上预先仿真 (理论预测)
  const predictedSim = simulateClosedLoop({
    plant: identifiedPlant,
    pid: recPid,
    sampleTime: ts,
    simTime: 3.0,
    stepValue: 1.0,
    initialValue: 0.0,
  });

  // 6. 在真值物理对象上运行离散闭环软件在环 (SIL 真实表现)
  const actualSim = simulateClosedLoop({
    plant: truePlant,
    pid: recPid,
    sampleTime: ts,
    simTime: 3.0,
    stepValue: 1.0,
    initialValue: 0.0,
  });

  if (!predictedSim.metrics || !actualSim.metrics) {
    const reason = predictedSim.metrics_error || actualSim.metrics_error || '仿真指标无效';
    return {
      ground_truth_plant: truePlant,
      identified_plant: identifiedPlant,
      identification_error_pct: {
        k: Number(errK.toFixed(2)),
        time_constant_or_wn: Number(errTimeConst.toFixed(2)),
        delay: Number(errDelay.toFixed(4)),
      },
      identification_passed: idPassed,
      recommended_pid: recPid,
      predicted_metrics: predictedSim.metrics,
      actual_sil_metrics: actualSim.metrics,
      overshoot_error_pct: null,
      sil_passed: false,
      summary: `SIL 未完成：${reason}`,
    };
  }

  // 7. 吻合度评估: 超调量吻合在 ±10% 误差带以内 (绝对偏差 <= 5% 或相对偏差 <= 10%)
  const predMp = predictedSim.metrics.overshoot_pct;
  const actualMp = actualSim.metrics.overshoot_pct;
  const diffMp = Math.abs(actualMp - predMp);
  const overshootMatchErrorPct = predMp > 1e-3 ? (diffMp / predMp) * 100 : diffMp;

  const silPassed = idPassed && (diffMp <= 5.0 || overshootMatchErrorPct <= 10.0);

  const summary = `SIL 闭环测试${silPassed ? '【通过】' : '【未通过】'}: 辨识增益误差 ${errK.toFixed(2)}%, 时间常数/固有频率误差 ${errTimeConst.toFixed(2)}%; 理论预测超调 Mp=${predMp.toFixed(1)}%, 真实闭环超调 Mp=${actualMp.toFixed(1)}% (吻合偏差: ${diffMp.toFixed(1)}%)。`;

  return {
    ground_truth_plant: truePlant,
    identified_plant: identifiedPlant,
    identification_error_pct: {
      k: Number(errK.toFixed(2)),
      time_constant_or_wn: Number(errTimeConst.toFixed(2)),
      delay: Number(errDelay.toFixed(4)),
    },
    identification_passed: idPassed,
    recommended_pid: recPid,
    predicted_metrics: predictedSim.metrics,
    actual_sil_metrics: actualSim.metrics,
    overshoot_error_pct: Number(overshootMatchErrorPct.toFixed(2)),
    sil_passed: silPassed,
    summary,
  };
}

export const sil_testbench = runSilTestbench;
