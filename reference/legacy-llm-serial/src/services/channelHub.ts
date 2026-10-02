/**
 * 全局通道数据中枢 (ChannelHub)
 * 适配并代理至底层高性能 ChannelStore 环形缓冲中枢
 */

import { ChannelStore, globalChannelStore } from '../core/channel/ChannelStore';

export class ChannelHubService {
  private store: ChannelStore;

  constructor(maxPoints: number = 200000, store?: ChannelStore) {
    this.store = store || new ChannelStore(maxPoints);
    // 初始化确保默认三大通道就绪
    this.store.getBuffer('setpoint', true);
    this.store.getBuffer('actual', true);
    this.store.getBuffer('output', true);
  }

  /**
   * 获取底层关联的 ChannelStore 实例
   */
  public getStore(): ChannelStore {
    return this.store;
  }

  /**
   * 当前已出现过的通道名称列表
   */
  public listChannels(): string[] {
    return this.store.listChannels();
  }

  /**
   * 监听通道列表扩展
   */
  public onChannelsChanged(cb: (names: string[]) => void): () => void {
    return this.store.onChannelsChanged(cb);
  }

  /**
   * 获取指定通道的最新一条读数
   */
  public latest(channel: string): { t: number; v: number } | undefined {
    return this.store.latest(channel);
  }

  /**
   * 获取 [fromT, toT] 时间区间内的数据切片 (供波形图按帧渲染)
   */
  public range(
    channel: string,
    fromT: number,
    toT: number
  ): { t: Float64Array; v: Float64Array } {
    return this.store.range(channel, fromT, toT);
  }

  /**
   * 批量写入数据帧 (从串口管线解析结果传入)
   */
  public pushBatch(points: { timestamp: number; values: Record<string, number> }[]): void {
    this.store.pushBatch(points);
  }

  /**
   * 清空所有历史缓冲区
   */
  public clear(): void {
    this.store.clear();
  }
}

export const globalChannelHub = new ChannelHubService(200000, globalChannelStore);
export { ChannelHubService as ChannelHub };
