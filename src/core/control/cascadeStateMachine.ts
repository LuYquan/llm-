/**
 * 串级整定状态机 (CascadeStateMachine)
 * 严格贯彻工业界“先内后外”多环整定法则
 * 管理 untuned -> identified -> tuned 状态流转与外环复合模型合成
 */

import type { ControlLoop, LoopState } from '../project/types';
import type { ProjectModelManager } from '../project/ProjectModel';
import type {
  PlantModel,
  ControllerParams,
  FopdtModel,
  SopdtModel,
  IntegralLagModel,
} from './types';

export interface TransitionCheckResult {
  allowed: boolean;
  reason?: string;
  blockingLoop?: ControlLoop;
}

export interface CascadeTransitionResult {
  success: boolean;
  loopId: string;
  targetState: LoopState;
  invalidatedLoops: string[];
  error?: string;
}

export interface CascadePipelineItem {
  id: string;
  name: string;
  order: number;
  state: LoopState;
  structure: string;
  isCurrent: boolean;
}

export type OuterAdditionLink = 'integrator' | 'lag' | 'none';

export interface ComposeOuterPlantOptions {
  /** 附加外环环节类型: 'integrator' (位置积分 1/s) | 'lag' (惯性延迟 1/(Ts+1)) | 'none' (纯增益) */
  addition: OuterAdditionLink;
  /** 外环节比例增益或传动比 K_ext (默认 1.0) */
  extraGain?: number;
  /** 附加环节时间常数 T_ext (秒，用于 'lag' 模式，默认 0.1) */
  lagT?: number;
  /** 附加环节纯滞后延时 τ_ext (秒，默认 0) */
  delay?: number;
  /** 内环实测/估计等效闭环剪切角频率 ωc_in (rad/s，若未提供则从模型与PID解析估算) */
  effectiveInnerBandwidth?: number;
}

export class CascadeStateMachine {
  private projectManager?: ProjectModelManager;
  private localLoops: ControlLoop[] = [];

  constructor(managerOrLoops?: ProjectModelManager | ControlLoop[]) {
    if (managerOrLoops && 'getLoops' in managerOrLoops) {
      this.projectManager = managerOrLoops;
    } else if (Array.isArray(managerOrLoops)) {
      this.localLoops = JSON.parse(JSON.stringify(managerOrLoops));
    }
  }

  /**
   * 获取按 order 升序排列的所有环路 (0: 最内环 -> 1: 中环 -> 2: 外环)
   */
  public getLoops(): ControlLoop[] {
    if (this.projectManager) {
      return this.projectManager.getLoops();
    }
    return [...this.localLoops].sort((a, b) => a.order - b.order);
  }

  /**
   * 根据 ID 查询环路
   */
  public getLoop(id: string): ControlLoop | undefined {
    return this.getLoops().find((l) => l.id === id);
  }

