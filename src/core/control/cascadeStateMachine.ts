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
} from './types';
import { cascadeSeriesProduct, checkedInnerClosedLoopModel, composeContinuousInnerLoop } from './cascadeModel';

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
  /** 外环节增益或传动比；integrator/lag 必须明确提供，none 缺省为已选恒等环节。 */
  extraGain?: number;
  /** 附加 lag 环节的时间常数 T_ext（秒），必须明确提供。 */
  lagT?: number;
  /** 附加物理环节自身的纯滞后（秒）；integrator/lag 必须提供，无滞后明确填 0。 */
  delay?: number;
  /** 常数反馈增益 H，默认单位负反馈；保留符号，不用绝对值修复控制方向。 */
  feedbackGain?: number;
  /**
   * 已核对来源、内环控制器、单位与工况的闭环输入→输出等效模型。
   * 原内环反馈含纯滞后时必须提供；此处仅检查数值形状和模型分母，
   * 不能代替实测来源、固件参数一致性或设备稳定性证据。
   */
  innerClosedLoopModel?: PlantModel;
  /** 旧选项仅保留 API 兼容；单个带宽数值不足以建立闭环对象，不能据此近似。 */
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
   * G_outer = T_inner × H_ext。无反馈延迟时，T_inner 使用完整连续
   * 1DOF PID（微分作用于误差）和常数反馈增益进行有理函数代数合成。
   * 含内环纯滞后时必须使用调用方已核对的闭环等效输入输出模型，
   * 不能把反馈中的延迟移到分母外或用单个带宽强行近似一阶对象。
   * 返回的是模型计算，不验证 sampleTime、离散固件实现或硬件表现。
   */
  public composeOuterPlant(
    innerPlant: PlantModel,
    innerPid: ControllerParams,
    options: ComposeOuterPlantOptions
  ): PlantModel {
    if (!options || !['none', 'integrator', 'lag'].includes(options.addition)) throw new Error('附加环节必须明确选择 none、integrator 或 lag。');
    const physicalAddition = options.addition !== 'none';
    if (physicalAddition && options.extraGain === undefined) throw new Error('附加物理环节增益必须明确提供，不能默认猜测传动比。');
    if (physicalAddition && options.delay === undefined) throw new Error('附加物理环节纯滞后必须明确提供，无滞后请填 0。');
    const kExt = options.extraGain ?? 1;
    const delay = options.delay ?? 0;
    if (!Number.isFinite(kExt) || kExt === 0) throw new Error('附加环节增益必须是非零有限数值。');
    if (!Number.isFinite(delay) || delay < 0) throw new Error('附加环节纯滞后必须是非负有限数值。');
    if (options.addition === 'lag' && (options.lagT === undefined || !Number.isFinite(options.lagT) || options.lagT <= 0)) throw new Error('附加 lag 环节时间常数必须明确提供正有限数值。');
    if (options.effectiveInnerBandwidth !== undefined) {
      if (!Number.isFinite(options.effectiveInnerBandwidth) || options.effectiveInnerBandwidth <= 0) throw new Error('旧选项内环带宽必须为正有限数值。');
      if (!options.innerClosedLoopModel) throw new Error('单个内环带宽不能确定闭环对象；请使用完整模型与 PID，或提供已核对的内环闭环等效模型。');
    }
    const innerClosed = options.innerClosedLoopModel
      ? checkedInnerClosedLoopModel(options.innerClosedLoopModel)
      : composeContinuousInnerLoop(innerPlant, innerPid, options.feedbackGain);
    const denominator = options.addition === 'integrator' ? [1, 0]
      : options.addition === 'lag' ? [options.lagT!, 1] : [1];
    return cascadeSeriesProduct(innerClosed, { family: 'transfer_function', numerator: [kExt], denominator, tau: delay });
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
