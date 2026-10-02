/**
 * 高性能单通道环形缓冲区 (RingBuffer)
 * 底层基于 Float64Array TypedArray 实现，提供 O(1) 写入与切片零拷贝/快速内存块拷贝
 */

import type { ChannelSnapshot, ChannelPoint } from './types';

export class RingBuffer {
  public capacity: number;
  private timestamps: Float64Array;
  private values: Float64Array;
  private head: number = 0; // 下一个写入位置
  private size: number = 0; // 当前已存储点数
  private totalPushed: number = 0;
  private latestPoint?: ChannelPoint;

  constructor(capacity: number = 1_000_000) {
    this.capacity = Math.max(1, capacity);
    this.timestamps = new Float64Array(this.capacity);
    this.values = new Float64Array(this.capacity);
  }

  /**
   * 追加单个数据点
   */
  public push(t: number, v: number): void {
    const idx = this.head;
    this.timestamps[idx] = t;
    this.values[idx] = v;
    this.head = (idx + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    }
    this.totalPushed++;
    this.latestPoint = { t, v };
  }

  /**
   * 批量追加数据点
   */
  public pushBatch(ts: ArrayLike<number>, vs: ArrayLike<number>, count?: number): void {
    const n = Math.min(count ?? ts.length, vs.length);
    if (n <= 0) return;

    // 若一次写入大于缓冲区容量，仅保留最后的 capacity 个点
    if (n >= this.capacity) {
      const startOffset = n - this.capacity;
      if (ts instanceof Float64Array && vs instanceof Float64Array) {
        this.timestamps.set(ts.subarray(startOffset, n), 0);
        this.values.set(vs.subarray(startOffset, n), 0);
      } else {
        for (let i = 0; i < this.capacity; i++) {
          this.timestamps[i] = ts[startOffset + i];
          this.values[i] = vs[startOffset + i];
        }
      }
      this.head = 0;
      this.size = this.capacity;
      this.totalPushed += n;
      this.latestPoint = { t: ts[n - 1], v: vs[n - 1] };
      return;
    }

    // 分段写入环形缓冲
    const firstChunk = Math.min(n, this.capacity - this.head);
    if (ts instanceof Float64Array && vs instanceof Float64Array) {
      this.timestamps.set(ts.subarray(0, firstChunk), this.head);
      this.values.set(vs.subarray(0, firstChunk), this.head);
      const secondChunk = n - firstChunk;
      if (secondChunk > 0) {
        this.timestamps.set(ts.subarray(firstChunk, n), 0);
        this.values.set(vs.subarray(firstChunk, n), 0);
      }
    } else {
      for (let i = 0; i < firstChunk; i++) {
        this.timestamps[this.head + i] = ts[i];
        this.values[this.head + i] = vs[i];
      }
      const secondChunk = n - firstChunk;
      for (let i = 0; i < secondChunk; i++) {
        this.timestamps[i] = ts[firstChunk + i];
        this.values[i] = vs[firstChunk + i];
      }
    }

    this.head = (this.head + n) % this.capacity;
    this.size = Math.min(this.capacity, this.size + n);
    this.totalPushed += n;
    this.latestPoint = { t: ts[n - 1], v: vs[n - 1] };
  }

  /**
   * 获取最新一条数据读数
   */
  public latest(): ChannelPoint | undefined {
    return this.latestPoint;
  }

  /**
   * 获取环形缓冲区容量上限
   */
  public getCapacity(): number {
    return this.capacity;
  }

  /**
   * 获取当前有效点数
   */
  public getSize(): number {
    return this.size;
  }

  /** Resize while retaining the newest samples and report any discarded time span. */
  public resizeCapacity(requestedCapacity: number): { droppedPoints: number; discardedStartTime: number | null; discardedEndTime: number | null } {
    const nextCapacity = Math.max(1, Math.floor(requestedCapacity));
    if (nextCapacity === this.capacity) {
      return { droppedPoints: 0, discardedStartTime: null, discardedEndTime: null };
    }
    const retained = Math.min(this.size, nextCapacity);
    const droppedPoints = this.size - retained;
    let discardedStartTime: number | null = null;
    let discardedEndTime: number | null = null;
    if (droppedPoints > 0) {
      const logicalStart = this.size < this.capacity ? 0 : this.head;
      discardedStartTime = this.timestamps[logicalStart];
      discardedEndTime = this.timestamps[(logicalStart + droppedPoints - 1) % this.capacity];
    }
    const recent = this.getRecent(retained);
    const totalPushed = this.totalPushed;
    this.capacity = nextCapacity;
    this.timestamps = new Float64Array(nextCapacity);
    this.values = new Float64Array(nextCapacity);
    this.timestamps.set(recent.timestamps);
    this.values.set(recent.values);
    this.size = retained;
    this.head = retained % nextCapacity;
    this.totalPushed = totalPushed;
    this.latestPoint = retained > 0
      ? { t: recent.timestamps[retained - 1], v: recent.values[retained - 1] }
      : undefined;
    return { droppedPoints, discardedStartTime, discardedEndTime };
  }

