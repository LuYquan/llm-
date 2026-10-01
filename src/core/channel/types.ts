/**
 * ChannelStore 核心数据类型定义
 */

export interface ChannelSnapshot {
  timestamps: Float64Array;
  values: Float64Array;
  count: number;
}

export interface ChannelPoint {
  t: number;
  v: number;
}

export interface SubscribeOptions {
  window?: number; // 观察时间窗口 (秒)
  decimation?: number; // 目标最大降采样点数 (如 2000)
  fps?: number; // 调度帧率 (如 30 或 60)
  immediate?: boolean;
}

export interface ChannelViewBatch {
  channelIds: string[];
  /** Channels which received new points since the preceding dispatch. */
  updatedChannelIds: string[];
  /** Wall-clock ingestion time in milliseconds for each updated channel. */
  updatedAtMs: Record<string, number>;
  /** Canonical ingestion revisions, keyed by each requested subscription name. */
  updatedRevisions: Record<string, number>;
  /** Generation in which each updated channel was actually ingested. */
  updatedGenerations: Record<string, number>;
  /** Current display-store generation; a partial clear can leave older channel points. */
  generation: number;
  views: Record<string, ChannelSnapshot>;
  latest: Record<string, ChannelPoint | undefined>;
  timestamp: number;
}

export type ChannelSubscriber = (batch: ChannelViewBatch) => void;
