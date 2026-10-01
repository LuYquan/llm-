/**
 * 全局高性能多通道数据存储中心 (ChannelStore)
 * 纯数据层管理：环形缓冲、零拷贝快照与多通道发布/订阅体系
 */

import { RingBuffer } from './RingBuffer';
import type {
  ChannelSnapshot,
  ChannelPoint,
  SubscribeOptions,
  ChannelSubscriber,
} from './types';

export type { ChannelViewBatch } from './types';

export const MAX_ACTIVE_CHANNELS = 64;
export const MAX_POINTS_PER_CHANNEL = 50_000;
export const MAX_OWNED_ALIAS_DECLARATIONS = 512;

export interface ChannelAliasBinding { alias: string; targetId: string }
export interface ChannelAliasConflict extends ChannelAliasBinding {
  reason: 'invalid-alias' | 'capacity' | 'duplicate-alias' | 'raw-channel-conflict' | 'canonical-key-conflict' | 'alias-conflict';
}
export interface ChannelAliasRestoreResult {
  accepted: ChannelAliasBinding[];
  conflicts: ChannelAliasConflict[];
}

interface SubscriptionRecord {
  id: number;
  channelIds: string[];
  callback: ChannelSubscriber;
  options: SubscribeOptions;
  lastEmitTime: number;
  pendingChannels: Set<string>;
}

export interface ChannelSessionContext {
  sessionId: string | null;
  epoch: number | null;
}

/** A detached latest point with its actual ingestion identity, independent of rendering. */
export interface ChannelObservation {
  point: ChannelPoint;
  updatedAtMs: number;
  revision: number;
  generation: number;
}

interface DispatchTicket {
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  dueAt: number;
}

export class ChannelStore {
  private buffers: Map<string, RingBuffer> = new Map();
  private channelList: string[] = [];
  private aliases: Map<string, string> = new Map();
  private aliasOwners = new Map<string, symbol>();
  private defaultCapacity: number;
  private channelListeners: Set<(names: string[]) => void> = new Set();
  private clearListeners: Set<(channelId?: string) => void> = new Set();
  private subscribers: Map<number, SubscriptionRecord> = new Map();
  private nextSubId = 1;
  private scheduledDispatch: DispatchTicket | null = null;
  private dispatching = false;
  private dirtyChannels: Set<string> = new Set();
  private channelUpdatedAtMs: Map<string, number> = new Map();
  private channelRevisions: Map<string, number> = new Map();
  private channelIngestedGenerations: Map<string, number> = new Map();
  private generation = 0;
  private capacityExceededListeners = new Set<(channelId: string) => void>();
  private capacityExceededReported = false;
  private sessionContext: ChannelSessionContext = { sessionId: null, epoch: null };

  constructor(defaultCapacity: number = 50_000) {
    this.defaultCapacity = Math.min(MAX_POINTS_PER_CHANNEL, Math.max(1, Math.floor(defaultCapacity)));
  }

  public setDefaultCapacity(cap: number): {
    capacity: number;
    droppedPoints: number;
    discardedStartTime: number | null;
    discardedEndTime: number | null;
  } {
    const capacity = Math.min(MAX_POINTS_PER_CHANNEL, Math.max(1, Math.floor(Number.isFinite(cap) ? cap : this.defaultCapacity)));
    if (capacity <= 0) {
      return { capacity: this.defaultCapacity, droppedPoints: 0, discardedStartTime: null, discardedEndTime: null };
    }
    this.defaultCapacity = capacity;
    let droppedPoints = 0;
    let discardedStartTime: number | null = null;
    let discardedEndTime: number | null = null;
    for (const buffer of this.buffers.values()) {
      const result = buffer.resizeCapacity(capacity);
      droppedPoints += result.droppedPoints;
      if (result.discardedStartTime !== null) discardedStartTime = discardedStartTime === null ? result.discardedStartTime : Math.min(discardedStartTime, result.discardedStartTime);
      if (result.discardedEndTime !== null) discardedEndTime = discardedEndTime === null ? result.discardedEndTime : Math.max(discardedEndTime, result.discardedEndTime);
    }
    return { capacity, droppedPoints, discardedStartTime, discardedEndTime };
  }

  public getDefaultCapacity(): number {
    return this.defaultCapacity;
  }

  public getGeneration(): number {
    return this.generation;
  }

  /** Capture the ingestion watermark before dispatching a device command. */
  public getChannelRevision(channelId: string): number {
    return this.channelRevisions.get(this.resolveChannelKey(channelId)) ?? 0;
  }

