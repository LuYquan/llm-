import type { StepResponseMetrics } from '../analysis/types';
import type { ProjectModelManager } from '../project/ProjectModel';
import type {
  CopilotContextPayload,
  FirmwareAnomaly,
  IdentifiedModelSummary,
} from './types';

export interface ContextBuilderOptions {
  maxLogLines?: number;
  anomalyFirst?: boolean;
}

export class ContextBuilder {
  /**
   * 零复制构建上下文 Payload
   * 严禁打包原始百万波形数组，仅提取结构化特征与统计指标
   */
  public static buildPayload(params: {
    projectManager?: ProjectModelManager;
    stepMetrics?: StepResponseMetrics | null;
    identifiedModel?: IdentifiedModelSummary | null;
    logs?: Array<{ time: string; level: string; tag: string; text: string }>;
    anomalies?: FirmwareAnomaly[];
    channelStats?: Array<{
      channel: string;
      count: number;
      latest: number;
      min: number;
      max: number;
      mean: number;
    }>;
    options?: ContextBuilderOptions;
  }): CopilotContextPayload {
    const maxLogLines = params.options?.maxLogLines ?? 20;
    const allLogs = params.logs || [];
    const anomalies = params.anomalies || [];

    // 1. 日志零复制过滤与优先排序 (异常行优先 + 时间戳)
    const anomalyTexts = new Set(
      anomalies.map((a) => (a.rawLine ? a.rawLine.trim() : '')).filter(Boolean)
    );

    const mappedLogs = allLogs.map((l) => ({
      time: l.time,
      level: l.level,
      tag: l.tag,
      text: l.text,
      is_anomaly:
        l.level === 'error' ||
        l.level === 'warn' ||
        anomalyTexts.has(l.text.trim()),
    }));

    let selectedLogs: typeof mappedLogs = [];
    if (params.options?.anomalyFirst !== false) {
      const anomalyLogs = mappedLogs.filter((l) => l.is_anomaly);
      const normalLogs = mappedLogs.filter((l) => !l.is_anomaly);

      // 异常优先塞入，剩余额度用常规日志补充 (严格防范 slice(-0) 导致的全量数组回退)
      const anomalyQuota = Math.max(1, Math.floor(maxLogLines * 0.6));
      const anomalySlice = anomalyLogs.slice(-anomalyQuota);
      const remainingNormalCount = Math.max(0, maxLogLines - anomalySlice.length);
      const normalSlice = remainingNormalCount > 0 ? normalLogs.slice(-remainingNormalCount) : [];

      selectedLogs = [...anomalySlice, ...normalSlice].sort((a, b) => a.time.localeCompare(b.time));
    } else {
      selectedLogs = mappedLogs.slice(-maxLogLines);
    }

    // 2. 拓扑与激活环路提取
    let activeLoopData: CopilotContextPayload['active_loop'] = undefined;
    let topologySummary: CopilotContextPayload['topology_summary'] = {
      name: '未配置拓扑',
      loops_count: 0,
      all_loops: [],
    };

    if (params.projectManager) {
      const model = params.projectManager.getModel();
      const activeLoop = params.projectManager.getActiveLoop();
      const loops = params.projectManager.getLoops();

      const templateFriendlyNames: Record<string, string> = {
        foc_3loop: 'FOC 三闭环矢量控制拓扑',
        drone_cascade: '四轴飞行器串级姿态控制拓扑',
        temperature_single: '温度单回路 PID 拓扑',
        generic_single: '通用单回路控制拓扑',
      };

      const topoName = (model as any).name || templateFriendlyNames[model.template] || model.template || '未命名项目';

      topologySummary = {
        name: topoName,
        loops_count: loops.length,
        active_loop_id: model.active_loop_id,
        all_loops: loops.map((l) => ({
          id: l.id,
          name: l.name || l.id,
          order: l.order,
          state: l.state,
        })),
      };

      if (activeLoop) {
        activeLoopData = {
          id: activeLoop.id,
          name: activeLoop.name || activeLoop.id,
          order: activeLoop.order,
          structure: activeLoop.structure,
          current_params: activeLoop.current_params,
          param_limits: activeLoop.param_limits,
          cmd_template: activeLoop.cmd_template || 'SET_PID {order} {kp} {ki} {kd}',
          sample_time: (model as any).sample_period_s ?? 0.01,
        };
      }
    }

    return {
      timestamp: Date.now(),
      active_loop: activeLoopData,
      topology_summary: topologySummary,
      step_metrics: params.stepMetrics || null,
      identified_model: params.identifiedModel || null,
      recent_logs: selectedLogs,
      recent_anomalies: anomalies.slice(0, 10),
      waveform_summary: params.channelStats,
    };
  }

