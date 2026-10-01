import type { WriteReceipt, WriteResultEvent } from './types';

export interface WriteQuiescenceSnapshot {
  generation: number;
  pendingCount: number;
  connected: boolean;
  ready: boolean;
  error: string | null;
}
export interface WriteQuiescenceResult { ready: boolean; reason?: string }
export interface WriteAttempt { id: number; generation: number; byteLength: number }
type WriteIdentity = { sessionId: string; epoch: number };
type PendingWrite = WriteIdentity & { requestId: string; byteLength: number };

const key = (requestId: string, identity: WriteIdentity) => JSON.stringify([requestId, identity.sessionId, identity.epoch]);
const identity = (sessionId: unknown, epoch: unknown): WriteIdentity | null =>
  typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.length <= 256
  && Number.isSafeInteger(epoch) && (epoch as number) >= 0 ? { sessionId, epoch: epoch as number } : null;
const sameIdentity = (left: WriteIdentity, right: WriteIdentity) => left.sessionId === right.sessionId && left.epoch === right.epoch;

/** Tracks driver completion only. A drained writer does not prove device application. */
export class WriteQuiescenceTracker {
  private generation = 0;
  private connected = false;
  private nextAttempt = 0;
  private currentIdentity: WriteIdentity | null = null;
  private error: string | null = null;
  private inflight = new Map<number, WriteAttempt>();
  private pending = new Map<string, PendingWrite>();
  private earlyResults = new Map<string, WriteResultEvent>();
  private readonly changed: (snapshot: WriteQuiescenceSnapshot) => void;

  constructor(changed: (snapshot: WriteQuiescenceSnapshot) => void = () => {}) { this.changed = changed; }

  snapshot(): WriteQuiescenceSnapshot {
    const pendingCount = this.inflight.size + this.pending.size;
    return { generation: this.generation, connected: this.connected, pendingCount,
      ready: this.connected && pendingCount === 0 && this.error === null, error: this.error };
  }

