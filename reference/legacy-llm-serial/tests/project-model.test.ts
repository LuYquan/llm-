/**
 * ProjectModel 环路拓扑配置与持久化测试
 */

import assert from 'node:assert/strict';
import {
  ProjectModelManager,
  validateProjectModel,
  BUILTIN_PROJECT_TEMPLATES,
} from '../src/core/project';

export async function runProjectModelTests() {
  console.log('--- [ProjectModel] 开始测试环路拓扑配置 Schema 与持久化 ---');

  // 1. 内置模板校验测试
  {
    console.log('  1. 测试内置拓扑模板 (foc_3loop / drone_cascade / temperature_single / generic_single)');
    for (const [name, factory] of Object.entries(BUILTIN_PROJECT_TEMPLATES)) {
      const model = factory();
      const check = validateProjectModel(model);
      assert.equal(check.valid, true, `模板 ${name} 校验未通过: ${check.errors.join(', ')}`);
      assert.ok(model.loops.length >= 1);
    }
  }

  // 2. Schema 校验拦截测试 (非法数据防御)
  {
    console.log('  2. 测试 Schema 非法配置拦截 (重复 ID、层级冲突、负采样周期、限幅倒置、伪模型)');
    // 负采样周期
    const badTs = { ...BUILTIN_PROJECT_TEMPLATES.generic_single(), sample_period_s: -0.01 };
    assert.equal(validateProjectModel(badTs).valid, false);

    // 重复 ID
    const dupIdModel = BUILTIN_PROJECT_TEMPLATES.foc_3loop();
    dupIdModel.loops[1].id = dupIdModel.loops[0].id;
    assert.equal(validateProjectModel(dupIdModel).valid, false);

    // 层级 order 冲突
    const conflictOrder = BUILTIN_PROJECT_TEMPLATES.foc_3loop();
    conflictOrder.loops[1].order = conflictOrder.loops[0].order;
    assert.equal(validateProjectModel(conflictOrder).valid, false);

    // Kp 下限大于上限
    const badLimits = BUILTIN_PROJECT_TEMPLATES.generic_single();
    badLimits.loops[0].param_limits.kp = [100, 10]; // min > max
    assert.equal(validateProjectModel(badLimits).valid, false);

    // active_loop_id 不在 loops 中
    const badActiveId = { ...BUILTIN_PROJECT_TEMPLATES.generic_single(), active_loop_id: 'unknown_loop' };
    assert.equal(validateProjectModel(badActiveId).valid, false);

    // plant_family 不是对象参数；无效辨识模型必须拒绝，避免波特图显示伪指标。
    const badIdentifiedModel = BUILTIN_PROJECT_TEMPLATES.generic_single();
    badIdentifiedModel.loops[0].identified_model = { family: 'fopdt', k: 1, t: 0, tau: 0 };
    assert.equal(validateProjectModel(badIdentifiedModel).valid, false);

    const validIdentifiedModel = BUILTIN_PROJECT_TEMPLATES.generic_single();
    validIdentifiedModel.loops[0].identified_model = { family: 'fopdt', k: 1.2, t: 0.12, tau: 0.01 };
    assert.equal(validateProjectModel(validIdentifiedModel).valid, true);
  }

  // 3. ProjectModelManager 拓扑管理与 CRUD
  {
    console.log('  3. 测试 ProjectModelManager 拓扑增删改查与串级内环到外环排序');
    const mgr = new ProjectModelManager('foc_3loop');
    const loops = mgr.getLoops();
    assert.equal(loops.length, 3);
    assert.equal(loops[0].id, 'current'); // order 0
    assert.equal(loops[1].id, 'speed');   // order 1
    assert.equal(loops[2].id, 'position');// order 2

    // 状态变迁测试 untuned -> identified -> tuned
    assert.equal(mgr.getLoop('speed')?.state, 'untuned');
    mgr.setLoopState('speed', 'identified');
    assert.equal(mgr.getLoop('speed')?.state, 'identified');
    mgr.setLoopState('speed', 'tuned');
    assert.equal(mgr.getLoop('speed')?.state, 'tuned');

    // 切换激活环路
    assert.equal(mgr.setActiveLoop('speed'), true);
    assert.equal(mgr.getActiveLoop()?.id, 'speed');

    // 指令模板渲染
    const rendered = mgr.renderCommand('speed', { kp: 7.5, ki: 0.35, kd: 0.05 });
    assert.equal(rendered, 'SET_PID 1 7.5000 0.3500 0.0500');
  }

  // 4. SafetyGuard 本地确定性规则校验测试
  {
    console.log('  4. 测试 ProjectModelManager.checkSafety 本地确定性安全卫士');
    const mgr = new ProjectModelManager('foc_3loop');

    // (1) 合法参数检查 (内环 current 为 PI 控制器)
    const validCurrent = mgr.checkSafety('current', { kp: 12.0, ki: 250.0, kd: 0.0 });
    assert.equal(validCurrent.passed, true);
    assert.equal(validCurrent.risk_level, 'low');

    // (2) 电流环非零 Kd 警告
    const currentWithKd = mgr.checkSafety('current', { kp: 12.0, ki: 250.0, kd: 1.0 });
    assert.ok(currentWithKd.warnings.some((w) => w.includes('电流内环强烈建议 Kd = 0')));

    // (3) 参数超出范围与负数拦截
    const outLimits = mgr.checkSafety('current', { kp: -5.0, ki: 6000.0, kd: 0.0 });
    assert.equal(outLimits.passed, false);
    assert.ok(outLimits.errors.some((e) => e.includes('不能为负数')));
    assert.ok(outLimits.errors.some((e) => e.includes('超出允许区间')));

    // (4) 串级顺序拦截：内环 current 为 untuned 时整定外环 speed 应标记为高风险并给出暂缓警告
    const speedCheck = mgr.checkSafety('speed', { kp: 5.5, ki: 22.0, kd: 0.1 });
    assert.equal(speedCheck.risk_level, 'high');
    assert.ok(speedCheck.warnings.some((w) => w.includes('串级内环')));

    // (5) 大步长变化警告 (>50% 变化)
    mgr.setLoopState('current', 'tuned'); // 先将内环设为 tuned
    const bigJump = mgr.checkSafety('speed', { kp: 15.0, ki: 20.0, kd: 0.1 }); // 原 kp 为 5，跳变至 15 (+200%)
    assert.equal(bigJump.risk_level, 'high');
    assert.ok(bigJump.warnings.some((w) => w.includes('> 50%')));
  }

  // 5. 序列化与反序列化导入导出测试
  {
    console.log('  5. 测试 ProjectModel JSON 导出与恢复导入');
    const mgr = new ProjectModelManager('drone_cascade');
    const jsonStr = mgr.exportJson();
    assert.ok(jsonStr.includes('drone_cascade'));

    const newMgr = new ProjectModelManager('generic_single');
    const res = newMgr.importJson(jsonStr);
    assert.equal(res.success, true);
    assert.equal(newMgr.getModel().template, 'drone_cascade');
    assert.equal(newMgr.getLoops().length, 2);
  }

  console.log('  ✓ [ProjectModel] 环路拓扑配置与持久化测试全部通过！\n');
}
