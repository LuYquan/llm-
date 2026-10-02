import type { ControlLoop } from '../project/types';
import type { CopilotSafetyCheckResult } from './types';
import { extractParamsFromCommand } from './CopilotSchema';

export interface SafetyCheckParams {
  command?: string;
  params?: {
    kp?: number;
    ki?: number;
    kd?: number;
    [key: string]: number | undefined;
  };
  activeLoop?: ControlLoop | null;
  allLoops?: ControlLoop[];
}

export class CopilotSafetyGuard {
  /**
   * 检查 Copilot 建议的参数与指令安全性
   * 铁律 1: 永远禁止静默自动发送，必须人工确认。
   * 铁律 2: 拦截 NaN、Infinity、负值、超限。
   * 铁律 3: 步长突变 >50% 高风险警示 (20%~50% 中风险警示)。
   * 铁律 4: 速度环 / 电流环 / PI 结构禁止 Kd > 0。
   */
  public static checkSafety(input: SafetyCheckParams): CopilotSafetyCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let hasHighRisk = false;
    let hasMediumRisk = false;

    const { command, params, activeLoop } = input;

    // 1. 合并显式 params 与指令中内嵌设定的参数，指令为最终真实物理下发内容，具有最高安全审计优先级
    const cmdParams = command ? extractParamsFromCommand(command) : {};
    const effectiveParams: Record<string, number | undefined> = {
      ...(params || {}),
    };
    for (const [k, v] of Object.entries(cmdParams)) {
      if (v !== undefined) {
        // 指令真实物理下发的参数具备最高审计优先级，封堵指令偷渡参数漏洞
        effectiveParams[k] = v;
      }
    }

    const hasAnyParams = Object.keys(effectiveParams).length > 0;

    if (hasAnyParams) {
      for (const [key, val] of Object.entries(effectiveParams)) {
        if (val === undefined) continue;
        if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
          errors.push(`参数 '${key}' 为非法数值 (NaN 或无穷大)`);
        } else if (val < 0) {
          errors.push(`参数 '${key}' 不能为负数 (当前值: ${val})`);
        }
      }

      // 2. 环路边界 param_limits 检查
      if (activeLoop && activeLoop.param_limits) {
        const limits = activeLoop.param_limits;
        if (effectiveParams.kp !== undefined && limits.kp) {
          const min = Math.min(limits.kp[0], limits.kp[1]);
          const max = Math.max(limits.kp[0], limits.kp[1]);
          if (effectiveParams.kp < min || effectiveParams.kp > max) {
            errors.push(`Kp (${effectiveParams.kp}) 超出安全限幅区间 [${min}, ${max}]`);
          }
        }
        if (effectiveParams.ki !== undefined && limits.ki) {
          const min = Math.min(limits.ki[0], limits.ki[1]);
          const max = Math.max(limits.ki[0], limits.ki[1]);
          if (effectiveParams.ki < min || effectiveParams.ki > max) {
            errors.push(`Ki (${effectiveParams.ki}) 超出安全限幅区间 [${min}, ${max}]`);
          }
        }
        if (effectiveParams.kd !== undefined && limits.kd) {
          const min = Math.min(limits.kd[0], limits.kd[1]);
          const max = Math.max(limits.kd[0], limits.kd[1]);
          if (effectiveParams.kd < min || effectiveParams.kd > max) {
            errors.push(`Kd (${effectiveParams.kd}) 超出安全限幅区间 [${min}, ${max}]`);
          }
        }
      } else {
        // 未配置具体限幅时的极端兜底防线
        if (effectiveParams.kp !== undefined && effectiveParams.kp > 1000) {
          errors.push(`Kp (${effectiveParams.kp}) 超过通用物理极限阈值 1000`);
        }
        if (effectiveParams.ki !== undefined && effectiveParams.ki > 1000) {
          errors.push(`Ki (${effectiveParams.ki}) 超过通用物理极限阈值 1000`);
        }
      }

