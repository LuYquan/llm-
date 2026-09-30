import type {
  CopilotOutputSchema,
  CopilotValidationResult,
} from './types';

/**
 * 清洗可能被包裹在 Markdown 代码块中的 JSON 文本
 */
export function extractJsonFromText(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') return '';
  const trimmed = rawText.trim();

  // 1. 如果匹配 ```json ... ``` 或 ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  // 2. 尝试寻找最外层的 { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

/**
 * 从指令字符串中提取可能内嵌的 PID 参数 (防止恶意或疏漏绕过 params 校验)
 */
export function extractParamsFromCommand(cmd: string): { kp?: number; ki?: number; kd?: number } {
  if (!cmd || typeof cmd !== 'string') return {};
  const res: { kp?: number; ki?: number; kd?: number } = {};

  // 1. 尝试匹配 KP, KI, KD 赋值表达式 (如 KP=1.2, KI:0.3, kd=0.0)
  const kpMatch = cmd.match(/\bKP\s*[:=]\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/i);
  if (kpMatch && kpMatch[1]) {
    const val = parseFloat(kpMatch[1]);
    if (Number.isFinite(val)) res.kp = val;
  }

  const kiMatch = cmd.match(/\bKI\s*[:=]\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/i);
  if (kiMatch && kiMatch[1]) {
    const val = parseFloat(kiMatch[1]);
    if (Number.isFinite(val)) res.ki = val;
  }

  const kdMatch = cmd.match(/\bKD\s*[:=]\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/i);
  if (kdMatch && kdMatch[1]) {
    const val = parseFloat(kdMatch[1]);
    if (Number.isFinite(val)) res.kd = val;
  }

  // 2. 尝试匹配 SET_PID [order] kp ki kd
  if (res.kp === undefined && res.ki === undefined && res.kd === undefined) {
    const setPidMatch = cmd.match(/SET(?:_\w+)?_PID\s+(?:(\d+)\s+)?([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)(?:\s+([+-]?\d+(?:\.\d+)?))?/i);
    if (setPidMatch) {
      const p1 = parseFloat(setPidMatch[2]);
      const p2 = parseFloat(setPidMatch[3]);
      const p3 = setPidMatch[4] ? parseFloat(setPidMatch[4]) : undefined;
      if (Number.isFinite(p1)) res.kp = p1;
      if (Number.isFinite(p2)) res.ki = p2;
      if (p3 !== undefined && Number.isFinite(p3)) res.kd = p3;
    }
  }

  return res;
}

/**
 * 校验 Copilot 输出 Schema 强约束与前端数值溯源
 */
export function validateCopilotResponse(
  rawInput: string | unknown,
  executedToolIds: readonly string[] = [],
): CopilotValidationResult {
  const errors: string[] = [];
  const unverifiedFields: string[] = [];

  let obj: any = null;

  // 1. 解析 JSON
  if (typeof rawInput === 'string') {
    const cleaned = extractJsonFromText(rawInput);
    try {
      obj = JSON.parse(cleaned);
    } catch (err: any) {
      return {
        valid: false,
        errors: [`JSON 解析失败: ${err?.message || '非法格式'}`],
        traceability: {
          is_traceable: false,
          unverified_fields: [],
        },
        can_fill_send_area: false,
      };
    }
  } else if (rawInput && typeof rawInput === 'object') {
    obj = rawInput;
  } else {
    return {
      valid: false,
      errors: ['输入数据非有效对象或 JSON 字符串'],
      traceability: {
        is_traceable: false,
        unverified_fields: [],
      },
      can_fill_send_area: false,
    };
  }

  // 2. 字段类型与必填校验
  if (typeof obj.diagnosis !== 'string' || !obj.diagnosis.trim()) {
    errors.push("缺少必填字段 'diagnosis' 或内容为空");
  }

  if (
    typeof obj.evidence !== 'string' &&
    (!Array.isArray(obj.evidence) || obj.evidence.length === 0)
  ) {
    errors.push("缺少必填字段 'evidence' (需为字符串或非空字符串数组)");
  }

  if (typeof obj.recommendation !== 'string' || !obj.recommendation.trim()) {
    errors.push("缺少必填字段 'recommendation' 或内容为空");
  }

  if (typeof obj.command !== 'string') {
    errors.push("缺少必填字段 'command' (无指令时填空字符串)");
  }

  if (!['low', 'medium', 'high'].includes(obj.risk_level)) {
    errors.push("字段 'risk_level' 必须为 'low' | 'medium' | 'high'");
  }

  if (typeof obj.requires_confirmation !== 'boolean' || obj.requires_confirmation !== true) {
    // 任务 2.5 铁律：永远禁止 Copilot 自动静默发送！必须经过人工确认
    obj.requires_confirmation = true;
  }

  // 3. 数值溯源检验 (前端溯源铁律)
  // 数值工具来源必须来自调用方的本地执行记录。响应 JSON 中的前缀、工具名或自述都不构成执行证据。
  const normalizedParams: Record<string, number | undefined> = {};
  let hasNumericParams = false;

  if (obj.params && typeof obj.params === 'object') {
    for (const [k, v] of Object.entries(obj.params)) {
      const num = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
      if (Number.isFinite(num)) {
        normalizedParams[k] = num;
        hasNumericParams = true;
      }
    }
  }

  // 检查 command 中是否隐式设定了参数
  const cmdParams = typeof obj.command === 'string' ? extractParamsFromCommand(obj.command) : {};
  for (const [k, v] of Object.entries(cmdParams)) {
    if (v !== undefined && Number.isFinite(v)) {
      if (normalizedParams[k] === undefined) {
        normalizedParams[k] = v;
      }
      hasNumericParams = true;
    }
  }

  let hasNumericPredicted = false;
  const normalizedPredicted: Record<string, number | undefined> = {};
  if (obj.predicted && typeof obj.predicted === 'object') {
    for (const [k, v] of Object.entries(obj.predicted)) {
      const num = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
      if (Number.isFinite(num)) {
        normalizedPredicted[k] = num;
        hasNumericPredicted = true;
      }
    }
  }

  const toolSource =
    typeof obj.tool_call_source === 'string' ? obj.tool_call_source.trim() : '';

  const isToolSourceValid = toolSource.length > 0 && executedToolIds.includes(toolSource);

  if (hasNumericParams && !isToolSourceValid) {
    unverifiedFields.push('params');
    errors.push(
      '【数值溯源拦截】推荐的 params 参数或指令没有关联本地真实工具执行记录，禁止直接填入发送区'
    );
  }

  if (hasNumericPredicted && !isToolSourceValid) {
    unverifiedFields.push('predicted');
  }

  const isTraceable = isToolSourceValid || (!hasNumericParams && !hasNumericPredicted);
  const isValid = errors.length === 0;

  // 4. 只有 Schema 校验通过、且数值已溯源、且 command 不为空时，才允许填入发送区
  const canFillSendArea = isValid && isTraceable && (typeof obj.command === 'string' && obj.command.trim().length > 0);

  const normalizedData: CopilotOutputSchema | undefined = isValid
    ? {
        diagnosis: obj.diagnosis,
        evidence: obj.evidence,
        recommendation: obj.recommendation,
        command: obj.command,
        risk_level: obj.risk_level,
        requires_confirmation: true,
        params: hasNumericParams ? normalizedParams : obj.params,
        predicted: hasNumericPredicted ? normalizedPredicted : obj.predicted,
        tool_call_source: toolSource || undefined,
      }
    : undefined;

  return {
    valid: isValid,
    data: normalizedData,
    errors,
    traceability: {
      is_traceable: isTraceable,
      source: toolSource || undefined,
      unverified_fields: unverifiedFields,
    },
    can_fill_send_area: canFillSendArea,
  };
}
