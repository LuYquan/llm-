import { invoke } from '@tauri-apps/api/core';
import type { StepMetrics } from '../components/SnapshotStream.vue';

export interface PidParams {
  kp: number;
  ki: number;
  kd: number;
}

export interface AiDiagnosisResult {
  provider: string;
  diagnosis: string;
  recommendation: PidParams;
  rationale: string;
  risk_warning: string;
}

export interface AiConfig {
  provider: string; // 'deepseek' | 'openai' | 'ollama'
  api_key: string;
  api_url: string;
  model: string;
}

/**
 * 结构化 PID 诊断服务 (M5 Step 5.1 & 5.2)
 * 支持 DeepSeek / OpenAI / Ollama，带离线控制理论规则引擎无缝回退与强 Schema 校验
 */
export async function diagnoseStep(
  metrics: StepMetrics,
  currentPid: PidParams,
  config: AiConfig
): Promise<AiDiagnosisResult> {
  // 1. 若未配置 API Key 且非本地 Ollama，或者明确选择离线，直接使用内置离线规则引擎
  if (!config.api_key?.trim() && config.provider !== 'ollama') {
    return await invoke<AiDiagnosisResult>('diagnose_pid_offline', {
      metrics,
      currentPid,
    });
  }

  // 2. 构造严格结构化 Prompt (PRD 5.2)
  const systemPrompt = `你是一位精通控制工程与电机驱动的资深工业控制算法专家。
请根据用户提供的阶跃响应指标（上升时间 tr、超调量 Mp、调节时间 ts、稳态误差 ess）以及当前 PID 参数，给出精准的诊断与优化建议。
你必须且仅能以标准 JSON 格式输出，严禁包含任何 Markdown 标记（如 \`\`\`json 等）或多余解释文字。
JSON 输出格式严格约束如下：
{
  "diagnosis": "对当前系统动态特性的客观诊断描述",
  "recommendation": {
    "kp": 浮点数建议新Kp,
    "ki": 浮点数建议新Ki,
    "kd": 浮点数建议新Kd
  },
  "rationale": "调整参数的控制工程学理论依据与依据公式",
  "risk_warning": "潜在的工程风险提示（如饱和、高频噪声、失稳等）"
}`;

  const userPrompt = JSON.stringify({
    current_pid: currentPid,
    step_metrics: {
      rise_time_s: metrics.rise_time_s,
      overshoot_pct: metrics.overshoot_percent ?? metrics.overshoot_pct,
      settling_time_s: metrics.settling_time_s,
      steady_state_error: metrics.steady_state_error,
      y0: metrics.y0,
      y_target: metrics.y_target,
      y_ss: metrics.y_ss,
      is_stable: metrics.is_stable,
    },
    sample_rate_hz: 1000,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const url = config.api_url.endsWith('/') ? config.api_url.slice(0, -1) : config.api_url;
    const endpoint = config.provider === 'ollama' && !url.includes('/v1') ? `${url}/api/generate` : `${url}/chat/completions`;

    let responseJson: any;

    if (config.provider === 'ollama' && endpoint.includes('/api/generate')) {
      // Ollama 原生 API
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model || 'llama3',
          prompt: `${systemPrompt}\n\nUser Input:\n${userPrompt}`,
          stream: false,
          format: 'json',
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}`);
      const data = await res.json();
      responseJson = JSON.parse(data.response);
    } else {
      // OpenAI / DeepSeek 兼容接口
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model || (config.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`AI API 返回 HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI 返回内容为空');
      responseJson = JSON.parse(content);
    }
    clearTimeout(timeoutId);

    // 强 Schema 校验 (PRD 5.2)
    if (
      typeof responseJson.diagnosis === 'string' &&
      responseJson.recommendation &&
      typeof responseJson.recommendation.kp === 'number' &&
      typeof responseJson.recommendation.ki === 'number' &&
      typeof responseJson.recommendation.kd === 'number' &&
      !isNaN(responseJson.recommendation.kp) &&
      !isNaN(responseJson.recommendation.ki) &&
      !isNaN(responseJson.recommendation.kd)
    ) {
      return {
        provider: config.provider,
        diagnosis: responseJson.diagnosis,
        recommendation: {
          kp: Number(responseJson.recommendation.kp.toFixed(3)),
          ki: Number(responseJson.recommendation.ki.toFixed(3)),
          kd: Number(responseJson.recommendation.kd.toFixed(3)),
        },
        rationale: responseJson.rationale || '大模型控制工程分析',
        risk_warning: responseJson.risk_warning || '请在核准下发前确认设备安全。',
      };
    } else {
      throw new Error('AI 返回的 JSON 格式未通过 Schema 校验');
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError' || err?.message?.includes('aborted');
    const reason = isTimeout ? '请求超时 (超过 5 秒)' : (err?.message || err);
    console.warn(`[AI] 调用大模型失败 (${reason})，自动降级至内置离线控制理论规则引擎`);
    const fallback = await invoke<AiDiagnosisResult>('diagnose_pid_offline', {
      metrics,
      currentPid,
    });
    fallback.rationale = `[自动降级 - ${isTimeout ? '超时保底' : '离线保底'}] 由于大模型调用未成功 (${reason})，系统已自动无缝切换至离线控制理论专家规则：${fallback.rationale}`;
    return fallback;
  }
}

/**
 * 报错日志 AI 解释器 (M5 Step 5.4 - Log Explainer)
 */
export async function explainLog(
  logText: string,
  contextLogs: string[],
  config: AiConfig
): Promise<string> {
  if (!config.api_key?.trim() && config.provider !== 'ollama') {
    return `[离线分析] 错误信息: "${logText}"。\n可能原因: 硬件通信校验失败、外设超时或缓冲区溢出。\n建议排查: 1. 检查物理接线与波特率设置; 2. 检查电源与地线干扰; 3. 检查单片机中断是否阻塞。`;
  }

  const prompt = `你是一位嵌入式硬件工程师。单片机终端产生了一条报错日志：
"${logText}"
最近上下文日志：
${contextLogs.slice(-5).join('\n')}

请用 3 句话以内简洁分析：
1. 可能的根本原因；
2. 硬件或固件排查步骤。`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const url = config.api_url.endsWith('/') ? config.api_url.slice(0, -1) : config.api_url;
    const endpoint = config.provider === 'ollama' && !url.includes('/v1') ? `${url}/api/generate` : `${url}/chat/completions`;

    if (config.provider === 'ollama' && endpoint.includes('/api/generate')) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model || 'llama3',
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      return data.response;
    } else {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model || (config.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini'),
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '未能获取 AI 诊断结论。';
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError' || err?.message?.includes('aborted');
    return `[诊断失败 - ${isTimeout ? '超时' : '网络异常'}] 无法连接到 AI 服务 (${isTimeout ? '请求超时 >5s' : (err?.message || err)})。建议离线排查：1. 检查物理接线与波特率设置；2. 检查电源与地线干扰；3. 检查单片机中断是否阻塞。`;
  }
}