      // 3. 速度环 / 电流环 / PI 结构禁止 Kd > 0 规则 (工程防炸机防震荡铁律)
      if (activeLoop) {
        const loopName = (activeLoop.name || activeLoop.id).toLowerCase();
        const isCurrentLoop = loopName.includes('current') || loopName.includes('电流');
        const isSpeedLoop = loopName.includes('speed') || loopName.includes('速度') || loopName.includes('velocity');
        const isPiOnly = activeLoop.structure === 'PI' || activeLoop.structure === 'P';

        if ((isCurrentLoop || isSpeedLoop || isPiOnly) && effectiveParams.kd !== undefined && effectiveParams.kd > 0) {
          errors.push(
            `【控制拓扑禁忌】${isCurrentLoop ? '电流环' : isSpeedLoop ? '速度环' : `${activeLoop.structure}结构环路`}严禁配置微分项 (Kd=${effectiveParams.kd} > 0)，微分项会极度放大开关纹波与转速测量高频噪声`
          );
        }

        if (activeLoop.structure === 'P' && effectiveParams.ki !== undefined && effectiveParams.ki > 0) {
          errors.push(
            `【控制拓扑禁忌】纯比例 (P) 控制结构环路严禁配置积分项 (Ki=${effectiveParams.ki} > 0)`
          );
        }
      }

      // 4. 步长大幅突变检查 (> 50% 高风险，20%~50% 中风险)
      if (activeLoop && activeLoop.current_params) {
        const cur = activeLoop.current_params;
        for (const key of ['kp', 'ki', 'kd'] as const) {
          const newVal = effectiveParams[key];
          const oldVal = cur[key];
          if (newVal !== undefined && oldVal !== undefined && oldVal > 0) {
            const diffPct = Math.abs(newVal - oldVal) / oldVal;
            if (diffPct > 0.5) {
              warnings.push(
                `参数 ${key} 变化幅度达 ${(diffPct * 100).toFixed(1)}% (超过 50% 阶跃安全阈值)，存在扰动失稳风险，建议分步递进调整`
              );
              hasHighRisk = true;
            } else if (diffPct > 0.2) {
              warnings.push(
                `参数 ${key} 变动幅度为 ${(diffPct * 100).toFixed(1)}% (介于 20%~50% 区间)，请留意识别动态响应`
              );
              hasMediumRisk = true;
            }
          }
        }
      }
    }

    // 5. 串级整定次序拦截 (先内后外法则)
    if (activeLoop && typeof activeLoop.order === 'number' && activeLoop.order > 0) {
      const allLoops = input.allLoops;
      if (allLoops && Array.isArray(allLoops)) {
        const innerLoops = allLoops.filter((l) => l.order < activeLoop.order);
        for (const inner of innerLoops) {
          if (inner.state !== 'tuned') {
            const innerName = inner.name || inner.id;
            const outerName = activeLoop.name || activeLoop.id;
            errors.push(
              `【串级整定次序拦截】外环 '${outerName}' 严禁整定：内环 '${innerName}' 尚未完成整定 (当前状态: ${inner.state})。必须遵循“先内后外”整定铁律！`
            );
          }
        }
      }
    }

    // 6. 指令空串或危险字符检查
    if (command && typeof command === 'string') {
      if (command.includes('\0')) {
        errors.push('指令包含非法空字节 (Null Byte)');
      }
    }

    const passed = errors.length === 0;
    const risk_level: 'low' | 'medium' | 'high' = !passed || hasHighRisk
      ? 'high'
      : hasMediumRisk
        ? 'medium'
        : 'low';

    // 严禁静默执行：requires_confirmation 恒定为 true
    const requires_confirmation = true;

    return {
      passed,
      risk_level,
      requires_confirmation,
      warnings,
      errors,
      sanitized_command: passed && command ? command.trim() : undefined,
    };
  }

  /**
   * 构造可安全填入发送区的指令
   */
  public static buildSafeCommand(
    template: string,
    params: { kp?: number; ki?: number; kd?: number },
    loop?: { id?: string; order?: number }
  ): string {
    let cmd = template;
    if (loop?.order !== undefined) {
      cmd = cmd.replace(/{order}/g, String(loop.order));
    }
    if (loop?.id !== undefined) {
      cmd = cmd.replace(/{id}/g, loop.id);
    }
    if (params.kp !== undefined) {
      cmd = cmd.replace(/{kp}/g, params.kp.toFixed(4));
    }
    if (params.ki !== undefined) {
      cmd = cmd.replace(/{ki}/g, params.ki.toFixed(4));
    }
    if (params.kd !== undefined) {
      cmd = cmd.replace(/{kd}/g, params.kd.toFixed(4));
    }
    return cmd;
  }
}
