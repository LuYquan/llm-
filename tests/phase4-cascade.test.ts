/**
 * Phase 4: 串级多环与模板自动化测试套件
 * 涵盖：
 * 1. 串级整定状态机 (CascadeStateMachine) 先内后外铁律与级联失效
 * 2. 外环等效受控对象模型复合生成 (composeOuterPlant)
 * 3. 带宽分层检查器 (BandwidthChecker) 与采样定理香农上限
 * 4. 高级控制器结构生成器 (AdvancedControllerGenerator) C 语言固件驱动与拓扑智能推荐
 * 5. BodeWidget 注册表与尺寸配置验证
 */

import assert from 'node:assert';
import { CascadeStateMachine } from '../src/core/control/cascadeStateMachine.ts';
import { BandwidthChecker } from '../src/core/control/bandwidthChecker.ts';
import { AdvancedControllerGenerator } from '../src/core/control/advancedController.ts';
import { globalWidgetRegistry } from '../src/core/widget/registry.ts';
import type { ControlLoop } from '../src/core/project/types.ts';
import type { PlantModel } from '../src/core/control/types.ts';

export async function runPhase4CascadeTests(): Promise<void> {
  console.log('--- [Phase 4: Cascade & Templates] 开始执行串级多环与模板测试套件 ---');

  // 1. 串级整定状态机测试
  console.log('  1. 测试 CascadeStateMachine 先内后外整定铁律与状态机跃迁');

  const mockLoops: ControlLoop[] = [
    {
      id: 'current',
      name: '电流内环',
      order: 0,
      structure: 'PI',
      plant_family: 'first_order',
      state: 'untuned',
      sample_time: 0.0005,
      current_params: { kp: 5.0, ki: 200, kd: 0 },
    },
    {
      id: 'speed',
      name: '速度中环',
      order: 1,
      structure: 'PI',
      plant_family: 'first_order_plus_delay',
      state: 'untuned',
      sample_time: 0.001,
      current_params: { kp: 1.5, ki: 20, kd: 0 },
    },
    {
      id: 'position',
      name: '位置外环',
      order: 2,
      structure: 'P',
      plant_family: 'integrator_plus_lag',
      state: 'untuned',
      sample_time: 0.002,
      current_params: { kp: 0.8, ki: 0, kd: 0 },
    },
  ];

  const sm = new CascadeStateMachine(mockLoops);

  // 1.1 最内环 (order 0) 允许直接进入辨识
  const canIdCurrent = sm.canIdentify('current');
  assert.strictEqual(canIdCurrent.allowed, true, '最内环应允许辨识');

  // 1.2 外环 (order 1 速度环) 在内环未整定时，严禁辨识！
  const canIdSpeed = sm.canIdentify('speed');
  assert.strictEqual(canIdSpeed.allowed, false, '内环未整定时外环严禁辨识');
  assert.ok(canIdSpeed.reason?.includes('串级整定次序拦截'), '应给出拦截原因');

  // 1.3 最内环跃迁至 identified，再跃迁至 tuned
  const transId = sm.transition('current', 'identified');
  assert.strictEqual(transId.success, true);
  const transTune = sm.transition('current', 'tuned');
  assert.strictEqual(transTune.success, true);
  assert.strictEqual(sm.getLoop('current')?.state, 'tuned');

  // 1.4 内环 tuned 后，速度中环允许开始辨识
  const canIdSpeedNow = sm.canIdentify('speed');
  assert.strictEqual(canIdSpeedNow.allowed, true, '内环整定后中环应允许辨识');

  // 1.5 位置外环 (order 2) 此时仍被拦截 (因为速度中环尚未 tuned)
  const canIdPos = sm.canIdentify('position');
  assert.strictEqual(canIdPos.allowed, false, '中环未整定时最外环依然拦截');

  // 1.6 速度中环整定完毕
  assert.strictEqual(sm.transition('speed', 'identified').success, true);
  assert.strictEqual(sm.transition('speed', 'tuned').success, true);

  // 1.7 位置外环允许整定
  assert.strictEqual(sm.canIdentify('position').allowed, true);
  assert.strictEqual(sm.transition('position', 'identified').success, true);
  assert.strictEqual(sm.transition('position', 'tuned').success, true);
  assert.strictEqual(sm.getLoop('position')?.state, 'tuned');

  // 1.8 级联失效测试：若内环 (current) 重新修改为 untuned，外环必须自动失效回退！
  const transInvalidate = sm.transition('current', 'untuned');
  assert.strictEqual(transInvalidate.success, true);
  assert.ok(transInvalidate.invalidatedLoops.includes('speed'), '中环应被级联失效');
  assert.ok(transInvalidate.invalidatedLoops.includes('position'), '外环应被级联失效');
  assert.strictEqual(sm.getLoop('speed')?.state, 'untuned');
  assert.strictEqual(sm.getLoop('position')?.state, 'untuned');

  // 2. 外环等效受控对象模型复合生成测试
  console.log('  2. 测试 composeOuterPlant 外环广义受控对象模型合成');

  const innerPlant: PlantModel = { family: 'fopdt', k: 2.0, t: 0.05, tau: 0.001 };
  const innerPid = { kp: 1.5, ki: 20.0, kd: 0.0 };

  // 2.1 位置外环复合位置积分 (1/s)
  const outerPlantPos = sm.composeOuterPlant(innerPlant, innerPid, {
    addition: 'integrator',
    extraGain: 1.0,
    delay: 0.002,
  });
  assert.strictEqual(outerPlantPos.family, 'integral_lag', '位置外环合成应为积分惯性模型');
  assert.ok(outerPlantPos.t > 0, '等效时间常数应大于0');
  assert.ok(outerPlantPos.tau >= 0.002, '延迟应叠加');

  // 2.2 温度多容复合惯性延时
  const outerPlantTemp = sm.composeOuterPlant(innerPlant, innerPid, {
    addition: 'lag',
    extraGain: 2.5,
    lagT: 0.2,
  });
  assert.strictEqual(outerPlantTemp.family, 'sopdt', '多容惯性串联应为二阶振荡模型');
  assert.strictEqual(outerPlantTemp.k, 2.5);
  assert.ok(outerPlantTemp.wn > 0);
  assert.ok(outerPlantTemp.zeta > 0);

  // 2.3 管道全景状态概要生成
  const pipeline = sm.getPipelineStatus('current');
  assert.strictEqual(pipeline.items.length, 3);
  assert.ok(pipeline.formattedBadge.includes('[环路:'));

  // 3. 带宽分层检查器测试
  console.log('  3. 测试 BandwidthChecker 带宽分层准则与采样定理安全上限');

  // 3.1 正常合格分层 (内环 300 rad/s, 外环 50 rad/s, 隔离比 6.0x)
  const pairNormal = BandwidthChecker.checkPair(
    { id: 'inner', name: '电流环', order: 0, omega_c: 300 },
    { id: 'outer', name: '速度环', order: 1, omega_c: 50 }
  );
  assert.strictEqual(pairNormal.passed, true);
  assert.strictEqual(pairNormal.risk_level, 'safe');
  assert.strictEqual(pairNormal.ratio, 6.0);

  // 3.2 致命缺陷：带宽倒置 (外环比内环更快)
  const pairInverted = BandwidthChecker.checkPair(
    { id: 'inner', name: '内环', order: 0, omega_c: 40 },
    { id: 'outer', name: '外环', order: 1, omega_c: 80 }
  );
  assert.strictEqual(pairInverted.passed, false);
  assert.strictEqual(pairInverted.risk_level, 'critical');
  assert.ok(pairInverted.message.includes('串级带宽倒置'));

  // 3.3 高危预警：带宽严重重叠 (隔离比 2.0x < 3.0x)
  const pairOverlap = BandwidthChecker.checkPair(
    { id: 'inner', name: '内环', order: 0, omega_c: 100 },
    { id: 'outer', name: '外环', order: 1, omega_c: 50 }
  );
  assert.strictEqual(pairOverlap.passed, false);
  assert.strictEqual(pairOverlap.risk_level, 'high');
  assert.ok(pairOverlap.message.includes('低于工业安全底线 3.0x'));

  // 3.4 全系统多环拓扑检查与香农采样定理上限测试
  const hierarchyReport = BandwidthChecker.checkHierarchy([
    { id: 'current', order: 0, omega_c: 600, sampleTime: 0.0005 }, // fs = 2000Hz, maxWc = 1256 rad/s -> safe
    { id: 'speed', order: 1, omega_c: 100, sampleTime: 0.001 },    // fs = 1000Hz, maxWc = 628 rad/s -> safe
    { id: 'pos', order: 2, omega_c: 20, sampleTime: 0.01 },       // fs = 100Hz, maxWc = 62.8 rad/s -> safe
  ]);
  assert.strictEqual(hierarchyReport.passed, true);
  assert.strictEqual(hierarchyReport.overall_risk, 'safe');
  assert.strictEqual(hierarchyReport.pairs.length, 2);

  // 3.5 触发奈奎斯特采样违例
  const nyquistViolation = BandwidthChecker.checkHierarchy([
    { id: 'fast', order: 0, omega_c: 800, sampleTime: 0.005 }, // fs = 200Hz, max allowed Wc = 125.6 rad/s < 800
  ]);
  assert.strictEqual(nyquistViolation.passed, false);
  assert.ok(nyquistViolation.nyquist_warnings.length > 0);
  assert.ok(nyquistViolation.nyquist_warnings[0].includes('采样定理安全上限'));

  // 4. 高级控制器结构生成器测试
  console.log('  4. 测试 AdvancedControllerGenerator 工业级固件驱动生成');

  // 4.1 微分先行 PID (Derivative on PV)
  const pvCode = AdvancedControllerGenerator.generateDerivativeOnPVCode({
    kp: 12.5,
    ki: 2.0,
    kd: 0.15,
    sampleTime: 0.001,
    loopName: 'Speed',
  });
  assert.ok(pvCode.includes('PidOnPv_Speed_t'), '应包含结构体声明');
  assert.ok(pvCode.includes('(feedback - pid->prev_feedback)'), '必须对测量值求差分');
  assert.ok(pvCode.includes('Anti-Windup'), '应包含抗饱和钳位');

  // 4.2 带滤波微分 PID (Filtered Derivative)
  const filtCode = AdvancedControllerGenerator.generateFilteredDerivativeCode({
    kp: 8.0,
    ki: 1.0,
    kd: 0.2,
    sampleTime: 0.002,
    tf: 0.008,
    loopName: 'Arm',
  });
  assert.ok(filtCode.includes('PidFiltered_Arm_t'));
  assert.ok(filtCode.includes('d_filtered'));
  assert.ok(filtCode.includes('alpha'));

  // 4.3 前馈复合 PID (Feedforward PID)
  const ffCode = AdvancedControllerGenerator.generateFeedforwardPidCode({
    kp: 10.0,
    ki: 0.5,
    kd: 0.05,
    sampleTime: 0.001,
    kv_ff: 1.05,
    ka_ff: 0.015,
    friction_ff: 0.8,
    loopName: 'Position',
  });
  assert.ok(ffCode.includes('FeedforwardPid_Position_t'));
  assert.ok(ffCode.includes('kv_ff * vel_target'));
  assert.ok(ffCode.includes('ka_ff * acc_target'));
  assert.ok(ffCode.includes('friction_ff'));

  // 4.4 针对环路智能推荐控制器结构
  const currentRec = AdvancedControllerGenerator.recommendAdvancedController({
    id: 'current_loop',
    name: '电机电流环',
    order: 0,
    structure: 'PI',
    plant_family: 'first_order',
    state: 'untuned',
  });
  assert.ok(currentRec.recommended_structure.includes('PI + 抗积分饱和'));
  assert.ok(currentRec.rationale.some((r) => r.includes('严禁引入微分项 Kd')));

  const posRec = AdvancedControllerGenerator.recommendAdvancedController({
    id: 'pos_loop',
    name: '位置外环',
    order: 2,
    structure: 'P',
    plant_family: 'integrator_plus_lag',
    state: 'untuned',
  });
  assert.ok(posRec.recommended_structure.includes('前馈') || posRec.recommended_structure.includes('P'));

  // 5. BodeWidget 注册表自洽性测试
  console.log('  5. 测试 BodeWidget 在 WidgetRegistry 中的元数据注册');
  assert.strictEqual(globalWidgetRegistry.has('bode'), true, 'WidgetRegistry 应已注册 bode 控件');
  const bodeDef = globalWidgetRegistry.get('bode');
  assert.ok(bodeDef);
  assert.strictEqual(bodeDef?.category, 'analysis');
  assert.strictEqual(bodeDef?.defaultSize.w, 560);
  assert.strictEqual(bodeDef?.defaultSize.h, 360);

  const bodeInst = globalWidgetRegistry.createInstance('bode', 40, 60, '开环波特图');
  assert.strictEqual(bodeInst.type, 'bode');
  assert.strictEqual(bodeInst.x, 40);
  assert.strictEqual(bodeInst.y, 60);

  console.log('✓ [Phase 4: Cascade & Templates] 串级多环与模板自动化测试全部通过！\n');
}