  public observeLatest(channelId: string): ChannelObservation | undefined {
    const key = this.resolveChannelKey(channelId);
    const point = this.buffers.get(key)?.latest();
    const updatedAtMs = this.channelUpdatedAtMs.get(key);
    const generation = this.channelIngestedGenerations.get(key);
    if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.v)
      || updatedAtMs === undefined || generation === undefined) return undefined;
    return { point: { ...point }, updatedAtMs, generation, revision: this.channelRevisions.get(key) ?? 0 };
  }

  /**
   * Associate the volatile display cache with the transport session that filled it.
   * This metadata is intentionally separate from sample timestamps: host receive
   * time alone cannot prove that two analysis windows came from the same device
   * connection.
   */
  public setSessionContext(sessionId: string | null, epoch: number | null = null): void {
    this.sessionContext = {
      sessionId: sessionId ? String(sessionId) : null,
      epoch: Number.isSafeInteger(epoch) ? Number(epoch) : null,
    };
  }

  public getSessionContext(): ChannelSessionContext {
    return { ...this.sessionContext };
  }

  public getBufferSummary(): { channelCount: number; totalPoints: number; maxChannelPoints: number } {
    let channelCount = 0;
    let totalPoints = 0;
    let maxChannelPoints = 0;
    for (const buffer of this.buffers.values()) {
      const size = buffer.getSize();
      if (size > 0) channelCount++;
      totalPoints += size;
      maxChannelPoints = Math.max(maxChannelPoints, size);
    }
    return { channelCount, totalPoints, maxChannelPoints };
  }

  public onCapacityExceeded(cb: (channelId: string) => void): () => void {
    this.capacityExceededListeners.add(cb);
    return () => this.capacityExceededListeners.delete(cb);
  }

  /**
   * 注册通道别名 (例如将重命名的别名 'Speed' 或 '!0' 映射到底层物理通道 '0')
   */
  public setAlias(alias: string, targetId: string): void {
    if (!alias || !targetId || alias === targetId) return;
    this.aliases.set(alias, targetId);
    this.aliasOwners.delete(alias);
    if (alias.startsWith('!')) {
      this.aliases.set(alias.slice(1), targetId);
      this.aliasOwners.delete(alias.slice(1));
    } else {
      this.aliases.set(`!${alias}`, targetId);
      this.aliasOwners.delete(`!${alias}`);
    }
  }

  /** Replace only this workspace owner's declarations; never allocate or clear data. */
  public replaceOwnedAliases(owner: symbol, declarations: readonly ChannelAliasBinding[]): ChannelAliasRestoreResult {
    for (const [alias, aliasOwner] of this.aliasOwners) {
      if (aliasOwner === owner) {
        this.aliasOwners.delete(alias);
        this.aliases.delete(alias);
      }
    }
    const result: ChannelAliasRestoreResult = { accepted: [], conflicts: [] };
    const variants = (alias: string) => [...new Set([alias, alias.startsWith('!') ? alias.slice(1) : `!${alias}`].filter(Boolean))];
    const invalidText = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
    const sorted = [...declarations].sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0);
    const valid: ChannelAliasBinding[] = [];
    const canonicalTargets = new Set(sorted.map(item => item.targetId));
    for (const item of sorted) {
      if (typeof item.alias !== 'string' || !item.alias.trim() || item.alias.length > 128 || invalidText.test(item.alias)
        || typeof item.targetId !== 'string' || !item.targetId.trim() || item.targetId.length > 512 || invalidText.test(item.targetId)) {
        result.conflicts.push({ ...item, reason: 'invalid-alias' });
      } else if (valid.length >= MAX_OWNED_ALIAS_DECLARATIONS) {
        result.conflicts.push({ ...item, reason: 'capacity' });
      } else valid.push(item);
    }
    const claims = new Map<string, Set<string>>();
    for (const item of valid) {
      if (item.alias === item.targetId) continue;
      for (const alias of variants(item.alias)) {
        const targets = claims.get(alias) ?? new Set<string>();
        targets.add(item.targetId);
        claims.set(alias, targets);
      }
    }
    for (const item of valid) {
      if (item.alias === item.targetId) continue;
      const keys = variants(item.alias);
      const reason = keys.some(alias => (claims.get(alias)?.size ?? 0) > 1) ? 'duplicate-alias'
        : keys.some(alias => this.buffers.has(alias) && alias !== item.targetId) ? 'raw-channel-conflict'
        : keys.some(alias => canonicalTargets.has(alias) && alias !== item.targetId) ? 'canonical-key-conflict'
        : keys.some(alias => this.aliases.has(alias) && this.aliases.get(alias) !== item.targetId) ? 'alias-conflict' : null;
      if (reason) { result.conflicts.push({ ...item, reason }); continue; }
      for (const alias of keys) {
        if (alias === item.targetId || this.aliases.has(alias)) continue;
        this.aliases.set(alias, item.targetId);
        this.aliasOwners.set(alias, owner);
      }
      result.accepted.push({ ...item });
    }
    return result;
  }

  /** Exact registered ownership, suitable for migrating known data bindings only. */
  public getOwnedAliasTarget(owner: symbol, alias: string): string | null {
    return this.aliasOwners.get(alias) === owner ? this.aliases.get(alias) ?? null : null;
  }

  /**
   * 解析通道标识符，支持别名与 ! 前缀互查
   */
  public resolveChannelKey(nameOrId: string): string {
    if (!nameOrId) return nameOrId;
    if (this.buffers.has(nameOrId)) return nameOrId;
    if (this.aliases.has(nameOrId)) {
      return this.aliases.get(nameOrId)!;
    }
    if (nameOrId.startsWith('!')) {
      const stripped = nameOrId.slice(1);
      if (this.buffers.has(stripped)) return stripped;
      if (this.aliases.has(stripped)) return this.aliases.get(stripped)!;
    } else {
      const prefixed = `!${nameOrId}`;
      if (this.buffers.has(prefixed)) return prefixed;
      if (this.aliases.has(prefixed)) return this.aliases.get(prefixed)!;
    }
    return nameOrId;
  }

  /**
   * 获取或自动创建通道对应的环形缓冲区
   */
  public getBuffer(channelId: string, autoCreate: boolean = true): RingBuffer | undefined {
    const key = this.resolveChannelKey(channelId);
    let buf = this.buffers.get(key);
    if (!buf && autoCreate) {
      if (this.buffers.size >= MAX_ACTIVE_CHANNELS) {
        if (!this.capacityExceededReported) {
          this.capacityExceededReported = true;
          for (const listener of this.capacityExceededListeners) {
            try { listener(key); }
            catch (error) { console.error('[ChannelStore] onCapacityExceeded listener error:', error); }
          }
        }
        return undefined;
      }
      buf = new RingBuffer(this.defaultCapacity);
      this.buffers.set(key, buf);
      if (!this.channelList.includes(key)) {
        this.channelList.push(key);
        this.notifyChannelsChanged();
      }
    }
    return buf;
  }

  /**
   * 获取当前全部已知通道列表
   */
  public listChannels(): string[] {
    return [...this.channelList];
  }

  /**
   * 获取当前全部已知通道列表 (兼容易用性)
   */
  public getAllChannels(): string[] {
    return this.listChannels();
  }

  /**
   * 确保标准预置通道 !0 ~ !7 及常见通道就绪
   */
  public initPresetChannels(presetCount: number = 8): void {
    for (let i = 0; i < presetCount; i++) {
      const id = `!${i}`;
      this.getBuffer(id, true);
      this.setAlias(String(i), id);
    }
  }

  /**
   * 监听通道列表变更 (新增通道)
   */
  public onChannelsChanged(cb: (names: string[]) => void): () => void {
    this.channelListeners.add(cb);
    cb(this.listChannels());
    return () => {
      this.channelListeners.delete(cb);
    };
  }

  public onCleared(cb: (channelId?: string) => void): () => void {
    this.clearListeners.add(cb);
    return () => this.clearListeners.delete(cb);
  }

  private notifyChannelsChanged() {
    const list = this.listChannels();
    for (const listener of this.channelListeners) {
      try {
        listener(list);
      } catch (err) {
        console.error('[ChannelStore] onChannelsChanged listener error:', err);
      }
    }
  }

  /**
   * 向指定通道单点写入
   */
  public push(channelId: string, t: number, v: number): void {
    const key = this.resolveChannelKey(channelId);
    const buf = this.getBuffer(key, true);
    if (!buf) return;
    buf.push(t, v);
    this.markDirty(key);
  }

  /**
   * 写入单帧多通道数据
   */
  public pushFrame(
    t: number,
    values: number[] | Record<string, number>,
    channelNames?: string[]
  ): void {
    if (Array.isArray(values)) {
      const names = channelNames || this.channelList;
      for (let i = 0; i < values.length; i++) {
        const chName = names[i] ?? `ch_${i}`;
        const key = this.resolveChannelKey(chName);
        const buf = this.getBuffer(key, true);
        if (!buf) continue;
        buf.push(t, values[i]);
        this.markDirty(key);
      }
    } else {
      for (const [key, val] of Object.entries(values)) {
        const resolvedKey = this.resolveChannelKey(key);
        const buf = this.getBuffer(resolvedKey, true);
        if (!buf) continue;
        buf.push(t, val);
        this.markDirty(resolvedKey);
      }
    }
    this.scheduleDispatch();
  }

  /**
   * 批量写入多点数据 (兼容旧 ChannelHub 数据格式)
   */
  public pushBatch(points: { timestamp: number; values: Record<string, number> }[]): void {
    if (!points || points.length === 0) return;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const t = pt.timestamp;
      for (const [key, val] of Object.entries(pt.values)) {
        const resolvedKey = this.resolveChannelKey(key);
        const buf = this.getBuffer(resolvedKey, true);
        if (!buf) continue;
        buf.push(t, val);
        this.markDirty(resolvedKey);
      }
    }
    this.scheduleDispatch();
  }

  /**
   * 批量写入多通道 Series 矩阵 (对齐 WaveformBatch 格式)
   */
  public pushSeries(channelNames: string[], timestamps: number[], series: number[][]): void {
    const count = timestamps.length;
    if (count === 0) return;

    for (let chIdx = 0; chIdx < channelNames.length; chIdx++) {
      const name = channelNames[chIdx];
      const s = series[chIdx];
      if (!s || s.length === 0) continue;

      const key = this.resolveChannelKey(name);
      const buf = this.getBuffer(key, true);
      if (!buf) continue;
      buf.pushBatch(timestamps, s, count);
      this.markDirty(key);
    }
    this.scheduleDispatch();
  }

  /**
   * 获取指定通道的最新单点读数
   */
  public latest(channelId: string): ChannelPoint | undefined {
    return this.getBuffer(channelId, false)?.latest();
  }

  /** Return a channel's retained time bounds without materializing its samples. */
  public timeRange(channelId: string): { start: number; end: number } | null {
    return this.getBuffer(channelId, false)?.getTimeRange() ?? null;
  }

  /**
   * 快速获取指定通道最新的 count 个点
   */
  public getRecent(channelId: string, count: number): ChannelSnapshot {
    const buf = this.getBuffer(channelId, false);
    if (!buf) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }
    return buf.getRecent(count);
  }

  /**
   * 获取指定通道的时间区间快照
   */
  public snapshot(channelId: string, fromT?: number, toT?: number): ChannelSnapshot {
    const buf = this.getBuffer(channelId, false);
    if (!buf) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }
    return buf.snapshot(fromT, toT);
  }

  /**
   * 根据历史回溯比率 ratio (0.0 ~ 1.0) 提取指定窗口大小的时序快照 (供 Scrubber 时间轴滑块回溯波形)
   */
  public snapshotWindow(channelId: string, ratio: number, windowCount: number = 3000): ChannelSnapshot {
    const buf = this.getBuffer(channelId, false);
    if (!buf || buf.getSize() === 0) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }
    const total = buf.getSize();
    if (ratio >= 0.999 || total <= windowCount) {
      return buf.getRecent(windowCount);
    }
    const targetIdx = Math.floor(Math.max(0, Math.min(1, ratio)) * total);
    const start = Math.max(0, targetIdx - windowCount);
    return buf.getSliceByIndex(start, windowCount);
  }

  /**
   * 获取多个通道的批量时间切片快照
   */
  public snapshotMulti(
    channelIds: string[],
    fromT?: number,
    toT?: number
  ): Record<string, ChannelSnapshot> {
    const res: Record<string, ChannelSnapshot> = {};
    for (const id of channelIds) {
      res[id] = this.snapshot(id, fromT, toT);
    }
    return res;
  }

  /**
   * 兼容旧版 ChannelHub.range 接口，直接返回 TypedArray
   */
  public range(
    channelId: string,
    fromT: number,
    toT: number
  ): { t: Float64Array; v: Float64Array } {
    const s = this.snapshot(channelId, fromT, toT);
    return { t: s.timestamps, v: s.values };
  }

  /**
   * 清空指定或全部通道
   */
  public clear(channelId?: string): void {
    this.cancelScheduledDispatch();
    this.generation++;
    if (channelId) {
      const key = this.resolveChannelKey(channelId);
      this.buffers.get(key)?.clear();
      this.dirtyChannels.delete(key);
      this.channelUpdatedAtMs.delete(key);
      this.channelRevisions.delete(key);
      this.channelIngestedGenerations.delete(key);
      for (const subscriber of this.subscribers.values()) subscriber.pendingChannels.delete(key);
    } else {
      for (const buf of this.buffers.values()) {
        buf.clear();
      }
      this.dirtyChannels.clear();
      this.channelUpdatedAtMs.clear();
      this.channelRevisions.clear();
      this.channelIngestedGenerations.clear();
      for (const subscriber of this.subscribers.values()) subscriber.pendingChannels.clear();
    }
    if (!channelId) this.sessionContext = { sessionId: null, epoch: null };
    for (const listener of this.clearListeners) {
      try { listener(channelId); }
      catch (error) { console.error('[ChannelStore] onCleared listener error:', error); }
    }
    if (this.dirtyChannels.size || [...this.subscribers.values()].some((sub) => sub.pendingChannels.size)) this.scheduleDispatch();
  }

  /**
   * 订阅多通道数据更新 (支持按帧率节流、时间窗裁切与降采样)
   */
  public subscribe(
    channelIds: string[],
    callback: ChannelSubscriber,
    options: SubscribeOptions = {}
  ): () => void {
    const id = this.nextSubId++;
    this.subscribers.set(id, {
      id,
      channelIds: [...channelIds],
      callback,
      options,
      lastEmitTime: 0,
      pendingChannels: new Set(),
    });

    // 若需要立即触发一次初始推送
    if (options.immediate) {
      this.emitToSubscriber(this.subscribers.get(id)!);
    }
    if (this.dirtyChannels.size) this.scheduleDispatch();

    return () => {
      this.subscribers.delete(id);
      if (this.subscribers.size === 0) this.cancelScheduledDispatch();
    };
  }

  private markDirty(channelId: string) {
    this.dirtyChannels.add(channelId);
    this.channelUpdatedAtMs.set(channelId, Date.now());
    this.channelRevisions.set(channelId, (this.channelRevisions.get(channelId) ?? 0) + 1);
    this.channelIngestedGenerations.set(channelId, this.generation);
    this.scheduleDispatch();
  }

  private scheduleDispatch(delayMs = 0) {
    const wait = delayMs > 0 ? delayMs : 16;
    const dueAt = Date.now() + wait;
    if (this.scheduledDispatch && this.scheduledDispatch.dueAt <= dueAt) return;
    this.cancelScheduledDispatch();
    const ticket: DispatchTicket = { timer: null, frame: null, dueAt };
    this.scheduledDispatch = ticket;
    const dispatch = () => {
      // A cancelled callback may already be queued. It must not release a newer ticket.
      if (this.scheduledDispatch !== ticket) return;
      this.cancelScheduledDispatch();
      this.flushDispatch();
    };
    ticket.timer = setTimeout(dispatch, wait);
    // Rendering is optional. The timer races the frame; neither is a real-time guarantee.
    if (delayMs <= 0 && typeof requestAnimationFrame === 'function') ticket.frame = requestAnimationFrame(dispatch);
  }

  private cancelScheduledDispatch() {
    const ticket = this.scheduledDispatch;
    if (!ticket) return;
    this.scheduledDispatch = null;
    if (ticket.timer !== null) clearTimeout(ticket.timer);
    if (ticket.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(ticket.frame);
  }

  /**
   * 触发所有订阅者的分发更新
   */
  public flushDispatch(): void {
    if (this.dispatching) return;
    this.cancelScheduledDispatch();
    if (this.subscribers.size === 0) {
      this.dirtyChannels.clear();
      return;
    }

    const updated = [...this.dirtyChannels];
    // Detach before callbacks, so callback ingestion remains dirty for the next dispatch.
    this.dirtyChannels.clear();
    const now = Date.now();
    const generation = this.generation;
    const subscribers = [...this.subscribers.values()];
    this.dispatching = true;
    try {
      for (const sub of subscribers) {
        // Dirty keys are canonical IDs, while subscribers may use a display/name alias.
        const updatedForSubscriber = updated.filter((channel) =>
          sub.channelIds.some((requested) => this.resolveChannelKey(requested) === channel),
        );
        for (const channel of updatedForSubscriber) sub.pendingChannels.add(channel);
      }
      for (const sub of subscribers) {
        if (this.generation !== generation) break;
        if (this.subscribers.get(sub.id) !== sub) continue;
        if (sub.pendingChannels.size === 0) continue;
        const remainingMs = this.subscriberInterval(sub) - (now - sub.lastEmitTime);
        if (remainingMs > 0) continue;
        const pending = [...sub.pendingChannels];
        sub.pendingChannels.clear();
        sub.lastEmitTime = now;
        this.emitToSubscriber(sub, pending);
      }
    } finally {
      this.dispatching = false;
      if (this.dirtyChannels.size) this.scheduleDispatch();
      else {
        let remaining = Infinity;
        for (const sub of this.subscribers.values()) {
          if (sub.pendingChannels.size) remaining = Math.min(remaining, Math.max(0, this.subscriberInterval(sub) - (Date.now() - sub.lastEmitTime)));
        }
        if (remaining !== Infinity) this.scheduleDispatch(remaining);
      }
    }
  }

  private subscriberInterval(sub: SubscriptionRecord): number {
    return sub.options.fps && Number.isFinite(sub.options.fps) && sub.options.fps > 0 ? 1000 / sub.options.fps : 16;
  }

  /**
   * 将 ProtocolEngine 的解析输出批量写入 ChannelStore
   */
  public pushProtocolOutput(output: {
    frames: { timestampUs: number; values: number[]; channelNames?: string[] }[];
  }): void {
    if (!output || !output.frames || output.frames.length === 0) return;
    for (const frame of output.frames) {
      // 统一转换为秒级时间戳写入
      const tSec = frame.timestampUs / 1_000_000;
      this.pushFrame(tSec, frame.values, frame.channelNames);
    }
  }

  private emitToSubscriber(sub: SubscriptionRecord, updatedChannelIds: string[] = []) {
    const views: Record<string, ChannelSnapshot> = {};
    const latest: Record<string, ChannelPoint | undefined> = {};
    const updatedAtMs: Record<string, number> = {};
    const updatedRevisions: Record<string, number> = {};
    const updatedGenerations: Record<string, number> = {};
    const updatedCanonical = new Set(updatedChannelIds.map((channel) => this.resolveChannelKey(channel)));
    for (const requestedChannel of sub.channelIds) {
      const canonical = this.resolveChannelKey(requestedChannel);
      if (updatedCanonical.has(canonical)) {
        const updatedAt = this.channelUpdatedAtMs.get(canonical);
        if (updatedAt !== undefined) updatedAtMs[requestedChannel] = updatedAt;
        updatedRevisions[requestedChannel] = this.channelRevisions.get(canonical) ?? 0;
        const ingestedGeneration = this.channelIngestedGenerations.get(canonical);
        if (ingestedGeneration !== undefined) updatedGenerations[requestedChannel] = ingestedGeneration;
      }
    }

    let fromT: number | undefined = undefined;
    let toT: number | undefined = undefined;

    // 寻找被订阅通道中的最新有效时间戳作为移动时间窗基准
    let maxLatestT = -Infinity;
    for (const ch of sub.channelIds) {
      const p = this.buffers.get(this.resolveChannelKey(ch))?.latest();
      if (p && p.t > maxLatestT) {
        maxLatestT = p.t;
      }
    }

    if (sub.options.window && sub.options.window > 0) {
      if (maxLatestT !== -Infinity) {
        toT = maxLatestT;
        fromT = maxLatestT - sub.options.window;
      }
    }

    for (const ch of sub.channelIds) {
      const buf = this.buffers.get(this.resolveChannelKey(ch));
      if (buf) {
        latest[ch] = buf.latest();
        if (sub.options.decimation && sub.options.decimation > 0) {
          views[ch] = buf.getView(fromT, toT, sub.options.decimation);
        } else {
          views[ch] = buf.snapshot(fromT, toT);
        }
      } else {
        views[ch] = {
          timestamps: new Float64Array(0),
          values: new Float64Array(0),
          count: 0,
        };
        latest[ch] = undefined;
      }
    }

    try {
      sub.callback({
        channelIds: sub.channelIds,
        // Report the identifier used by the subscription. This keeps alias
        // bindings usable by consumers that index `latest` and `updatedAtMs`
        // with their configured channel name while storage remains canonical.
        updatedChannelIds: sub.channelIds.filter((channel) => updatedCanonical.has(this.resolveChannelKey(channel))),
        updatedAtMs,
        updatedRevisions,
        updatedGenerations,
        generation: this.generation,
        views,
        latest,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('[ChannelStore] Subscriber callback exception:', err);
    }
  }
}

export const globalChannelStore = new ChannelStore();
globalChannelStore.initPresetChannels(8);