  /** Only an explicit fresh connection clears an uncertain/failed writer latch. */
  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.resetState();
  }

  reset(): void {
    this.connected = false;
    this.resetState();
  }

  observeIdentity(sessionId: unknown, epoch: unknown): void {
    const next = identity(sessionId, epoch);
    if (!next || !this.connected) return;
    if (!this.currentIdentity) { this.currentIdentity = next; return; }
    if (sameIdentity(this.currentIdentity, next)) return;
    this.changeContext('设备或解析会话在写入完成前变化，原队列状态未知；请重新连接并核对设备。');
    this.currentIdentity = next;
  }

  /** A protocol/epoch change must not turn an old waiter into a successful drain. */
  changeContext(reason: string): void {
    const uncertain = this.inflight.size + this.pending.size > 0;
    this.generation += 1;
    this.inflight.clear();
    this.pending.clear();
    this.earlyResults.clear();
    this.currentIdentity = null;
    if (uncertain) this.error = reason;
    this.publish();
  }

  begin(byteLength: number): WriteAttempt {
    const attempt = { id: ++this.nextAttempt, generation: this.generation, byteLength };
    this.inflight.set(attempt.id, attempt);
    this.publish();
    return attempt;
  }

  acceptReceipt(attempt: WriteAttempt, receipt: WriteReceipt): boolean {
    if (!this.isCurrent(attempt)) return false;
    const receivedIdentity = identity(receipt.session_id, receipt.epoch);
    if (!this.connected || !receivedIdentity || typeof receipt.request_id !== 'string' || !receipt.request_id.trim()
      || receipt.request_id.length > 512 || !Number.isSafeInteger(receipt.byte_count)
      || receipt.byte_count !== attempt.byteLength || !['queued', 'written'].includes(receipt.status)) {
      this.fail(attempt, '驱动写入回执缺少当前会话、请求或完整字节身份，队列状态未知。');
      return false;
    }
    if (this.currentIdentity && !sameIdentity(this.currentIdentity, receivedIdentity)) {
      this.fail(attempt, '写入回执来自不同设备或解析会话，不能证明当前队列已排空。');
      return false;
    }
    this.currentIdentity = receivedIdentity;
    this.inflight.delete(attempt.id);
    const requestKey = key(receipt.request_id, receivedIdentity);
    if (this.pending.has(requestKey)) {
      this.latch('驱动重复使用未完成写入请求 ID，无法区分队列中的命令。');
      return false;
    }
    if (receipt.status === 'queued') {
      this.pending.set(requestKey, { ...receivedIdentity, requestId: receipt.request_id, byteLength: attempt.byteLength });
      const early = this.earlyResults.get(requestKey);
      this.earlyResults.delete(requestKey);
      if (early) this.acceptResult(early);
    }
    this.clearUnneededEarlyResults();
    this.publish();
    return this.error === null;
  }

  fail(attempt: WriteAttempt, reason: string): void {
    if (!this.isCurrent(attempt)) return;
    this.inflight.delete(attempt.id);
    this.clearUnneededEarlyResults();
    this.latch(reason);
  }

  acceptResult(result: WriteResultEvent): void {
    const resultIdentity = identity(result.session_id, result.epoch);
    if (!this.connected || !resultIdentity || typeof result.request_id !== 'string' || !result.request_id.trim()) return;
    const requestKey = key(result.request_id, resultIdentity);
    const pending = this.pending.get(requestKey);
    if (!pending) {
      // Native event delivery can precede the invoke's queued response. Only
      // retain bounded early events while a local write call is actually active.
      if (this.inflight.size > 0 && (!this.currentIdentity || sameIdentity(this.currentIdentity, resultIdentity))) {
        if (this.earlyResults.size >= 256 && !this.earlyResults.has(requestKey)) {
          this.latch('过多无法关联的写入回执，当前队列状态未知。');
          return;
        }
        const prior = this.earlyResults.get(requestKey);
        if (!prior || prior.status === 'written' && prior.written_bytes === prior.requested_bytes) {
          this.earlyResults.set(requestKey, { ...result });
        }
      }
      return;
    }
    if (!this.currentIdentity || !sameIdentity(this.currentIdentity, resultIdentity)) return;
    this.pending.delete(requestKey);
    if (result.status !== 'written' || result.requested_bytes !== pending.byteLength || result.written_bytes !== pending.byteLength) {
      this.latch(result.reason || `驱动写入 ${result.status} 或字节未写完整；设备可能收到部分命令，请重新连接并核对。`);
      return;
    }
    this.publish();
  }

  async wait(timeoutMs = 5000): Promise<WriteQuiescenceResult> {
    const generation = this.generation;
    const deadline = Date.now() + Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 5000));
    for (;;) {
      if (generation !== this.generation) return { ready: false, reason: '等待写入期间设备或解析会话已变化；原授权不能继续。' };
      const state = this.snapshot();
      if (!state.connected) return { ready: false, reason: '当前串口没有连接，不能确认写入队列已排空。' };
      if (state.error) return { ready: false, reason: state.error };
      if (state.ready) return { ready: true };
      if (Date.now() >= deadline) {
        this.latch('等待驱动最终写入回执超时，队列是否已排空未知；请重新连接并核对设备。');
        return { ready: false, reason: this.error! };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    }
  }

  private isCurrent(attempt: WriteAttempt): boolean {
    return attempt.generation === this.generation && this.inflight.get(attempt.id) === attempt;
  }
  private resetState(): void {
    this.generation += 1;
    this.currentIdentity = null;
    this.error = null;
    this.inflight.clear();
    this.pending.clear();
    this.earlyResults.clear();
    this.publish();
  }
  private latch(reason: string): void { this.error ??= reason; this.publish(); }
  private clearUnneededEarlyResults(): void { if (this.inflight.size === 0) this.earlyResults.clear(); }
  private publish(): void { this.changed(this.snapshot()); }
}
