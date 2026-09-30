import type { NumericWidgetBase } from '../../types/widget';

export interface SafetyCheckResult {
  ok: boolean;
  value: number;
  formattedStr: string;
  reason?: 'nan' | 'out_of_range';
  message?: string;
}

/**
 * 高精度浮点格式化算法 (解决 0.1+0.2 与科学计数法问题)
 */
export function formatPrecision(val: number, precision: number): string {
  const p = Math.max(0, Math.min(6, Math.round(precision)));
  const fixed = val.toFixed(p);

  // 若数值极其接近 0 但在浮点运算中有残差
  if (Math.abs(val) < 1e-12) {
    return p === 0 ? '0' : '0';
  }

  // 避免出现科学计数法，并消除 toFixed 带来的多余无意义末尾 0
  const parsed = Number(fixed);
  // 如果转换为 Number 后仍带有科学计数法 (如极大或极小数)，直接返回 fixed
  if (parsed.toString().includes('e')) {
    return fixed;
  }

  return parsed.toString();
}

/**
 * 步进值对齐 (Step Alignment)
 */
export function alignToStep(val: number, min: number, step: number): number {
  if (step <= 0) return val;
  const factor = Math.round((val - min) / step);
  return min + factor * step;
}

/**
 * SafetyGuard 核心校验纯函数
 */
export function checkAndSanitizeNumeric(
  rawVal: number,
  config: Pick<NumericWidgetBase, 'min' | 'max' | 'step' | 'precision' | 'unit'>
): SafetyCheckResult {
  // 1. 拦截 NaN 和无穷大
  if (Number.isNaN(rawVal) || !Number.isFinite(rawVal)) {
    return {
      ok: false,
      value: 0,
      formattedStr: '0',
      reason: 'nan',
      message: '数值非法：不能为 NaN 或无穷大',
    };
  }

  const { min, max, step, precision, unit } = config;

  // 2. 检查上下界范围
  if (rawVal < min || rawVal > max) {
    const unitStr = unit ? ` ${unit}` : '';
    return {
      ok: false,
      value: rawVal,
      formattedStr: formatPrecision(rawVal, precision),
      reason: 'out_of_range',
      message: `超出安全范围 [${min}, ${max}]${unitStr}，当前值: ${rawVal}`,
    };
  }

  // 3. 步进对齐并再次限定在 [min, max]
  const aligned = alignToStep(rawVal, min, step);
  const clamped = Math.max(min, Math.min(max, aligned));
  const formattedStr = formatPrecision(clamped, precision);

  return {
    ok: true,
    value: clamped,
    formattedStr,
  };
}
