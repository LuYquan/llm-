import type { TuningCommandPayload } from './commandContract';
import type { RxDispatch } from '../../types/ipc';

export interface TuningExecutionState { executionId: string; working: boolean }
export interface TuningSendRequest {
  executionId: string;
  trialId: string;
  command: string;
  payload: TuningCommandPayload;
}
export interface TuningWriteResult {
  id: string;
  executionId: string;
  requestId?: string;
  sessionId?: string;
  epoch?: number;
  rxDispatch?: RxDispatch;
  status: 'queued' | 'written' | 'failed';
  at: number;
  error?: string;
}
export interface ExecutionLeaseState { executionId: string; ready: boolean }
interface Lease {
  executionId: string;
  context: string;
  controller: AbortController;
  ready: boolean;
  completion: Promise<boolean>;
}
interface LeaseDependencies {
  context: () => string;
  acquire: (owner: string, signal: AbortSignal) => Promise<boolean>;
  drain: (signal: AbortSignal) => Promise<{ ready: boolean; reason?: string }>;
  release: (owner: string) => unknown;
  changed: (state: ExecutionLeaseState | null) => void;
  failed: (reason: string) => void;
}

/** Owns asynchronous write access, never the already-dispatched serial bytes. */
export class TuningExecutionLease {
  private active: Lease | null = null;
  private retired = new Set<string>();
  private readonly dependencies: LeaseDependencies;
  constructor(dependencies: LeaseDependencies) { this.dependencies = dependencies; }

  start(executionId: string): Promise<boolean> {
    if (!executionId.trim() || this.retired.has(executionId)) return Promise.resolve(false);
    if (this.active) return this.active.executionId === executionId
      ? this.active.completion : Promise.resolve(false);
    const lease: Lease = {
      executionId, context: this.dependencies.context(), controller: new AbortController(),
      ready: false, completion: Promise.resolve(false),
    };
    this.active = lease;
    // Defer callbacks until completion is assigned, including synchronous reentry.
    lease.completion = Promise.resolve().then(() => this.prepare(lease));
    this.dependencies.changed({ executionId, ready: false });
    return lease.completion;
  }

  owns(executionId: string): boolean { return this.active?.executionId === executionId; }

  hasWriteAccess(executionId: string): boolean {
    const lease = this.active;
    return Boolean(lease && lease.executionId === executionId && lease.ready && this.isCurrent(lease));
  }

  finish(executionId: string): boolean {
    const lease = this.active;
    if (!lease || lease.executionId !== executionId) return false;
    this.active = null;
    this.retired.add(executionId);
    // IDs are unique per attempt; bounded tombstones also reject recent event replay.
    if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value!);
    lease.controller.abort();
    this.dependencies.release(executionId);
    this.dependencies.changed(null);
    return true;
  }

  cancel(): boolean { return this.active ? this.finish(this.active.executionId) : false; }

  cancelChangedContext(): boolean {
    return this.active && !this.isCurrent(this.active) ? this.finish(this.active.executionId) : false;
  }

  private isCurrent(lease: Lease): boolean {
    return this.active === lease && !lease.controller.signal.aborted
      && lease.context === this.dependencies.context();
  }

  private async prepare(lease: Lease): Promise<boolean> {
    try {
      if (!this.isCurrent(lease)) return this.rejectCurrent(lease, '实验上下文已变化，未取得写入权。');
      const acquired = await this.dependencies.acquire(lease.executionId, lease.controller.signal);
      if (!this.isCurrent(lease)) return this.rejectCurrent(lease, '实验上下文已变化，未取得写入权。');
      if (!acquired) return this.rejectCurrent(lease, '普通控件发送尚未退出，实验未取得独占写入权。');
      const drained = await this.dependencies.drain(lease.controller.signal);
      if (!this.isCurrent(lease)) return this.rejectCurrent(lease, '实验上下文已变化，未取得写入权。');
      if (!drained.ready) return this.rejectCurrent(lease, drained.reason || '普通命令的驱动写入状态尚未明确，实验未取得写入权。');
      lease.ready = true;
      this.dependencies.changed({ executionId: lease.executionId, ready: true });
      return true;
    } catch (error) {
      return this.rejectCurrent(lease, error instanceof Error ? error.message : String(error));
    }
  }

  private rejectCurrent(lease: Lease, reason: string): false {
    if (this.active === lease && !lease.controller.signal.aborted) {
      this.dependencies.failed(reason);
      this.finish(lease.executionId);
    }
    return false;
  }
}
