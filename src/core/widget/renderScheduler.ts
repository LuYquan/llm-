/**
 * 全局统一 requestAnimationFrame 渲染调度器 (GlobalRenderScheduler)
 * 核心特性：
 * 1. 单一全局 rAF 驱动所有 Canvas / uPlot 刷新，杜绝多实例 timer 混乱与 CPU 撕裂；
 * 2. 多 Tab 感知：非激活 Tab 自动暂停 Canvas 绘制以保护性能与电池；
 * 3. 页面非激活 (document.hidden) 或全局暂停时自动静默；
 * 4. 支持可选的帧率上限 (如 30FPS / 60FPS) 节流。
 */

export type RenderTask = (timestamp: number) => void;

export interface RenderTaskOptions {
  tabId?: string; // 归属的工作台 Tab ID，仅当其激活时执行绘制
  fpsLimit?: number; // 目标帧率上限 (默认不设限，跟随显示器刷新率)
  skipWhenHidden?: boolean; // 页面隐藏时是否跳过 (默认 true)
}

interface TaskRecord {
  id: string;
  cb: RenderTask;
  options: RenderTaskOptions;
  lastRun: number;
}

const safeRaf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame
  : (cb: (ts: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

const safeCancelRaf = typeof cancelAnimationFrame === 'function'
  ? cancelAnimationFrame
  : (id: number) => clearTimeout(id as unknown as any);

export class GlobalRenderScheduler {
  private tasks: Map<string, TaskRecord> = new Map();
  private rafId: number | null = null;
  private isRunning: boolean = false;
  private activeTabId: string = '';
  private paused: boolean = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.tasks.size > 0 && !this.isRunning) {
          this.startLoop();
        }
      });
    }
  }

  /**
   * 设置当前激活的 Tab
   */
  public setActiveTab(tabId: string): void {
    this.activeTabId = tabId;
  }

  public getActiveTab(): string {
    return this.activeTabId;
  }

  /**
   * 设置全局渲染暂停态
   */
  public setPaused(paused: boolean): void {
    this.paused = paused;
  }

  public isPaused(): boolean {
    return this.paused;
  }

  /**
   * 注册渲染任务
   */
  public register(id: string, cb: RenderTask, options: RenderTaskOptions = {}): void {
    this.tasks.set(id, {
      id,
      cb,
      options,
      lastRun: 0,
    });
    this.startLoop();
  }

  /**
   * 注销渲染任务
   */
  public unregister(id: string): void {
    this.tasks.delete(id);
    if (this.tasks.size === 0) {
      this.stopLoop();
    }
  }

  /**
   * 查询已注册任务数
   */
  public getTaskCount(): number {
    return this.tasks.size;
  }

  private startLoop(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.rafId = safeRaf(this.onFrame);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      safeCancelRaf(this.rafId);
      this.rafId = null;
    }
    this.isRunning = false;
  }

  /**
   * 手动触发单次调度帧 (供单测及即时强制刷新使用)
   */
  public triggerFrame(timestamp: number = Date.now()): void {
    const isDocHidden = typeof document !== 'undefined' && document.hidden;
    if (this.paused || isDocHidden) return;

    for (const [id, record] of this.tasks.entries()) {
      if (record.options.tabId && record.options.tabId !== this.activeTabId) {
        continue;
      }
      if (record.options.fpsLimit && record.options.fpsLimit > 0) {
        const interval = 1000 / record.options.fpsLimit;
        if (timestamp - record.lastRun < interval) {
          continue;
        }
      }
      record.lastRun = timestamp;
      try {
        record.cb(timestamp);
      } catch (err) {
        console.error(`[GlobalRenderScheduler] 任务 "${id}" 执行绘制异常:`, err);
      }
    }
  }

  private onFrame = (timestamp: number) => {
    if (!this.isRunning) return;

    const isDocHidden = typeof document !== 'undefined' && document.hidden;

    if (!this.paused && !isDocHidden) {
      for (const [id, record] of this.tasks.entries()) {
        // 1. Tab 隔离检查：若任务指定了 tabId，且当前激活 Tab 不匹配，则静默跳过绘制
        if (record.options.tabId && record.options.tabId !== this.activeTabId) {
          continue;
        }

        // 2. 帧率节流判定
        if (record.options.fpsLimit && record.options.fpsLimit > 0) {
          const interval = 1000 / record.options.fpsLimit;
          if (timestamp - record.lastRun < interval) {
            continue;
          }
        }

        record.lastRun = timestamp;
        try {
          record.cb(timestamp);
        } catch (err) {
          console.error(`[GlobalRenderScheduler] 任务 "${id}" 执行绘制异常:`, err);
        }
      }
    }

    if (this.tasks.size > 0) {
      this.rafId = safeRaf(this.onFrame);
    } else {
      this.stopLoop();
    }
  };
}

export const globalRenderScheduler = new GlobalRenderScheduler();
