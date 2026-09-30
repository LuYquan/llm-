/**
 * ProjectModel 领域管理器与持久化服务 (ProjectModelManager)
 * 严格管理多环路拓扑配置、参数限幅校验、指令模板渲染与序列化落盘
 */

import type { ProjectModel, ControlLoop, LoopState, PidValues, SafetyCheckResult } from './types';
import { BUILTIN_PROJECT_TEMPLATES } from './templates';

const STORAGE_KEY_DEFAULT = 'llm_serial_project_model_v1';

/**
 * 校验 ProjectModel 数据结构完整性与物理自洽性
 */
export function validateProjectModel(model: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!model || typeof model !== 'object') {
    return { valid: false, errors: ['ProjectModel 必须为有效对象'] };
  }

  if (typeof model.version !== 'number') {
    errors.push('缺少版本号 version');
  }

  if (typeof model.sample_period_s !== 'number' || model.sample_period_s <= 0) {
    errors.push('采样周期 sample_period_s 必须为正数');
  }

  if (!Array.isArray(model.loops) || model.loops.length === 0) {
    errors.push('必须至少声明一个控制环路 loops');
  } else {
    const loopIds = new Set<string>();
    const orders = new Set<number>();

    for (let i = 0; i < model.loops.length; i++) {
      const loop = model.loops[i];
      if (!loop.id || typeof loop.id !== 'string') {
        errors.push(`第 ${i} 个环路缺少有效 id`);
      } else if (loopIds.has(loop.id)) {
        errors.push(`环路 ID 重复: ${loop.id}`);
      } else {
        loopIds.add(loop.id);
      }

      if (typeof loop.order !== 'number' || loop.order < 0) {
        errors.push(`环路 ${loop.id || i} 的 order 必须是非负整数`);
      } else if (orders.has(loop.order)) {
        errors.push(`环路层级 order 存在冲突: ${loop.order}`);
      } else {
        orders.add(loop.order);
      }

      if (!['P', 'PI', 'PD', 'PID'].includes(loop.structure)) {
        errors.push(`环路 ${loop.id} 控制器结构类型无效: ${loop.structure}`);
      }

      if (!loop.channels || loop.channels.setpoint === undefined || loop.channels.feedback === undefined) {
        errors.push(`环路 ${loop.id} 缺少通道映射 (setpoint/feedback)`);
      }

      if (!loop.param_limits) {
        errors.push(`环路 ${loop.id} 缺少参数上下限 param_limits`);
      } else {
        const { kp, ki, kd } = loop.param_limits;
        if (!Array.isArray(kp) || kp[0] > kp[1]) errors.push(`环路 ${loop.id} Kp 上下限设置非法`);
        if (!Array.isArray(ki) || ki[0] > ki[1]) errors.push(`环路 ${loop.id} Ki 上下限设置非法`);
        if (!Array.isArray(kd) || kd[0] > kd[1]) errors.push(`环路 ${loop.id} Kd 上下限设置非法`);
      }

      if (loop.identified_model !== undefined) {
        const model = loop.identified_model;
        const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
        const hasFiniteGainAndDelay = finite(model?.k)
          && Math.abs(model.k) > 1e-12
          && finite(model?.tau)
          && model.tau >= 0;
        const validShape = model?.family === 'fopdt'
          ? finite(model.t) && model.t > 0
          : model?.family === 'sopdt'
            ? finite(model.wn) && model.wn > 0 && finite(model.zeta) && model.zeta > 0
            : model?.family === 'integral_lag'
              ? finite(model.t) && model.t > 0
              : false;
        if (!hasFiniteGainAndDelay || !validShape) {
          errors.push(`环路 ${loop.id} 的 identified_model 参数无效；波特图不会使用示例模型代替`);
        }
      }

      if (!loop.cmd_template || typeof loop.cmd_template !== 'string') {
        errors.push(`环路 ${loop.id} 缺少指令模板 cmd_template`);
      }
    }

    if (model.active_loop_id && !loopIds.has(model.active_loop_id)) {
      errors.push(`active_loop_id '${model.active_loop_id}' 在 loops 中未找到`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export class ProjectModelManager {
  private currentModel: ProjectModel;
  private listeners: Set<(m: ProjectModel) => void> = new Set();
  private storageKey: string;

  constructor(initialTemplate: string = 'foc_3loop', storageKey: string = STORAGE_KEY_DEFAULT) {
    this.storageKey = storageKey;
    const templateFactory = BUILTIN_PROJECT_TEMPLATES[initialTemplate] || BUILTIN_PROJECT_TEMPLATES.generic_single;
    this.currentModel = templateFactory();
  }

  /**
   * 获取当前拓扑模型快照
   */
  public getModel(): ProjectModel {
    return JSON.parse(JSON.stringify(this.currentModel));
  }

  /**
   * 更新全量模型
   */
  public setModel(model: ProjectModel): boolean {
    const check = validateProjectModel(model);
    if (!check.valid) {
      console.error('[ProjectModelManager] 模型校验失败:', check.errors);
      return false;
    }
    this.currentModel = JSON.parse(JSON.stringify(model));
    this.notify();
    return true;
  }

  /**
   * 获取所有环路 (按 order 升序排序：内环到外环)
   */
  public getLoops(): ControlLoop[] {
    return [...this.currentModel.loops].sort((a, b) => a.order - b.order);
  }

  /**
   * 获取当前正在整定/激活的环路
   */
  public getActiveLoop(): ControlLoop | undefined {
    return this.currentModel.loops.find((l) => l.id === this.currentModel.active_loop_id) || this.currentModel.loops[0];
  }

  /**
   * 切换当前激活环路
   */
  public setActiveLoop(id: string): boolean {
    const loop = this.currentModel.loops.find((l) => l.id === id);
    if (!loop) return false;
    this.currentModel.active_loop_id = id;
    this.notify();
    return true;
  }

  /**
   * 根据 ID 获取环路
   */
  public getLoop(id: string): ControlLoop | undefined {
    return this.currentModel.loops.find((l) => l.id === id);
  }

  /**
   * 更新指定环路配置
   */
  public updateLoop(id: string, partial: Partial<ControlLoop>): boolean {
    const loop = this.currentModel.loops.find((l) => l.id === id);
    if (!loop) return false;

    Object.assign(loop, partial);
    this.notify();
    return true;
  }

  /**
   * 更新指定环路的整定状态 ('untuned' | 'identified' | 'tuned')
   */
  public setLoopState(id: string, state: LoopState): boolean {
    return this.updateLoop(id, { state });
  }

  /**
   * 更新指定环路的当前参数
   */
  public updateLoopParams(id: string, params: PidValues): boolean {
    return this.updateLoop(id, { current_params: params });
  }

  /**
   * 增加环路
   */
  public addLoop(loop: ControlLoop): boolean {
    if (this.currentModel.loops.some((l) => l.id === loop.id)) {
      return false;
    }
    this.currentModel.loops.push(loop);
    this.notify();
    return true;
  }

  /**
   * 删除环路
   */
  public removeLoop(id: string): boolean {
    const idx = this.currentModel.loops.findIndex((l) => l.id === id);
    if (idx === -1) return false;
    this.currentModel.loops.splice(idx, 1);
    if (this.currentModel.active_loop_id === id && this.currentModel.loops.length > 0) {
      this.currentModel.active_loop_id = this.currentModel.loops[0].id;
    }
    this.notify();
    return true;
  }

  /**
   * 应用内置拓扑模板
   */
  public applyTemplate(templateName: string): boolean {
    const factory = BUILTIN_PROJECT_TEMPLATES[templateName];
    if (!factory) return false;
    this.currentModel = factory();
    this.notify();
    return true;
  }

  /**
   * 按照指令模板渲染下发字符串
   */
  public renderCommand(loopId: string, paramsOverride?: PidValues): string | null {
    const loop = this.getLoop(loopId);
    if (!loop) return null;

    const p = paramsOverride || loop.current_params;
    if (!p) return null;

    let cmd = loop.cmd_template;
    cmd = cmd.replace(/{order}/g, String(loop.order));
    cmd = cmd.replace(/{id}/g, loop.id);
    cmd = cmd.replace(/{kp}/g, p.kp.toFixed(4));
    cmd = cmd.replace(/{ki}/g, p.ki.toFixed(4));
    cmd = cmd.replace(/{kd}/g, p.kd.toFixed(4));
    return cmd;
  }

  /**
   * 导出为 JSON 字符串
   */
  public exportJson(): string {
    return JSON.stringify(this.currentModel, null, 2);
  }

  /**
   * 从 JSON 字符串导入
   */
  public importJson(jsonStr: string): { success: boolean; errors?: string[] } {
    try {
      const parsed = JSON.parse(jsonStr);
      const check = validateProjectModel(parsed);
      if (!check.valid) {
        return { success: false, errors: check.errors };
      }
      this.currentModel = parsed;
      this.notify();
      return { success: true };
    } catch (e: any) {
      return { success: false, errors: [e.message || 'JSON 解析失败'] };
    }
  }

  /**
   * 持久化至 LocalStorage
   */
  public saveToStorage(storageKey?: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey || this.storageKey, this.exportJson());
    } catch (err) {
      console.warn('[ProjectModelManager] 保存到 LocalStorage 失败:', err);
    }
  }

  /**
   * 从 LocalStorage 恢复
   */
  public loadFromStorage(storageKey?: string): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const val = localStorage.getItem(storageKey || this.storageKey);
      if (!val) return false;
      const res = this.importJson(val);
      return res.success;
    } catch (err) {
      console.warn('[ProjectModelManager] 从 LocalStorage 加载失败:', err);
      return false;
    }
  }

  /**
   * 监听模型变更
   */
  public onModelChanged(cb: (model: ProjectModel) => void): () => void {
    this.listeners.add(cb);
    cb(this.getModel());
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * 严格按照控制工程原则与 SafetyGuard 规范对建议参数进行本地确定性校验
   */
  public checkSafety(loopId: string, suggested: PidValues): SafetyCheckResult {
    const loop = this.getLoop(loopId);
    if (!loop) {
      return {
        passed: false,
        risk_level: 'high',
        requires_confirmation: true,
        warnings: [],
        errors: [`环路 '${loopId}' 不存在`],
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    let hasMediumRisk = false;
    let hasHighRisk = false;

    // 1. 参数数值合法性检查 (非 NaN, 非 Infinity, 非负)
    for (const key of ['kp', 'ki', 'kd'] as const) {
      const v = suggested[key];
      if (typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v)) {
        errors.push(`参数 ${key} 不是有效有限数值`);
      } else if (v < 0) {
        errors.push(`参数 ${key} 不能为负数 (实测值: ${v})`);
      }
    }

    // 2. 限幅边界检查 (param_limits)
    const limits = loop.param_limits;
    if (suggested.kp < limits.kp[0] || suggested.kp > limits.kp[1]) {
      errors.push(`Kp (${suggested.kp}) 超出允许区间 [${limits.kp[0]}, ${limits.kp[1]}]`);
    }
    if (suggested.ki < limits.ki[0] || suggested.ki > limits.ki[1]) {
      errors.push(`Ki (${suggested.ki}) 超出允许区间 [${limits.ki[0]}, ${limits.ki[1]}]`);
    }
    if (suggested.kd < limits.kd[0] || suggested.kd > limits.kd[1]) {
      errors.push(`Kd (${suggested.kd}) 超出允许区间 [${limits.kd[0]}, ${limits.kd[1]}]`);
    }

    // 3. 结构规则检查 (工程禁忌)
    const loopNameLower = (loop.name || loop.id).toLowerCase();
    if ((loopNameLower.includes('current') || loopNameLower.includes('电流')) && suggested.kd > 0) {
      warnings.push('电流内环强烈建议 Kd = 0，非零微分项易放大采样开关噪声');
      hasMediumRisk = true;
    }
    if ((loopNameLower.includes('position') || loopNameLower.includes('位置')) && suggested.ki > 0 && loop.structure === 'P') {
      warnings.push('纯比例位置外环声明了非零积分 Ki，可能导致稳态相位滞后');
      hasMediumRisk = true;
    }

    // 4. 步长大幅突变检查 (单次参数变化超过当前值 ±50% 标记为高风险)
    if (loop.current_params) {
      const cur = loop.current_params;
      for (const key of ['kp', 'ki', 'kd'] as const) {
        if (cur[key] > 0 && suggested[key] > 0) {
          const ratio = Math.abs(suggested[key] - cur[key]) / cur[key];
          if (ratio > 0.5) {
            warnings.push(`参数 ${key} 变化幅度达 ${(ratio * 100).toFixed(1)}% (> 50%)，存在较大幅度扰动风险`);
            hasHighRisk = true;
          }
        }
      }
    }

    // 5. 串级整定顺序检查 (外环整定前内环必须已 tuned)
    if (loop.order > 0) {
      const innerLoops = this.getLoops().filter((l) => l.order < loop.order);
      for (const inner of innerLoops) {
        if (inner.state !== 'tuned') {
          warnings.push(`串级内环 '${inner.name || inner.id}' 尚未完成整定 (当前状态: ${inner.state})，外环整定建议暂缓`);
          hasHighRisk = true;
        }
      }
    }

    const risk_level: 'low' | 'medium' | 'high' = hasHighRisk
      ? 'high'
      : hasMediumRisk
        ? 'medium'
        : 'low';
    const passed = errors.length === 0;
    const requires_confirmation = risk_level === 'high' || !passed;

    return {
      passed,
      risk_level,
      requires_confirmation,
      warnings,
      errors,
    };
  }

  private notify() {
    const copy = this.getModel();
    for (const cb of this.listeners) {
      try {
        cb(copy);
      } catch (err) {
        console.error('[ProjectModelManager] 变更通知异常:', err);
      }
    }
  }
}

export const globalProjectModel = new ProjectModelManager();
