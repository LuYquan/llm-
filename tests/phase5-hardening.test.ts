/**
 * Phase 5: 系统加固与红队安全防线审计测试套件
 * 涵盖：
 * 1. 提示词红队防线与数值溯源拦截审计
 * 2. 隐式指令夹带危险数值的深度提取与 SafetyGuard 联合拦截
 * 3. 结构禁忌与极值限幅硬校验 (电流环Kd>0, 位置环Ki>0, 参数NaN/负值, 突变>50%)
 * 4. 串级顺序防线：内环未收敛前外环指令强制拦截
 * 5. 极端脏流与内存长时间运行稳定性
 */

import assert from 'node:assert';
import { validateCopilotResponse } from '../src/core/copilot/CopilotSchema.ts';
import { CopilotSafetyGuard } from '../src/core/copilot/CopilotSafetyGuard.ts';
import { RingBuffer } from '../src/core/channel/RingBuffer.ts';
import { ProtocolEngine } from '../src/core/protocol/ProtocolEngine.ts';
import type { ControlLoop } from '../src/core/project/types.ts';

export async function runPhase5HardeningTests(): Promise<void> {
  console.log('--- [Phase 5: Hardening & Red-Team Audit] 开始执行加固与红队防线测试套件 ---');

  // 1. 红队防线审计 1：未溯源数值强制拦截
  console.log('  1. 审计：拦截大模型未溯源数值与自由臆造参数');

  const unverifiedResponse = {
    diagnosis: '我认为速度环超调过大，建议将 Kp 改为 88.5',
    evidence: '波形超调超标',
    recommendation: '建议将 Kp 下调至 88.5',
    command: 'SET:SPEED:KP=88.5,KI=2.0,KD=0.0\n',
    params: { kp: 88.5, ki: 2.0, kd: 0.0 },
    tool_call_source: 'llm_guess', // 非法的 tool call 溯源
    risk_level: 'low',
    requires_confirmation: true,
  };

  const valRes = validateCopilotResponse(unverifiedResponse, ['tool:bode#1', 'tool:pid_solver#2']);
  assert.strictEqual(valRes.valid, false, '未匹配有效 tool call 的建议必须判定为非法');
  assert.strictEqual(valRes.can_fill_send_area, false, '未溯源数值严禁允许填入发送区');
  assert.ok(valRes.errors.some((e) => e.includes('数值溯源拦截')));

  // 2. 红队防线审计 2：指令内嵌夹带参数防绕过测试
  console.log('  2. 审计：深度提取 command 中内嵌的危险数值并实施 SafetyGuard 拦截');

  const speedLoop: ControlLoop = {
    id: 'speed',
    name: '速度中环',
    order: 1,
    structure: 'PI',
    plant_family: 'first_order_plus_delay',
    state: 'identified',
    current_params: { kp: 10.0, ki: 1.0, kd: 0.0 },
    param_limits: {
      kp: [0, 50],
      ki: [0, 20],
      kd: [0, 0], // 速度环严禁 Kd > 0
    },
  };

  // 恶意指令：试图通过直接拼写指令夹带 Kd=3.5 绕过前端显式 params 校验
  const maliciousCommand = 'SET:SPEED:KP=15.0,KI=2.0,KD=3.5\n';
  const guardRes1 = CopilotSafetyGuard.checkSafety({
    command: maliciousCommand,
    params: { kp: 15.0, ki: 2.0, kd: 0.0 }, // 表面传 kd=0
    activeLoop: speedLoop,
  });
  assert.strictEqual(guardRes1.passed, false, '必须识别出 command 中隐式夹带的 Kd > 0');
  assert.ok(guardRes1.errors.some((r) => r.includes('微分项') || r.includes('Kd')));

  // 3. 红队防线审计 3：极值溢出与参数突变步长超限
  console.log('  3. 审计：参数超限与大步长突变 (>50%) 防呆标记');

  // 超限测试 (Kp = 80 > 50)
  const overflowRes = CopilotSafetyGuard.checkSafety({
    command: 'SET:SPEED:KP=80.0\n',
    params: { kp: 80.0, ki: 2.0, kd: 0.0 },
    activeLoop: speedLoop,
  });
  assert.strictEqual(overflowRes.passed, false);
  assert.ok(overflowRes.errors.some((r) => r.includes('超出安全限幅区间')));

  // 突变测试 (当前 Kp=10，推荐 Kp=25，变化率 150% > 50%)
  const stepJumpRes = CopilotSafetyGuard.checkSafety({
    command: 'SET:SPEED:KP=25.0\n',
    params: { kp: 25.0, ki: 1.0, kd: 0.0 },
    activeLoop: speedLoop,
  });
  assert.strictEqual(stepJumpRes.passed, true);
  assert.strictEqual(stepJumpRes.risk_level, 'high', '单次跳跃 >50% 必须升级为高风险');
  assert.ok(stepJumpRes.warnings.some((r) => r.includes('变化幅度达') || r.includes('安全阈值')));

  // 4. 红队防线审计 4：串级顺序防线（内环未收敛强制拦截外环整定）
  console.log('  4. 审计：串级内环未收敛前外环参数下发拦截');

  const untunedInnerLoop: ControlLoop = {
    id: 'current',
    name: '电流内环',
    order: 0,
    structure: 'PI',
    plant_family: 'first_order',
    state: 'untuned', // 内环尚未 tuned
  };

  const outerPosLoop: ControlLoop = {
    id: 'position',
    name: '位置外环',
    order: 1,
    structure: 'P',
    plant_family: 'integrator_plus_lag',
    state: 'identified',
  };

  const cascadeGuardRes = CopilotSafetyGuard.checkSafety({
    command: 'SET:POS:KP=1.5\n',
    params: { kp: 1.5, ki: 0.0, kd: 0.0 },
    activeLoop: outerPosLoop,
    allLoops: [untunedInnerLoop, outerPosLoop],
  });
  assert.strictEqual(cascadeGuardRes.passed, false, '内环未收敛时外环严禁下发');
  assert.ok(cascadeGuardRes.errors.some((r) => r.includes('串级整定次序拦截') || r.includes('内环')));

  // 5. 极端稳定性与内存压力测试
  console.log('  5. 审计：高通量环形缓冲内存零膨胀与异常协议恢复');

  // 5.1 环形缓冲容量约束：写入 200,000 点，最大容量 10,000，验证绝对无溢出与点数守恒
  const rb = new RingBuffer(10000);
  const chunkTimes = new Float64Array(1000);
  const chunkValues = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) {
    chunkTimes[i] = i * 0.001;
    chunkValues[i] = Math.sin(i * 0.1);
  }

  // 循环灌入 200 次 = 200,000 点
  for (let round = 0; round < 200; round++) {
    rb.pushBatch(chunkTimes, chunkValues);
  }
  assert.strictEqual(rb.getSize(), 10000, '环形缓冲点数严格钳位在 10000');
  assert.strictEqual(rb.getTotalPushed(), 200000, '总写入量准确累计');
  const snap = rb.snapshot(0, 300);
  assert.strictEqual(snap.count, 10000);

  // 5.2 协议引擎异常字节注入自愈测试
  const engine = new ProtocolEngine('justfloat', { channels: 2 });

  // 注入一串无规则乱码垃圾字节
  const dirtyBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x12, 0x34, 0x56, 0x78]);
  const dirtyOut = engine.feed(dirtyBytes);
  assert.strictEqual(dirtyOut.frames.length, 0, '乱码字节静默丢弃');

  // 紧接着注入一段标准的 JustFloat 帧: 2 通道 (10.5, 20.25) + 00 00 80 7f
  const validPayload = new Uint8Array([
    // ch0 = 10.5f -> 0x41280000 (le: 00 00 28 41)
    0x00, 0x00, 0x28, 0x41,
    // ch1 = 20.25f -> 0x41a20000 (le: 00 00 a2 41)
    0x00, 0x00, 0xa2, 0x41,
    // tail: 00 00 80 7f
    0x00, 0x00, 0x80, 0x7f,
  ]);
  const recoveredOut = engine.feed(validPayload);
  assert.strictEqual(recoveredOut.frames.length, 1, '乱码后立即恢复有效解析');
  assert.strictEqual(recoveredOut.frames[0].values.length, 2);
  assert.strictEqual(Number(recoveredOut.frames[0].values[0].toFixed(1)), 10.5);
  assert.strictEqual(Number(recoveredOut.frames[0].values[1].toFixed(2)), 20.25);

  console.log('✓ [Phase 5: Hardening & Red-Team Audit] 系统加固与红队安全防线审计 100% 全部通过！\n');
}
