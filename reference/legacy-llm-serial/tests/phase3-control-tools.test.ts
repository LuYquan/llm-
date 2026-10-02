/**
 * Phase 3: 控制工具链与单环智能整定全量自动化测试套件
 * 涵盖：系统辨识、波特图与 ZOH 延时、PID 闭式解算、目标推荐、闭环仿真、离散化、SIL 软件在环测试台
 */

import assert from 'node:assert';
import type {
  FopdtModel,
  SopdtModel,
  IntegralLagModel,
} from '../src/core/control/types';
import {
  evalFopdtStep,
  evalSopdtStep,
  evalIntegralLagStep,
  identifyPlant,
} from '../src/core/control/identifyPlant';
import { computeBode } from '../src/core/control/computeBode';
import { solvePid } from '../src/core/control/solvePid';
import { recommendTargets } from '../src/core/control/recommendTargets';
import { simulateClosedLoop } from '../src/core/control/simulateClosedLoop';
import { discretizePid } from '../src/core/control/discretize';
import { runSilTestbench } from '../src/core/control/silTestbench';
import { getPidCandidateUseError, getSimulationInputError } from '../src/core/control/simulationReadiness';

export async function runPhase3ControlToolsTests(): Promise<void> {
  console.log('--- [Phase 3: Control Toolchain] 开始执行控制工具链全量测试套件 ---');

  console.log('  0. 测试仿真仅接受显式有效模型与 PID 输入');
  const validSimulationPlant: FopdtModel = { family: 'fopdt', k: 1.2, t: 0.2, tau: 0.01 };
  const validSimulationPid = { kp: 1.1, ki: 0.3, kd: 0.02, tf: 0.005 };
  assert.match(getSimulationInputError(null, validSimulationPid, 0.001) ?? '', /尚无有效对象模型/);
  assert.match(getSimulationInputError(validSimulationPlant, null, 0.001) ?? '', /尚无 PID 候选/);
  assert.match(getSimulationInputError(validSimulationPlant, validSimulationPid, 0) ?? '', /采样周期/);
  assert.match(getSimulationInputError({ ...validSimulationPlant, t: Number.NaN }, validSimulationPid, 0.001) ?? '', /时间常数/);
  assert.match(getSimulationInputError(validSimulationPlant, { ...validSimulationPid, kp: Number.NaN }, 0.001) ?? '', /PID 参数/);
  assert.equal(getSimulationInputError(validSimulationPlant, validSimulationPid, 0.001), null);
  assert.match(getPidCandidateUseError('example', true, validSimulationPlant, validSimulationPid, 0.001) ?? '', /示例模型/);
  assert.match(getPidCandidateUseError('identified', false, validSimulationPlant, null, 0.001) ?? '', /有效 PID 解算候选/);
  assert.equal(getPidCandidateUseError('manual', true, validSimulationPlant, validSimulationPid, 0.001), null);

  // ==========================================
  // 1. 任务 3.1: 系统辨识引擎测试
  // ==========================================
  console.log('  1. 测试系统辨识引擎 (FOPDT / SOPDT / 积分+惯性 / 闭环反推 / 置信度门禁)');

  // 1.1 FOPDT 开环阶跃拟合
  const timesFopdt = Array.from({ length: 200 }, (_, i) => i * 0.01);
  const trueK = 2.5;
  const trueT = 0.35;
  const trueTau = 0.04;
  const valsFopdt = evalFopdtStep(timesFopdt, trueK, trueT, trueTau, 0, 0, 1.0);

  const resFopdt = identifyPlant(timesFopdt, valsFopdt, { family: 'fopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 });
  assert.strictEqual(resFopdt.usable, true, 'FOPDT 拟合应可用');
  assert.ok(resFopdt.r_squared >= 0.98, `FOPDT R^2 需 >= 0.98，实际: ${resFopdt.r_squared}`);
  assert.strictEqual(resFopdt.confidence, 'high');
  const idModelFopdt = resFopdt.model as FopdtModel;
  assert.ok(Math.abs(idModelFopdt.k - trueK) / trueK < 0.05, `增益 K 误差需 < 5%，实际: ${idModelFopdt.k}`);
  assert.ok(Math.abs(idModelFopdt.t - trueT) / trueT < 0.08, `时间常数 T 误差需 < 8%，实际: ${idModelFopdt.t}`);

  // 1.2 SOPDT 欠阻尼阶跃拟合
  const timesSopdt = Array.from({ length: 250 }, (_, i) => i * 0.008);
  const trueWn = 12.0;
  const trueZeta = 0.42;
  const valsSopdt = evalSopdtStep(timesSopdt, 1.8, trueWn, trueZeta, 0.02, 0, 0, 1.0);

  const resSopdt = identifyPlant(timesSopdt, valsSopdt, { family: 'sopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 });
  assert.strictEqual(resSopdt.usable, true, 'SOPDT 拟合应可用');
  assert.ok(resSopdt.r_squared >= 0.98, `SOPDT R^2 需 >= 0.98，实际: ${resSopdt.r_squared}`);
  const idModelSopdt = resSopdt.model as SopdtModel;
  assert.ok(Math.abs(idModelSopdt.wn - trueWn) / trueWn < 0.08, `固有频率 wn 误差需 < 8%，实际: ${idModelSopdt.wn}`);
  assert.ok(Math.abs(idModelSopdt.zeta - trueZeta) / trueZeta < 0.10, `阻尼比 zeta 误差需 < 10%，实际: ${idModelSopdt.zeta}`);

  // 1.3 积分+惯性阶跃拟合
  const timesInt = Array.from({ length: 200 }, (_, i) => i * 0.01);
  const valsInt = evalIntegralLagStep(timesInt, 2.0, 0.3, 0.01, 0, 0, 1.0);
  const resInt = identifyPlant(timesInt, valsInt, { family: 'integral_lag', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 });
  assert.strictEqual(resInt.usable, true);
  assert.ok(resInt.r_squared >= 0.98);

  // 1.4 闭环反推模式测试 (由闭环响应反推对象)
  const trueClosedPlant: FopdtModel = { family: 'fopdt', k: 1.5, t: 0.25, tau: 0.02 };
  const ctrlParams = { kp: 1.2, ki: 0.4, kd: 0.0, sampleTime: 0.005 };
  const simClosed = simulateClosedLoop({
    plant: trueClosedPlant,
    pid: ctrlParams,
    sampleTime: 0.005,
    simTime: 1.5,
  });

  const resClosedId = identifyPlant(simClosed.times, simClosed.values, {
    mode: 'closed_loop',
    family: 'fopdt',
    controller: ctrlParams,
    stepTime: 0,
    stepAmplitude: 1,
    sampleTime: 0.005,
  });
  assert.strictEqual(resClosedId.usable, true);
  assert.ok(resClosedId.r_squared >= 0.90, `闭环反推 R^2 需 >= 0.90，实际: ${resClosedId.r_squared}`);

  // 1.5 置信度门禁拦截测试: 幅值过低与强噪声拦截
  const zeroVals = new Array(50).fill(1.0);
  const lowAmpResult = identifyPlant(timesFopdt.slice(0, 50), zeroVals, { family: 'fopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 });
  assert.strictEqual(lowAmpResult.usable, false, '零幅值必须拦截');
  assert.strictEqual(lowAmpResult.confidence, 'low');
  assert.ok(lowAmpResult.message.includes('幅值过低') || lowAmpResult.message.includes('无有效激励'));

  // 纯随机白噪声 (R^2 < 0.9)
  const noiseVals = Array.from({ length: 100 }, () => Math.random() * 10);
  const noiseResult = identifyPlant(timesFopdt.slice(0, 100), noiseVals, { family: 'fopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 });
  assert.strictEqual(noiseResult.usable, false, '低 R^2 数据必须禁止输出定量参数');
  assert.strictEqual(noiseResult.confidence, 'low');

  // 1.6 自动择优模式匹配积分+惯性族对象
  const valsIntAuto = evalIntegralLagStep(timesInt, 2.0, 0.25, 0.015, 0, 0, 1.0);
  const resIntAuto = identifyPlant(timesInt, valsIntAuto, { family: 'auto', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 });
  assert.strictEqual(resIntAuto.usable, true);
  assert.strictEqual(resIntAuto.model.family, 'integral_lag', `auto 模式需正确识别出 integral_lag，实际: ${resIntAuto.model.family}`);
  assert.ok(resIntAuto.r_squared >= 0.98);

  // 1.7 闭环反推含稳态误差 (纯 P 控制器) 测试
  const trueClosedP: FopdtModel = { family: 'fopdt', k: 2.0, t: 0.3, tau: 0.01 };
  const ctrlP = { kp: 1.5, ki: 0.0, kd: 0.0, sampleTime: 0.005 };
  const simClosedP = simulateClosedLoop({
    plant: trueClosedP,
    pid: ctrlP,
    sampleTime: 0.005,
    simTime: 2.0,
    stepValue: 1.0,
  });
  const resClosedP = identifyPlant(simClosedP.times, simClosedP.values, {
    mode: 'closed_loop',
    family: 'fopdt',
    controller: ctrlP,
    stepTime: 0,
    stepAmplitude: 1.0,
    sampleTime: 0.005,
  });
  assert.strictEqual(resClosedP.usable, true);
  assert.ok(resClosedP.r_squared >= 0.95);
  const idPModel = resClosedP.model as FopdtModel;
  assert.ok(Math.abs(idPModel.k - trueClosedP.k) / trueClosedP.k < 0.15, `纯 P 闭环反推 K 误差需 < 15%，实际: ${idPModel.k}`);

  // ==========================================
  // 2. 任务 3.2: 波特图计算引擎与 ZOH 延时测试
  // ==========================================
  console.log('  2. 测试波特图计算引擎与 ZOH 延时补偿 (-1.5ωTs*180/π)');

  const plantForBode: FopdtModel = { family: 'fopdt', k: 2.0, t: 0.2, tau: 0.01 };
  const tsBode = 0.001; // 1kHz 采样
  const bodeRes = computeBode(
    plantForBode,
    { kp: 1.5, ki: 0.8, kd: 0.0 },
    { sampleTime: tsBode, omegaMin: 0.1, omegaMax: 1000, pointsCount: 200 }
  );

  assert.ok(bodeRes.curve.length === 200);
  assert.ok(bodeRes.omega_c !== null, '必须存在剪切频率');
  assert.ok(bodeRes.phase_margin !== null, '必须存在相位裕度');
  assert.strictEqual(bodeRes.is_stable, true, '系统在设计参数下应闭环稳定');

  // 验证离散化 ZOH 延时: delay_phase_deg = -1.5 * ω * Ts * 180 / π
  for (const pt of bodeRes.curve) {
    const expectedDelay = (-1.5 * pt.omega * tsBode * 180) / Math.PI;
    assert.ok(
      Math.abs(pt.delay_phase_deg - expectedDelay) < 0.05,
      `ZOH 延时相位公式不符: 实际=${pt.delay_phase_deg}, 预期=${expectedDelay}`
    );
  }

  // 验证剪切频率定义: 在 ωc 处开环幅值接近 0 dB
  const wcPoint = bodeRes.curve.find((p) => Math.abs(p.omega - (bodeRes.omega_c || 0)) < 0.5);
  if (wcPoint) {
    assert.ok(Math.abs(wcPoint.mag_db) < 3.0, `剪切频率处幅值需接近 0dB，实际: ${wcPoint.mag_db}`);
  }

  // 2.2 积分+惯性对象的波特图与幅值裕度 (严防低频向下穿越误报)
  const plantIntBode: IntegralLagModel = { family: 'integral_lag', k: 2.0, t: 0.1, tau: 0.01 };
  const bodeIntRes = computeBode(
    plantIntBode,
    { kp: 1.0, ki: 0.5, kd: 0.05 },
    { sampleTime: 0.001, omegaMin: 0.1, omegaMax: 500 }
  );
  assert.ok(bodeIntRes.omega_c !== null && bodeIntRes.omega_c > 0);
  assert.ok(bodeIntRes.phase_margin !== null && bodeIntRes.phase_margin > 40);
  assert.strictEqual(bodeIntRes.is_stable, true, '积分+惯性配合合适 PID 闭环应稳定，幅值裕度不得被低频段误判为负');

  const noCrossoverRes = computeBode(
    { family: 'fopdt', k: 0, t: 0.2, tau: 0 },
    { kp: 1, ki: 0, kd: 0 },
    { sampleTime: 0.001, omegaMin: 0.1, omegaMax: 100, pointsCount: 80 }
  );
  assert.equal(noCrossoverRes.omega_c, null);
  assert.equal(noCrossoverRes.phase_margin, null);
  assert.equal(noCrossoverRes.is_stable, null, '没有 0 dB 剪切频率时必须显示未知，而不是不稳定');

  // ==========================================
  // 3. 任务 3.3: PID 闭式解算器测试
  // ==========================================
  console.log('  3. 测试 PID 频域闭式解算器 (P / PI / PD / 完整 PID 第三约束唯一正解)');

  const testPlant: FopdtModel = { family: 'fopdt', k: 1.5, t: 0.3, tau: 0.02 };
  const tsPid = 0.002;

  // 3.1 纯 P 结构解算
  const pSolved = solvePid(testPlant, {
    target_omega_c: 10.0,
    target_phase_margin: 45.0,
    structure: 'P',
    sampleTime: tsPid,
  });
  assert.strictEqual(pSolved.success, false, 'P 无相位调节自由度，不能把不相容的相位目标报为成功');
  assert.match(pSolved.message, /纯 P/);
  const feasiblePmP = 180 - Math.atan(10 * testPlant.t) * 180 / Math.PI - 10 * (testPlant.tau + 1.5 * tsPid) * 180 / Math.PI;
  const feasibleP = solvePid(testPlant, { target_omega_c: 10, target_phase_margin: feasiblePmP, structure: 'P', sampleTime: tsPid });
  assert.strictEqual(feasibleP.success, true, feasibleP.message);
  assert.ok(feasibleP.kp > 0);
  assert.strictEqual(feasibleP.ki, 0);
  assert.strictEqual(feasibleP.kd, 0);

  // 3.2 纯 PI 结构解算
  const piSolved = solvePid(testPlant, {
    target_omega_c: 5.0,
    target_phase_margin: 55.0,
    structure: 'PI',
    sampleTime: tsPid,
  });
  assert.strictEqual(piSolved.success, true);
  assert.ok(piSolved.kp > 0);
  assert.ok(piSolved.ki >= 0);
  assert.strictEqual(piSolved.kd, 0);
  // 代入重算验证达成的 ωc 与裕度
  if (piSolved.achieved_omega_c !== undefined) {
    assert.ok(Math.abs(piSolved.achieved_omega_c - 5.0) < 0.5, 'PI 重算 ωc 吻合');
  }

  // 3.3 完整 PID 结构解算 (第三约束 Td = Ti / 4 即 Kd*Ki = Kp^2 / 4)
  const pidSolved = solvePid(testPlant, {
    target_omega_c: 20.0,
    target_phase_margin: 50.0,
    structure: 'PID',
    sampleTime: tsPid,
  });
  assert.strictEqual(pidSolved.success, true);
  assert.ok(pidSolved.kp > 0, `Kp 需 > 0，实际: ${pidSolved.kp}`);
  assert.ok(pidSolved.ki > 0, `Ki 需 > 0，实际: ${pidSolved.ki}`);
  assert.ok(pidSolved.kd > 0, `Kd 需 > 0，实际: ${pidSolved.kd}`);

  // 严格检验第三约束: Kd * Ki == 0.25 * Kp^2
  const lhs = pidSolved.kd * pidSolved.ki;
  const rhs = 0.25 * pidSolved.kp * pidSolved.kp;
  const ratioErr = Math.abs(lhs - rhs) / rhs;
  assert.ok(ratioErr < 0.02, `完整 PID 第三约束 Td=Ti/4 需严格成立，相对误差=${(ratioErr * 100).toFixed(2)}%`);

  // 代入重算验证相位裕度吻合度在 1.5° 内
  if (pidSolved.achieved_phase_margin !== undefined) {
    assert.ok(Math.abs(pidSolved.achieved_phase_margin - 50.0) < 1.5, `达成相位裕度吻合: ${pidSolved.achieved_phase_margin}`);
  }

  // 3.4 完整 PID 结构解算 (指定微分转折频率约束 Td = 1/ωd => Kd = Kp / ωd)
  const wdTarget = 40.0;
  const pidWdSolved = solvePid(testPlant, {
    target_omega_c: 15.0,
    target_phase_margin: 50.0,
    structure: 'PID',
    derivativeCornerFrequency: wdTarget,
    sampleTime: tsPid,
  });
  assert.strictEqual(pidWdSolved.success, true);
  assert.ok(pidWdSolved.kp > 0);
  assert.ok(pidWdSolved.ki > 0);
  assert.ok(pidWdSolved.kd > 0);
  const expectedKd = pidWdSolved.kp / wdTarget;
  const kdErr = Math.abs(pidWdSolved.kd - expectedKd) / expectedKd;
  assert.ok(kdErr < 0.02, `Kd 需满足 Kp/ωd，实际: ${pidWdSolved.kd}, 预期: ${expectedKd}`);

  // ==========================================
  // 4. 任务 3.4: 目标推荐、闭环仿真与离散化测试
  // ==========================================
  console.log('  4. 测试目标推荐 (fs/10)、闭环时域仿真与单片机离散差分方程');

  // 4.1 目标推荐引擎
  const recRes = recommendTargets({
    plant: testPlant,
    sampleTime: 0.005, // fs = 200Hz => ωs = 400π => 0.2π/Ts = 125.6 rad/s
    desired_phase_margin: 55,
  });
  assert.ok(recRes.recommended_omega_c <= recRes.max_allowed_omega_c, '推荐剪切频率严禁超过 fs/10');
  assert.strictEqual(recRes.recommended_phase_margin, 55);
  assert.ok(recRes.reasoning.length >= 3, '应输出详细机理推导链条');

  // 4.2 闭环时域阶跃仿真与限幅抗饱和
  const simRes = simulateClosedLoop({
    plant: testPlant,
    pid: { kp: 1.8, ki: 3.0, kd: 0.05 },
    sampleTime: 0.002,
    simTime: 3.0,
    stepValue: 1.0,
    outputLimits: [-10, 10], // 限幅测试
    antiWindup: true,
  });

  assert.ok(simRes.times.length > 50);
  assert.strictEqual(simRes.references[0], 1.0);
  // 检查控制量全时段是否在 [-10, 10] 内
  for (const u of simRes.controls) {
    assert.ok(u >= -10.0001 && u <= 10.0001, `控制量超出限幅: ${u}`);
  }
  // 检查指标提取
  assert.ok(simRes.metrics, '有效仿真应产生分析指标');
  assert.ok(simRes.metrics.overshoot_pct >= 0);
  assert.ok(simRes.metrics.steady_state_error < 0.05, `稳态误差需收敛，实际: ${simRes.metrics.steady_state_error}`);
  assert.strictEqual(simRes.metrics.is_stable, true);

  const insufficientSim = simulateClosedLoop({
    plant: testPlant,
    pid: { kp: 1.0, ki: 0.1, kd: 0 },
    sampleTime: 0.01,
    simTime: 0.02,
  });
  assert.strictEqual(insufficientSim.metrics, null, '样本不足时必须返回未计算，不得默认稳定');
  assert.match(insufficientSim.metrics_error || '', /未计算/);

  // 4.3 差分方程离散化与 C 代码生成
  const discRes = discretizePid({
    kp: 2.5,
    ki: 0.8,
    kd: 0.05,
    sampleTime: 0.001,
    outputLimits: [-100, 100],
  });

  // 位置式系数
  assert.strictEqual(discRes.positional.kp, 2.5);
  assert.strictEqual(discRes.positional.ki_factor, 0.0008); // 0.8 * 0.001
  assert.strictEqual(discRes.positional.kd_factor, 50.0);   // 0.05 / 0.001
  assert.ok(discRes.positional.c_code.includes('PositionalPID_Update'));

  // 增量式系数
  // A = Kp + Ki*Ts + Kd/Ts = 2.5 + 0.0008 + 50 = 52.5008
  // B = -Kp - 2*Kd/Ts = -2.5 - 100 = -102.5
  // C = Kd/Ts = 50
  assert.strictEqual(discRes.incremental.a, 52.5008);
  assert.strictEqual(discRes.incremental.b, -102.5);
  assert.strictEqual(discRes.incremental.c, 50.0);
  // 增量式恒等式: A + B + C == Ki * Ts
  const sumCoeff = discRes.incremental.a + discRes.incremental.b + discRes.incremental.c;
  assert.ok(Math.abs(sumCoeff - 0.0008) < 1e-6, `增量式系数和需等于 Ki*Ts: ${sumCoeff}`);
  assert.ok(discRes.incremental.c_code.includes('IncrementalPID_Update'));

  // 4.4 针对 PI 控制结构的相位超前限制与带宽自适应回退
  const plantIntForRec: IntegralLagModel = { family: 'integral_lag', k: 2.0, t: 0.1, tau: 0.01 };
  const recPiRes = recommendTargets({
    plant: plantIntForRec,
    sampleTime: 0.005,
    desired_phase_margin: 55,
    structure: 'PI',
  });
  // 必须回退剪切频率以保证 PI 能够闭式解出有效正增益
  const piCheckSolved = solvePid(plantIntForRec, {
    target_omega_c: recPiRes.recommended_omega_c,
    target_phase_margin: recPiRes.recommended_phase_margin,
    structure: 'PI',
    sampleTime: 0.005,
  });
  assert.strictEqual(piCheckSolved.success, true, '自适应回退后的推荐目标必须能被 PI 结构成功解出');
  assert.ok(piCheckSolved.kp > 0 && piCheckSolved.ki >= 0);

  // ==========================================
  // 5. 任务 3.5: 软件在环测试台 (SIL Testbench)
  // ==========================================
  console.log('  5. 测试软件在环测试台 (SIL Benchmark: 辨识误差 < 10%, 闭环超调吻合度 < 10%)');

  // 5.1 FOPDT SIL Benchmark
  const silFopdt = runSilTestbench({
    truePlant: { family: 'fopdt', k: 2.0, t: 0.25, tau: 0.02 },
    sampleTime: 0.005,
    simDuration: 2.0,
    targetPhaseMargin: 55,
  });
  assert.strictEqual(silFopdt.identification_passed, true, `FOPDT 辨识未达标: ${silFopdt.summary}`);
  assert.strictEqual(silFopdt.sil_passed, true, `FOPDT SIL 闭环预测未达标: ${silFopdt.summary}`);
  assert.ok(silFopdt.identification_error_pct.k < 10.0);
  assert.ok(silFopdt.identification_error_pct.time_constant_or_wn < 10.0);

  // 5.2 SOPDT SIL Benchmark
  const silSopdt = runSilTestbench({
    truePlant: { family: 'sopdt', k: 1.5, wn: 10.0, zeta: 0.45, tau: 0.01 },
    sampleTime: 0.003,
    simDuration: 2.0,
    targetPhaseMargin: 55,
  });
  assert.strictEqual(silSopdt.identification_passed, true, `SOPDT 辨识未达标: ${silSopdt.summary}`);
  assert.strictEqual(silSopdt.sil_passed, true, `SOPDT SIL 闭环预测未达标: ${silSopdt.summary}`);

  // 5.3 积分+惯性对象 SIL Benchmark (验证真实阶跃响应生成与吻合度)
  const silInt = runSilTestbench({
    truePlant: { family: 'integral_lag', k: 2.0, t: 0.15, tau: 0.01 },
    sampleTime: 0.005,
    simDuration: 2.5,
    targetPhaseMargin: 55,
  });
  assert.strictEqual(silInt.identification_passed, true, `积分+惯性辨识未达标: ${silInt.summary}`);
  assert.strictEqual(silInt.sil_passed, true, `积分+惯性 SIL 闭环预测未达标: ${silInt.summary}`);
  assert.ok(silInt.identification_error_pct.k < 10.0);
  assert.ok(silInt.identification_error_pct.time_constant_or_wn < 10.0);

  console.log('✓ [Phase 3: Control Toolchain] 所有控制理论工具链与 SIL 在环测试 100% 全部通过！\n');
}