  /**
   * 格式化系统 System Prompt (内含控制理论约束、输出规范与数值溯源铁律)
   */
  public static formatSystemPrompt(context: CopilotContextPayload): string {
    const loop = context.active_loop;
    const loopDesc = loop
      ? `当前正在整定的对象环路: [${loop.name || loop.id}] (层级: ${loop.order}级, 控制结构: ${loop.structure || 'PID'}, 采样周期: ${loop.sample_time || 0.01}s)`
      : '未激活具体环路';

    const loopLimits = loop?.param_limits
      ? `允许参数边界: Kp [${loop.param_limits.kp[0]}, ${loop.param_limits.kp[1]}], Ki [${loop.param_limits.ki[0]}, ${loop.param_limits.ki[1]}], Kd [${loop.param_limits.kd[0]}, ${loop.param_limits.kd[1]}]`
      : '无参数边界';

    const curParams = loop?.current_params
      ? `当前运行参数: Kp=${loop.current_params.kp}, Ki=${loop.current_params.ki}, Kd=${loop.current_params.kd}`
      : '当前运行参数未知';

    return `你是嵌入在 LLM 串口主终端内的“控制理论 Copilot 专家”，负责辅助工程师分析固件异常、频域/时域动态特性并推荐高可靠性整定参数。

【被控对象与拓扑现状】
- 拓扑名称: ${context.topology_summary.name} (共 ${context.topology_summary.loops_count} 个环路)
- ${loopDesc}
- ${curParams}
- ${loopLimits}
- 指令下发模板: ${loop?.cmd_template || 'SET:KP={kp},KI={ki},KD={kd}\\n'}

【严苛工程准则】
1. 绝对严禁自动静默下发指令！所有建议必须以结构化卡片呈现供人工审核。
2. 电流内环与速度内环严禁启用微分项 (禁止 Kd > 0)，防止高频电磁/转速测量噪声极度放大。
3. 参数步长突变限制：单次调整幅度绝对不得超过当前运行参数的 ±50%，若必须调整应分步渐进。
4. 只使用本次上下文中明确提供的观测和分析结果，不得编造测量值、计算结果、参数或命令。当前聊天入口不会在这次模型调用中执行本地控制工具，因此不要输出 params、predicted 或带数值的 command，也不要自报 tool_call_source；如需候选参数，请引导用户转到“AI 调参”工作区完成有执行记录的分析。
5. 输出格式必须为纯 JSON，符合以下 Schema。此聊天入口只返回解释，不生成可执行参数候选:
{
  "diagnosis": "只根据已提供证据撰写的简要判断；证据不足时说明未知",
  "evidence": ["引用本次上下文中实际存在的观测或日志"],
  "recommendation": "给出下一步需要采集或检查的内容，不编造参数数值",
  "command": "",
  "risk_level": "low" | "medium" | "high",
  "requires_confirmation": true
}`;
  }

  /**
   * 格式化提问与指标注入的 User Prompt
   */
  public static formatUserPrompt(
    userQuery: string,
    context: CopilotContextPayload
  ): string {
    const parts: string[] = [];

    // 1. 最近异常列表
    if (context.recent_anomalies.length > 0) {
      parts.push('【检测到的固件/信号异常】:');
      for (const a of context.recent_anomalies.slice(0, 5)) {
        parts.push(`- [${new Date(a.timestamp).toLocaleTimeString()}] [${a.type.toUpperCase()}] ${a.message}`);
      }
    }

    // 2. 阶跃指标摘要
    if (context.step_metrics) {
      const m = context.step_metrics as any;
      const mp = m.overshoot_pct ?? m.overshoot_percent ?? 0;
      const tr = m.rise_time_s ?? m.rise_time ?? 0;
      const ts = m.settling_time_s ?? m.settling_time ?? 0;
      const ess = m.steady_state_error ?? 0;
      const zeta = m.damping_ratio != null ? Number(m.damping_ratio).toFixed(3) : '未知';
      const isStable = m.is_stable;

      parts.push('【最近一次阶跃特征提取指标】:');
      parts.push(`- 超调量 Mp: ${Number(mp).toFixed(2)}%`);
      parts.push(`- 上升时间 tr: ${Number(tr).toFixed(4)}s, 调节时间 ts: ${Number(ts).toFixed(4)}s`);
      parts.push(`- 稳态静差 ess: ${Number(ess).toFixed(4)}`);
      parts.push(`- 估算阻尼比 zeta: ${zeta}`);
      parts.push(`- 系统是否稳定: ${isStable === true ? '是' : isStable === false ? '否 ⚠(检测到失稳/持续振荡)' : '未知（未计算）'}`);
    }

    // 3. 模型辨识摘要
    if (context.identified_model) {
      const im = context.identified_model;
      parts.push('【已辨识对象频域模型】:');
      if (im.phase_margin !== undefined) parts.push(`- 相位裕度 γ: ${im.phase_margin.toFixed(1)}°`);
      if (im.cutoff_frequency !== undefined) parts.push(`- 截止频率 ωc: ${im.cutoff_frequency.toFixed(2)} rad/s`);
      if (im.gain !== undefined) parts.push(`- 增益 K: ${im.gain.toFixed(3)}, 时间常数 T: ${im.time_constant?.toFixed(3)}s`);
    }

    // 4. 关键近期日志
    if (context.recent_logs.length > 0) {
      parts.push('【近期终端上下文日志】:');
      for (const l of context.recent_logs) {
        parts.push(`[${l.time}] ${l.tag} ${l.text}`);
      }
    }

    // 5. 波形统计摘要 (若有)
    if (context.waveform_summary && context.waveform_summary.length > 0) {
      parts.push('【通道时序波形统计摘要】:');
      for (const ws of context.waveform_summary) {
        parts.push(`- 通道 [${ws.channel}]: 最新值=${ws.latest.toFixed(2)}, 均值=${ws.mean.toFixed(2)}, 范围=[${ws.min.toFixed(2)}, ${ws.max.toFixed(2)}] (采样点: ${ws.count})`);
      }
    }

    parts.push(`\n【工程师提问】: ${userQuery}`);
    return parts.join('\n');
  }
}