  /** Oldest and newest stored sample time without copying the ring buffer. */
  public getTimeRange(): { start: number; end: number } | null {
    if (this.size === 0) return null;
    const first = this.size < this.capacity ? 0 : this.head;
    const last = (this.head - 1 + this.capacity) % this.capacity;
    return { start: this.timestamps[first], end: this.timestamps[last] };
  }

  /**
   * 获取总写入数据量
   */
  public getTotalPushed(): number {
    return this.totalPushed;
  }

  /**
   * 二分查找定位 [fromT, toT] 的逻辑时序起止索引
   * 返回 { start, kStart, kEnd, count }
   */
  private getLogicalRange(fromT?: number, toT?: number): {
    start: number;
    kStart: number;
    kEnd: number;
    count: number;
  } {
    if (this.size === 0) {
      return { start: 0, kStart: 0, kEnd: -1, count: 0 };
    }

    const start = this.size < this.capacity ? 0 : this.head;
    const minT = fromT ?? -Infinity;
    const maxT = toT ?? Infinity;

    // 二分查找下界 kStart (首个 t >= minT)
    let low = 0;
    let high = this.size - 1;
    let kStart = this.size;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = this.timestamps[(start + mid) % this.capacity];
      if (t >= minT) {
        kStart = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    // 二分查找上界 kEnd (末个 t <= maxT)
    low = 0;
    high = this.size - 1;
    let kEnd = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = this.timestamps[(start + mid) % this.capacity];
      if (t <= maxT) {
        kEnd = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const count = kEnd >= kStart ? kEnd - kStart + 1 : 0;
    return { start, kStart, kEnd, count };
  }

  /**
   * 按照逻辑索引提取连续时序快照
   */
  private extractSnapshot(start: number, kStart: number, count: number): ChannelSnapshot {
    if (count <= 0) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }

    const pStart = (start + kStart) % this.capacity;
    const firstChunk = Math.min(count, this.capacity - pStart);
    const secondChunk = count - firstChunk;

    // 单段连续
    if (secondChunk === 0) {
      // 若全量未绕回且从0开始，返回零拷贝切片
      if (pStart === 0 && count === this.size && this.size < this.capacity) {
        return {
          timestamps: this.timestamps.subarray(0, count),
          values: this.values.subarray(0, count),
          count,
        };
      }
      const outT = new Float64Array(count);
      const outV = new Float64Array(count);
      outT.set(this.timestamps.subarray(pStart, pStart + count));
      outV.set(this.values.subarray(pStart, pStart + count));
      return { timestamps: outT, values: outV, count };
    }

    // 两段拼接 (绕回)
    const outT = new Float64Array(count);
    const outV = new Float64Array(count);
    outT.set(this.timestamps.subarray(pStart, this.capacity), 0);
    outT.set(this.timestamps.subarray(0, secondChunk), firstChunk);
    outV.set(this.values.subarray(pStart, this.capacity), 0);
    outV.set(this.values.subarray(0, secondChunk), firstChunk);

    return { timestamps: outT, values: outV, count };
  }

  /**
   * 快速提取最新的 count 个点 (O(count) 极速快照，避免二分查找)
   */
  public getRecent(count: number): ChannelSnapshot {
    if (this.size === 0 || count <= 0) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }
    const n = Math.min(count, this.size);
    const start = this.size < this.capacity ? 0 : this.head;
    const kStart = this.size - n;
    return this.extractSnapshot(start, kStart, n);
  }