  /**
   * 检查环路是否允许开始系统辨识 (canIdentify)
   * 铁律：所有串级内环 (order < loop.order) 必须已处于 'tuned' 状态！
   */
  public canIdentify(loopId: string): TransitionCheckResult {
    const loop = this.getLoop(loopId);
    if (!loop) {
      return { allowed: false, reason: `环路 '${loopId}' 不存在` };
    }

    // 最内环 (order 0) 无需内环依赖
    if (loop.order === 0) {
      return { allowed: true };
    }

    // 检查所有层级低于本环的内环状态
    const innerLoops = this.getLoops().filter((l) => l.order < loop.order);
    for (const inner of innerLoops) {
      if (inner.state !== 'tuned') {
        const innerName = inner.name || inner.id;
        const loopName = loop.name || loop.id;
        return {
          allowed: false,
          reason: `【串级整定次序拦截】外环 '${loopName}' 严禁进入辨识阶段：内环 '${innerName}' 尚未完成整定 (当前状态: ${inner.state})。必须遵循“先内后外”整定铁律！`,
          blockingLoop: inner,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查环路是否允许进入参数整定并标记为已整定 (canTune)
   * 铁律 1: 所有串级内环必须已处于 'tuned' 状态；
   * 铁律 2: 本环必须至少已处于 'identified' 状态（即拥有受控对象模型）。
   */
  public canTune(loopId: string): TransitionCheckResult {
    const identifyCheck = this.canIdentify(loopId);
    if (!identifyCheck.allowed) {
      return identifyCheck;
    }

    const loop = this.getLoop(loopId);
    if (!loop) {
      return { allowed: false, reason: `环路 '${loopId}' 不存在` };
    }

    if (loop.state === 'untuned') {
      const loopName = loop.name || loop.id;
      return {
        allowed: false,
        reason: `【整定前置条件不足】环路 '${loopName}' 当前处于 'untuned' 状态，必须先通过阶跃激励完成系统辨识，获得置信模型后方可整定`,
        blockingLoop: loop,
      };
    }

    return { allowed: true };
  }

  /**
   * 执行环路状态跃迁 (transition)
   * 支持 untuned -> identified -> tuned
   * 若发生内环重置 (如由 tuned 降级为 untuned 或 identified)，自动触发级联失效机制：
   * 所有依赖该内环的外环自动被回退为 'untuned'，并返回失效列表。
   */
  public transition(loopId: string, targetState: LoopState): CascadeTransitionResult {
    const loop = this.getLoop(loopId);
    if (!loop) {
      return {
        success: false,
        loopId,
        targetState,
        invalidatedLoops: [],
        error: `环路 '${loopId}' 不存在`,
      };
    }

    const currentState = loop.state;
    if (currentState === targetState) {
      return {
        success: true,
        loopId,
        targetState,
        invalidatedLoops: [],
      };
    }

    // 跃迁校验
    if (targetState === 'identified') {
      const check = this.canIdentify(loopId);
      if (!check.allowed) {
        return {
          success: false,
          loopId,
          targetState,
          invalidatedLoops: [],
          error: check.reason,
        };
      }
    } else if (targetState === 'tuned') {
      const check = this.canTune(loopId);
      if (!check.allowed) {
        return {
          success: false,
          loopId,
          targetState,
          invalidatedLoops: [],
          error: check.reason,
        };
      }
    }

    // 执行状态变更
    this.applyStateChange(loopId, targetState);

    // 级联失效检查：如果一个已整定 (tuned) 的内环被修改为 untuned 或 identified
    const invalidatedLoops: string[] = [];
    if (currentState === 'tuned' && targetState !== 'tuned') {
      const outerLoops = this.getLoops().filter((l) => l.order > loop.order);
      for (const outer of outerLoops) {
        if (outer.state !== 'untuned') {
          this.applyStateChange(outer.id, 'untuned');
          invalidatedLoops.push(outer.id);
        }
      }
    }

    return {
      success: true,
      loopId,
      targetState,
      invalidatedLoops,
    };
  }

  /**
   * 外环被控对象模型复合生成 (composeOuterPlant)
   * 严格依据经典串级控制理论：
   * 外环广义受控对象 = 已闭合的内环传递函数 T_inner(s) × 附加物理环节 H_ext(s)
   * 
   * 设已闭合的内环等效为一阶惯性滞后环节: T_inner(s) ≈ 1 / (T_eq * s + 1) * e^(-τ_in * s)
   * 其中 T_eq ≈ 1 / ωc_inner
   * 
   * 1. 当 addition 为 'integrator' (如位置外环 = 速度中环 × 积分环节 1/s):
   *    G_outer(s) = K_ext / (s * (T_eq * s + 1)) * e^(-τ * s) -> 属于 IntegralLagModel
   * 2. 当 addition 为 'lag' (如温度多容延迟或二次滤波环节):
   *    G_outer(s) = K_ext / ((T_eq * s + 1)(T_ext * s + 1)) -> 属于 SopdtModel (二阶系统)
   * 3. 当 addition 为 'none' (纯比例驱动):
   *    G_outer(s) = K_ext / (T_eq * s + 1) -> 属于 FopdtModel
   */
  public composeOuterPlant(
    innerPlant: PlantModel,
    innerPid: ControllerParams,
    options: ComposeOuterPlantOptions
  ): PlantModel {
    const kExt = options.extraGain ?? 1.0;
    const addition = options.addition;
    const lagT = Math.max(1e-4, options.lagT ?? 0.1);
    const delay = options.delay ?? 0;

    // 估算已闭合内环的等效闭环时间常数 T_eq 与延迟
    let tEq = 0.01; // 默认 10ms (100 rad/s)
    let innerDelay = 0;

    if (options.effectiveInnerBandwidth && options.effectiveInnerBandwidth > 0) {
      tEq = 1.0 / options.effectiveInnerBandwidth;
    } else {
      // 从内环受控对象与 PID 参数解析估算等效闭环带宽
      if (innerPlant.family === 'transfer_function') throw new Error('自定义内环需要已验证的有效闭环带宽，不能默认采用 10ms 等效模型。');
      const kp = Math.max(1e-4, innerPid.kp);
      if (innerPlant.family === 'fopdt') {
        // 内环一阶惯性 K / (Ts + 1)，配合 PI 闭环:
        // 开环增益 ≈ K * Kp / T => 等效闭环时间常数 T_cl ≈ T / (1 + K * Kp)
        const kPlant = Math.max(1e-4, Math.abs(innerPlant.k));
        tEq = innerPlant.t / (1.0 + kPlant * kp);
        innerDelay = innerPlant.tau;
      } else if (innerPlant.family === 'sopdt') {
        // 二阶系统闭环带宽与自然频率 ωn 相当
        tEq = 1.0 / Math.max(0.1, innerPlant.wn);
        innerDelay = innerPlant.tau;
      } else if (innerPlant.family === 'integral_lag') {
        tEq = innerPlant.t / (1.0 + innerPlant.k * kp);
        innerDelay = innerPlant.tau;
      }
    }

    tEq = Math.max(1e-4, tEq);
    const totalDelay = innerDelay + delay;

    if (addition === 'integrator') {
      const model: IntegralLagModel = {
        family: 'integral_lag',
        k: kExt,
        t: Number(tEq.toFixed(6)),
        tau: Number(totalDelay.toFixed(6)),
      };
      return model;
    }

    if (addition === 'lag') {
      // 两个一阶环节串联: 1 / ((T_eq * s + 1)(T_ext * s + 1))
      // 分母展开: T_eq * T_ext * s^2 + (T_eq + T_ext) * s + 1
      // 标准二阶形式: s^2 / wn^2 + 2*zeta*s / wn + 1
      // wn = 1 / sqrt(T_eq * T_ext)
      // zeta = (T_eq + T_ext) / (2 * sqrt(T_eq * T_ext))
      const wn = 1.0 / Math.sqrt(tEq * lagT);
      const zeta = (tEq + lagT) / (2.0 * Math.sqrt(tEq * lagT));

      const model: SopdtModel = {
        family: 'sopdt',
        k: kExt,
        wn: Number(wn.toFixed(4)),
        zeta: Number(zeta.toFixed(4)),
        tau: Number(totalDelay.toFixed(6)),
      };
      return model;
    }

    // 默认 addition === 'none': 一阶惯性
    const model: FopdtModel = {
      family: 'fopdt',
      k: kExt,
      t: Number(tEq.toFixed(6)),
      tau: Number(totalDelay.toFixed(6)),
    };
    return model;
  }

  /**
   * 获取串级整定管道全景状态概要 (供 UI 状态条与向导渲染)
   */
  public getPipelineStatus(activeLoopId?: string): {
    items: CascadePipelineItem[];
    formattedBadge: string;
    allTuned: boolean;
    currentUntunedLoop: ControlLoop | null;
  } {
    const loops = this.getLoops();
    const currentActiveId = activeLoopId || (this.projectManager ? this.projectManager.getActiveLoop()?.id : loops[0]?.id);

    const items: CascadePipelineItem[] = loops.map((l) => ({
      id: l.id,
      name: l.name || l.id,
      order: l.order,
      state: l.state,
      structure: l.structure,
      isCurrent: l.id === currentActiveId,
    }));

    // 生成紧凑状态徽标字符串，例如: "[环路: 电流环 (已整定) -> 速度环 (待整定)]"
    const badgeParts = items.map((it) => {
      const stateLabel = it.state === 'tuned' ? '已整定' : it.state === 'identified' ? '已辨识' : '待整定';
      return `${it.name} (${stateLabel})`;
    });
    const formattedBadge = `[环路: ${badgeParts.join(' -> ')}]`;

    const allTuned = items.every((it) => it.state === 'tuned');
    const currentUntunedLoop = loops.find((l) => l.state !== 'tuned') || null;

    return {
      items,
      formattedBadge,
      allTuned,
      currentUntunedLoop,
    };
  }

  private applyStateChange(loopId: string, state: LoopState): void {
    if (this.projectManager) {
      this.projectManager.setLoopState(loopId, state);
    } else {
      const loop = this.localLoops.find((l) => l.id === loopId);
      if (loop) {
        loop.state = state;
      }
    }
  }
}
