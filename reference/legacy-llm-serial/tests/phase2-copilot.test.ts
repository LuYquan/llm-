import assert from 'node:assert';
import {
  LogAnalyzer,
  ContextBuilder,
  validateCopilotResponse,
  extractJsonFromText,
  CopilotSafetyGuard,
  type FirmwareAnomaly,
} from '../src/core/copilot/index';
import { ProjectModelManager } from '../src/core/project/ProjectModel';

export async function runPhase2CopilotTests() {
  console.log('--- [Phase 2: Copilot] 开始执行 Copilot 核心引擎全量测试套件 ---');

  // ==========================================
  // 1. LogAnalyzer 固件错误正则与通道检测单测
  // ==========================================
  console.log('  1. 测试 LogAnalyzer 固件严重错误正则匹配与去重');
  const analyzer = new LogAnalyzer();

  // 1.1 HardFault
  const hf = analyzer.analyzeLogLine('[EXCEPTION] HardFault_Handler triggered at 0x08001234');
  assert.ok(hf !== null);
  assert.strictEqual(hf.type, 'hardfault');
  assert.strictEqual(hf.level, 'critical');

  // 1.2 Assert
  const asrt = analyzer.analyzeLogLine('assertion failed: file stm32f4xx_it.c, line 142');
  assert.ok(asrt !== null);
  assert.strictEqual(asrt.type, 'assert');
  assert.strictEqual(asrt.level, 'critical');

  // 1.3 Watchdog
  const wdt = analyzer.analyzeLogLine('WARN: IWDG timeout reset occurred');
  assert.ok(wdt !== null);
  assert.strictEqual(wdt.type, 'watchdog');
  assert.strictEqual(wdt.level, 'critical');

  // 1.4 Overtemp
  const temp = analyzer.analyzeLogLine('DRIVER_ALERT: Motor inverter over-temperature detected! T=105C');
  assert.ok(temp !== null);
  assert.strictEqual(temp.type, 'overtemp');
  assert.strictEqual(temp.level, 'critical');

  // 1.5 Overcurrent & Undervoltage
  const cur = analyzer.analyzeLogLine('PHASE_A: overcurrent trip, shutdown PWM');
  assert.ok(cur !== null);
  assert.strictEqual(cur.type, 'overcurrent');

  const volt = analyzer.analyzeLogLine('PWR: undervoltage detected on DC bus (18.2V < 20.0V)');
  assert.ok(volt !== null);
  assert.strictEqual(volt.type, 'undervoltage');

  // 1.6 Generic Error
  const err = analyzer.analyzeLogLine('[ERROR] UART DMA buffer overrun');
  assert.ok(err !== null);
  assert.strictEqual(err.type, 'error');

  // 1.7 正常数据行不应触发异常
  const normal = analyzer.analyzeLogLine('>speed:120.5,current:1.2');
  assert.strictEqual(normal, null);

  const normalInfo = analyzer.analyzeLogLine('[INFO] Calibrating IMU sensor zero-drift...');
  assert.strictEqual(normalInfo, null);

  // 1.7b 参数超限报警 (任务 2.1 & 2.2)
  const paramAnom = analyzer.analyzeLogLine('[PARAM_LIMIT] Kp parameter exceeds maximum limit: 55.0 > 50.0');
  assert.ok(paramAnom !== null);
  assert.strictEqual(paramAnom.type, 'param_limit');
  assert.strictEqual(paramAnom.level, 'warning');

  // 1.7c 行首带时间戳与序号去重
  const tsLog1 = analyzer.analyzeLogLine('[10:00:00.001] HardFault_Handler triggered at 0x08001234');
  const tsLog2 = analyzer.analyzeLogLine('[10:00:00.002] HardFault_Handler triggered at 0x08001234');
  // tsLog1 之前 1.1 测过 HardFault，如果在去重窗口内可能被去重；若是新实例或者时间间隔小于 800ms
  const freshAnalyzer = new LogAnalyzer();
  const fLog1 = freshAnalyzer.analyzeLogLine('[10:00:00.001] HardFault_Handler triggered at 0x08001234');
  const fLog2 = freshAnalyzer.analyzeLogLine('[10:00:00.002] HardFault_Handler triggered at 0x08001234');
  assert.ok(fLog1 !== null);
  assert.strictEqual(fLog2, null, '行首时间戳不同但不应阻碍去重');

  console.log('  2. 测试通道持续发散与高频震荡检测算法');
  // 1.8 通道发散检测 (极值越界)
  const timestamps = [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100];
  const divValues = [10, 20, 50, 120, 300, 700, 1500, 3000, 6000, 12000, 25000];
  const divAnomaly = analyzer.detectOscillationOrDivergence('speed', timestamps, divValues, {
    divergenceThreshold: 10000,
  });
  assert.ok(divAnomaly !== null);
  assert.strictEqual(divAnomaly.type, 'divergence');
  assert.strictEqual(divAnomaly.level, 'critical');

  // 1.9 通道高频震荡检测 (零基线穿均值检测，严防 lastSign=0 初始死锁)
  const zeroCrossVals = [0, 10, -10, 10, -10, 10, -10, 10, -10, 10, -10];
  const zeroCrossTs = zeroCrossVals.map((_, i) => 1000 + i * 10);
  const zeroCrossAnom = freshAnalyzer.detectOscillationOrDivergence('speed', zeroCrossTs, zeroCrossVals, {
    windowSize: 11,
    reversalThreshold: 5,
    amplitudeThreshold: 1.0,
  });
  assert.ok(zeroCrossAnom !== null, '零基线交替震荡必须被准确检测');
  assert.strictEqual(zeroCrossAnom.type, 'oscillation');

  // 1.9b 通道防抖去重
  const repeatAnom = freshAnalyzer.detectOscillationOrDivergence('speed', zeroCrossTs, zeroCrossVals, {
    windowSize: 11,
    reversalThreshold: 5,
    amplitudeThreshold: 1.0,
  });
  assert.strictEqual(repeatAnom, null, '冷却时间内的连续震荡必须被去重');

  // 1.10 平稳信号不应触发震荡
  const steadyValues = Array.from({ length: 30 }, () => 50 + Math.random() * 0.2);
  const steadyCheck = analyzer.detectOscillationOrDivergence('temp', timestamps, steadyValues, {
    amplitudeThreshold: 2.0,
  });
  assert.strictEqual(steadyCheck, null);

  // ==========================================
  // 2. ContextBuilder 零复制上下文打包测试
  // ==========================================
  console.log('  3. 测试 ContextBuilder 零复制打包与异常优先');
  const projectMgr = new ProjectModelManager();
  projectMgr.applyTemplate('foc_3loop');
  projectMgr.setActiveLoop('speed');

  const testLogs = [
    { time: '10:00:01.100', level: 'info', tag: '[SYS]', text: 'System boot' },
    { time: '10:00:01.200', level: 'error', tag: '[FAULT]', text: 'HardFault in timer IRQ' },
    { time: '10:00:01.300', level: 'info', tag: '[RX]', text: 'ACK packet received' },
    { time: '10:00:01.400', level: 'warn', tag: '[WDT]', text: 'Watchdog warning' },
  ];

  const payload = ContextBuilder.buildPayload({
    projectManager: projectMgr,
    stepMetrics: {
      overshoot_pct: 32.5,
      rise_time: 0.12,
      settling_time: 0.85,
      steady_state_error: 0.04,
      damping_ratio: 0.35,
      is_stable: true,
      has_step: true,
    },
    identifiedModel: {
      phase_margin: 31.0,
      gain: 2.1,
      cutoff_frequency: 18.5,
    },
    logs: testLogs,
    anomalies: [hf, wdt].filter(Boolean) as FirmwareAnomaly[],
    channelStats: [
      { channel: 'speed', count: 50000, latest: 120.0, min: 0.0, max: 150.0, mean: 98.4 },
    ],
  });

  assert.strictEqual(payload.active_loop?.id, 'speed');
  assert.strictEqual(payload.topology_summary.name, 'FOC 三闭环矢量控制拓扑');
  assert.strictEqual(payload.step_metrics?.overshoot_pct, 32.5);
  assert.strictEqual(payload.identified_model?.phase_margin, 31.0);
  assert.strictEqual(payload.waveform_summary?.length, 1);
  assert.strictEqual(payload.waveform_summary![0].count, 50000);

  // 验证 System Prompt 格式化
  const sysPrompt = ContextBuilder.formatSystemPrompt(payload);
  assert.ok(sysPrompt.includes('速度内环严禁启用微分项'));
  assert.ok(sysPrompt.includes('当前聊天入口不会在这次模型调用中执行本地控制工具'));
  assert.ok(sysPrompt.includes('不要输出 params、predicted 或带数值的 command'));
  assert.ok(!sysPrompt.includes('"tool_call_source": "tool:rule_engine"'));

  // 验证 User Prompt 格式化
  const usrPrompt = ContextBuilder.formatUserPrompt('超调过大怎么调？', payload);
  assert.ok(usrPrompt.includes('超调量 Mp: 32.50%'));
  assert.ok(usrPrompt.includes('相位裕度 γ: 31.0°'));
  assert.ok(usrPrompt.includes('HardFault in timer IRQ'));

  // ==========================================
  // 3. CopilotSchema 强校验与数值溯源测试
  // ==========================================
  console.log('  4. 测试 CopilotSchema 强校验与 Markdown JSON 提取');

  const rawJsonWithMarkdown = `
一些思考推理内容...
\`\`\`json
{
  "diagnosis": "速度环超调量达 32.5%，相位裕度仅 31°，系统阻尼严重不足。",
  "evidence": ["实测 Mp=32.5%", "相位裕度低于 45° 临界线"],
  "recommendation": "适当压低比例增益 Kp，速度环严格保持 Kd=0，依靠阻尼比提升削减超调。",
  "command": "SET:SPEED:KP=1.2000,KI=0.4000,KD=0.0000\\n",
  "risk_level": "medium",
  "requires_confirmation": true,
  "params": { "kp": 1.2, "ki": 0.4, "kd": 0.0 },
  "predicted": { "mp": 12.0, "ts": 0.5, "phase_margin": 49.0 },
  "tool_call_source": "tool:rule_engine"
}
\`\`\`
补充说明...
`;

  const selfDeclaredRes = validateCopilotResponse(rawJsonWithMarkdown);
  assert.strictEqual(selfDeclaredRes.valid, false, '模型输出中的 tool_call_source 字符串不能自证真实工具已执行');
  assert.strictEqual(selfDeclaredRes.can_fill_send_area, false);

  const validRes = validateCopilotResponse(rawJsonWithMarkdown, ['tool:rule_engine']);
  assert.strictEqual(validRes.valid, true);
  assert.strictEqual(validRes.data?.command, 'SET:SPEED:KP=1.2000,KI=0.4000,KD=0.0000\n');
  assert.strictEqual(validRes.traceability.is_traceable, true);
  assert.strictEqual(validRes.can_fill_send_area, true);

  console.log('  5. 测试【数值溯源拦截】：未溯源数值禁止填入发送区');
  // 5.1 无 tool_call_source 的 params 凭空数值必须被拦截
  const untracedJson = {
    diagnosis: "速度环超调偏大",
    evidence: "波形振荡",
    recommendation: "修改 PID 参数",
    command: "SET:SPEED:KP=1.5,KI=0.5,KD=0.0\n",
    risk_level: "low",
    requires_confirmation: true,
    params: { kp: 1.5, ki: 0.5, kd: 0.0 },
  };

  const untracedRes = validateCopilotResponse(untracedJson);
  assert.strictEqual(untracedRes.valid, false);
  assert.strictEqual(untracedRes.traceability.is_traceable, false);
  assert.strictEqual(untracedRes.can_fill_send_area, false);
  assert.ok(untracedRes.errors.some((e) => e.includes('数值溯源拦截')));

  // 5.2 隐式隐藏在 command 中的未溯源参数必须被严密提取并拦截 (防绕过)
  const untracedCmdOnly = {
    diagnosis: "加大速度环增益",
    evidence: "响应太慢",
    recommendation: "修改指令参数",
    command: "SET:SPEED:KP=2.5,KI=0.8,KD=0.0\n",
    risk_level: "low",
    requires_confirmation: true,
    // 故意省略 params 且缺少 tool_call_source
  };
  const cmdBypassRes = validateCopilotResponse(untracedCmdOnly);
  assert.strictEqual(cmdBypassRes.valid, false, '通过 command 夹带未溯源数字必须被拦截');
  assert.strictEqual(cmdBypassRes.can_fill_send_area, false);

  // 5.3 测试缺失必要字段 (如缺少 diagnosis)
  const missingFieldRes = validateCopilotResponse({
    evidence: "foo",
    recommendation: "bar",
    command: "SET:KP=1\n",
    risk_level: "low",
    requires_confirmation: true,
  });
  assert.strictEqual(missingFieldRes.valid, false);
  assert.ok(missingFieldRes.errors.some((e) => e.includes('diagnosis')));

  // ==========================================
  // 4. CopilotSafetyGuard 安全防线测试
  // ==========================================
  console.log('  6. 测试 CopilotSafetyGuard 安全限幅、突变步长与拓扑禁忌');
  const speedLoop = projectMgr.getActiveLoop()!;

  // 4.1 NaN 拦截
  const nanCheck = CopilotSafetyGuard.checkSafety({
    params: { kp: NaN, ki: 0.5, kd: 0.0 },
    activeLoop: speedLoop,
    command: 'SET:SPEED:KP=NaN\n',
  });
  assert.strictEqual(nanCheck.passed, false);
  assert.ok(nanCheck.errors.some((e) => e.includes('NaN')));

  // 4.2 超出 param_limits 拦截
  const limitCheck = CopilotSafetyGuard.checkSafety({
    params: { kp: 999.0, ki: 0.5, kd: 0.0 }, // speed_loop 限制通常是 [0, 50]
    activeLoop: speedLoop,
    command: 'SET:SPEED:KP=999\n',
  });
  assert.strictEqual(limitCheck.passed, false);
  assert.ok(limitCheck.errors.some((e) => e.includes('超出安全限幅区间')));

  // 4.3 速度环严禁 Kd > 0 拓扑禁忌拦截
  const kdCheck = CopilotSafetyGuard.checkSafety({
    params: { kp: 1.5, ki: 0.5, kd: 0.2 }, // 速度环配置 Kd > 0
    activeLoop: speedLoop,
    command: 'SET:SPEED:KP=1.5,KI=0.5,KD=0.2\n',
  });
  assert.strictEqual(kdCheck.passed, false);
  assert.ok(kdCheck.errors.some((e) => e.includes('速度环严禁配置微分项')));

  // 4.3b command 内嵌违规参数拦截 (即省略 params 对象但 command 包含 Kd=0.5)
  const cmdBypassSafety = CopilotSafetyGuard.checkSafety({
    command: 'SET:SPEED:KP=1.5,KI=0.5,KD=0.5\n',
    activeLoop: speedLoop,
  });
  assert.strictEqual(cmdBypassSafety.passed, false, 'command 内嵌 Kd>0 必须被 SafetyGuard 捕获');
  assert.ok(cmdBypassSafety.errors.some((e) => e.includes('速度环严禁配置微分项')));

  // 4.4 突变步长 > 50% 高风险提示
  // 当前 speed_loop current_params 为 kp: 1.5. 若建议 kp: 2.8 (> 80% 突变)
  const stepCheck = CopilotSafetyGuard.checkSafety({
    params: { kp: 2.8, ki: 0.5, kd: 0.0 },
    activeLoop: speedLoop,
    command: 'SET:SPEED:KP=2.8\n',
  });
  assert.strictEqual(stepCheck.passed, true); // 步长突变不报错阻断，但标记 high 风险并警告
  assert.strictEqual(stepCheck.risk_level, 'high');
  assert.strictEqual(stepCheck.requires_confirmation, true);
  assert.ok(stepCheck.warnings.some((w) => w.includes('超过 50% 阶跃安全阈值')));

  // 4.5 指令模板安全拼接 (支持 {order} 与 {id})
  const safeCmd = CopilotSafetyGuard.buildSafeCommand('SET_PID {order} {kp} {ki} {kd}\n', {
    kp: 1.25,
    ki: 0.45,
    kd: 0.0,
  }, { id: 'speed', order: 1 });
  assert.strictEqual(safeCmd, 'SET_PID 1 1.2500 0.4500 0.0000\n');

  // 4.6 拓扑控制结构约束 (PI环禁止Kd>0，纯P环禁止Ki>0)
  const piLoop = {
    ...speedLoop,
    structure: 'PI' as const,
  };
  const piCheck = CopilotSafetyGuard.checkSafety({
    params: { kp: 1.2, ki: 0.4, kd: 0.1 },
    activeLoop: piLoop,
  });
  assert.strictEqual(piCheck.passed, false);
  assert.ok(piCheck.errors.some((e) => e.includes('严禁配置微分项')));

  // 4.7 ChannelStore 与 RingBuffer getRecent 连续时序快照测试
  const store = new (await import('../src/core/channel/ChannelStore')).ChannelStore();
  for (let i = 0; i < 20; i++) {
    store.push('ch_test', 1000 + i * 10, i * 2.5);
  }
  const recent10 = store.getRecent('ch_test', 10);
  assert.strictEqual(recent10.count, 10);
  assert.strictEqual(recent10.values[0], 10 * 2.5);
  assert.strictEqual(recent10.values[9], 19 * 2.5);

  console.log('✓ [Phase 2: Copilot] 4 大核心引擎与自动化单测 100% 全部通过！\n');
}