  /**
   * 按照逻辑索引提取任意时序切片 (用于历史 Scrubber 时间轴自由回溯)
   */
  public getSliceByIndex(startIndex: number, count: number): ChannelSnapshot {
    if (this.size === 0 || count <= 0) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }
    const clampedStart = Math.max(0, Math.min(this.size - 1, startIndex));
    const n = Math.min(count, this.size - clampedStart);
    const start = this.size < this.capacity ? 0 : this.head;
    return this.extractSnapshot(start, clampedStart, n);
  }

  /**
   * 获取时间窗或全量时序快照 (O(log N) 二分范围查找 + 高速内存块拷贝)
   */
  public snapshot(fromT?: number, toT?: number): ChannelSnapshot {
    if (this.size === 0) {
      return {
        timestamps: new Float64Array(0),
        values: new Float64Array(0),
        count: 0,
      };
    }

    // 无时间筛选全量快照
    if (fromT === undefined && toT === undefined) {
      const start = this.size < this.capacity ? 0 : this.head;
      return this.extractSnapshot(start, 0, this.size);
    }

    // 时间窗筛选：O(log N) 二分查找
    const { start, kStart, count } = this.getLogicalRange(fromT, toT);
    return this.extractSnapshot(start, kStart, count);
  }

  /**
   * 获取零拷贝分段切片 (零内存分配，直接返回 1 或 2 个 TypedArray subarray)
   */
  public getSlices(fromT?: number, toT?: number): { timestamps: Float64Array; values: Float64Array }[] {
    if (this.size === 0) return [];
    const { start, kStart, count } = this.getLogicalRange(fromT, toT);
    if (count <= 0) return [];

    const pStart = (start + kStart) % this.capacity;
    const firstChunk = Math.min(count, this.capacity - pStart);
    const secondChunk = count - firstChunk;

    const res = [
      {
        timestamps: this.timestamps.subarray(pStart, pStart + firstChunk),
        values: this.values.subarray(pStart, pStart + firstChunk),
      },
    ];

    if (secondChunk > 0) {
      res.push({
        timestamps: this.timestamps.subarray(0, secondChunk),
        values: this.values.subarray(0, secondChunk),
      });
    }

    return res;
  }

  /**
   * 获取降采样视图 (直接从环形缓冲按步长抽取，零中间内存分配)
   */
  public getView(fromT?: number, toT?: number, maxPoints?: number): ChannelSnapshot {
    if (this.size === 0) {
      return { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 };
    }

    const { start, kStart, count } = this.getLogicalRange(fromT, toT);
    if (count <= 0) {
      return { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 };
    }

    if (!maxPoints || count <= maxPoints || maxPoints <= 1) {
      return this.extractSnapshot(start, kStart, count);
    }

    // 步长均匀降采样：直接从 this.timestamps 与 this.values 抽取
    const step = count / maxPoints;
    const outT = new Float64Array(maxPoints);
    const outV = new Float64Array(maxPoints);

    for (let i = 0; i < maxPoints; i++) {
      const logicalIdx = kStart + Math.min(count - 1, Math.floor(i * step));
      const physIdx = (start + logicalIdx) % this.capacity;
      outT[i] = this.timestamps[physIdx];
      outV[i] = this.values[physIdx];
    }

    return {
      timestamps: outT,
      values: outV,
      count: maxPoints,
    };
  }

  /**
   * Peak-preserving display view. Each interior bucket contributes its minimum and
   * maximum in chronological order; the first and last samples are retained.
   */
  public getMinMaxView(fromT?: number, toT?: number, maxPoints: number = 3000): ChannelSnapshot {
    if (this.size === 0 || maxPoints <= 0) {
      return { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 };
    }
    const { start, kStart, kEnd, count } = this.getLogicalRange(fromT, toT);
    if (count <= 0) return { timestamps: new Float64Array(0), values: new Float64Array(0), count: 0 };
    if (count <= maxPoints) return this.extractSnapshot(start, kStart, count);

    const target = Math.floor(maxPoints);
    const indices: number[] = [];
    const first = kStart;
    const last = kEnd;
    if (target === 1) {
      indices.push(last);
    } else if (target === 2) {
      indices.push(first, last);
    } else {
      indices.push(first);
      const interiorCount = Math.max(0, count - 2);
      const bucketCount = Math.max(1, Math.floor((target - 2) / 2));
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        const bucketStart = first + 1 + Math.floor(bucket * interiorCount / bucketCount);
        const bucketEnd = first + 1 + Math.floor((bucket + 1) * interiorCount / bucketCount);
        if (bucketStart >= bucketEnd) continue;
        let minIndex = bucketStart;
        let maxIndex = bucketStart;
        let minValue = Number.POSITIVE_INFINITY;
        let maxValue = Number.NEGATIVE_INFINITY;
        for (let logical = bucketStart; logical < bucketEnd; logical++) {
          const physical = (start + logical) % this.capacity;
          const value = this.values[physical];
          if (!Number.isFinite(value)) continue;
          if (value < minValue) { minValue = value; minIndex = logical; }
          if (value > maxValue) { maxValue = value; maxIndex = logical; }
        }
        if (target - 2 === 1) {
          indices.push(Math.abs(minValue) >= Math.abs(maxValue) ? minIndex : maxIndex);
        } else if (minIndex <= maxIndex) {
          indices.push(minIndex, ...(maxIndex === minIndex ? [] : [maxIndex]));
        } else {
          indices.push(maxIndex, minIndex);
        }
      }
      indices.push(last);
    }

    const outT = new Float64Array(indices.length);
    const outV = new Float64Array(indices.length);
    for (let index = 0; index < indices.length; index++) {
      const physical = (start + indices[index]) % this.capacity;
      outT[index] = this.timestamps[physical];
      outV[index] = this.values[physical];
    }
    return { timestamps: outT, values: outV, count: outT.length };
  }

  /**
   * 清空缓冲区
   */
  public clear(): void {
    this.head = 0;
    this.size = 0;
    this.totalPushed = 0;
    this.latestPoint = undefined;
  }
}
