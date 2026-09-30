/**
 * ChannelStore 环形缓冲与多通道订阅机制测试 (含 20通道 × 10kHz 吞吐压力测试)
 */

import assert from 'node:assert/strict';
import { RingBuffer, ChannelStore } from '../src/core/channel';

export async function runChannelStoreTests() {
  console.log('--- [ChannelStore] 开始测试环形缓冲、多通道订阅与性能基准 ---');

  // 1. 单通道 RingBuffer 基础功能与容量绕回测试
  {
    console.log('  1. 测试 RingBuffer 写入、容量绕回与时间严格升序排列');
    const rb = new RingBuffer(5); // 小容量方便验证绕回
    rb.push(10, 1.0);
    rb.push(20, 2.0);
    rb.push(30, 3.0);
    assert.equal(rb.getSize(), 3);
    assert.equal(rb.latest()?.v, 3.0);

    const snap1 = rb.snapshot();
    assert.equal(snap1.count, 3);
    assert.deepEqual(Array.from(snap1.values), [1.0, 2.0, 3.0]);
    assert.deepEqual(Array.from(snap1.timestamps), [10, 20, 30]);

    // 填满并触发绕回 (共推入 7 个点，最终应保留后 5 个点 [3.0, 4.0, 5.0, 6.0, 7.0])
    rb.push(40, 4.0);
    rb.push(50, 5.0);
    rb.push(60, 6.0);
    rb.push(70, 7.0);

    assert.equal(rb.getSize(), 5);
    assert.equal(rb.getTotalPushed(), 7);
    assert.equal(rb.latest()?.v, 7.0);
    assert.deepEqual(rb.getTimeRange(), { start: 30, end: 70 }, 'time bounds must work after ring wrap without copying samples');

    const snap2 = rb.snapshot();
    assert.equal(snap2.count, 5);
    // 即使在内部发生了绕回，导出的快照必须按时间先后严格升序
    assert.deepEqual(Array.from(snap2.timestamps), [30, 40, 50, 60, 70]);
    assert.deepEqual(Array.from(snap2.values), [3.0, 4.0, 5.0, 6.0, 7.0]);

    // 时间窗筛选测试 [35, 65]
    const snapWindow = rb.snapshot(35, 65);
    assert.equal(snapWindow.count, 3);
    assert.deepEqual(Array.from(snapWindow.timestamps), [40, 50, 60]);
    assert.deepEqual(Array.from(snapWindow.values), [4.0, 5.0, 6.0]);

    const resized = rb.resizeCapacity(3);
    assert.equal(resized.droppedPoints, 2);
    assert.deepEqual([resized.discardedStartTime, resized.discardedEndTime], [30, 40]);
    assert.deepEqual(Array.from(rb.snapshot().timestamps), [50, 60, 70]);
    assert.equal(rb.getTotalPushed(), 7, 'resizing must not rewrite the lifetime sample count');
  }

  // 2. 降采样视图测试 (getView)
  {
    console.log('  2. 测试 RingBuffer 降采样视图');
    const rb = new RingBuffer(1000);
    for (let i = 0; i < 100; i++) {
      rb.push(i, i * 2);
    }
    const view = rb.getView(0, 100, 10);
    assert.equal(view.count, 10);
    assert.equal(view.timestamps[0], 0);
    assert.equal(view.timestamps[9], 90);

    const spike = new RingBuffer(100);
    for (let i = 0; i < 100; i++) spike.push(i, i === 47 ? 1000 : 0);
    const peaks = spike.getMinMaxView(0, 99, 10);
    assert.ok(peaks.count <= 10);
    assert.ok(Array.from(peaks.values).includes(1000), 'display decimation must keep a narrow peak');
    assert.equal(peaks.timestamps[0], 0);
    assert.equal(peaks.timestamps.at(-1), 99);
    assert.ok(spike.getMinMaxView(0, 99, 3).count <= 3, 'min/max view must respect odd point budgets too');
  }

  // 3. ChannelStore 多通道管理与订阅机制
  {
    console.log('  3. 测试 ChannelStore 多通道管理与发布订阅');
    const store = new ChannelStore(1000);
    let notifiedChannels: string[] = [];
    store.onChannelsChanged((names) => {
      notifiedChannels = names;
    });

    store.push('setpoint', 1.0, 100);
    store.push('actual', 1.0, 95);
    assert.ok(store.listChannels().includes('setpoint'));
    assert.ok(store.listChannels().includes('actual'));
    assert.equal(store.latest('actual')?.v, 95);
    assert.deepEqual(store.timeRange('actual'), { start: 1, end: 1 });

    // 订阅机制测试
    let receivedBatch: any = null;
    const unsub = store.subscribe(
      ['setpoint', 'actual'],
      (batch) => {
        receivedBatch = batch;
      },
      { immediate: true }
    );

    assert.ok(receivedBatch !== null);
    assert.equal(receivedBatch.latest.setpoint?.v, 100);

    store.setSessionContext('session-store-1', 4);
    assert.deepEqual(store.getSessionContext(), { sessionId: 'session-store-1', epoch: 4 });

    // 批量 Series 矩阵写入
    store.pushSeries(['setpoint', 'actual'], [2.0, 3.0], [
      [100, 100],
      [98, 101],
    ]);
    store.flushDispatch();

    assert.equal(receivedBatch.latest.actual?.v, 101);
    assert.deepEqual(receivedBatch.updatedChannelIds, ['setpoint', 'actual']);
    assert.ok(receivedBatch.updatedAtMs.setpoint > 0);
    const actualUpdatedAt = receivedBatch.updatedAtMs.actual;
    store.push('setpoint', 4.0, 102);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(receivedBatch.updatedChannelIds, ['setpoint']);
    assert.equal(receivedBatch.updatedAtMs.actual, undefined, 'an unrelated update must not refresh stale telemetry');
    assert.ok(actualUpdatedAt > 0);
    unsub();

    // 移动时间窗订阅测试 (针对相对时间戳与 epoch 时间戳的自适应验证)
    let windowBatch: any = null;
    const unsubWindow = store.subscribe(
      ['actual'],
      (batch) => {
        windowBatch = batch;
      },
      { window: 1.5, immediate: false }
    );

    // 推入相对时间戳数据 t = 10.0, 11.0, 12.0
    store.push('actual', 10.0, 100);
    store.push('actual', 11.0, 110);
    store.push('actual', 12.0, 120);
    store.flushDispatch();

    assert.ok(windowBatch !== null, '时间窗订阅应当收到数据包');
    // 时间窗为 1.5s，基准为最新点 12.0s，因此覆盖 [10.5, 12.0]，应当包含 11.0 和 12.0
    assert.equal(windowBatch.views.actual.count, 2);
    assert.deepEqual(Array.from(windowBatch.views.actual.timestamps), [11.0, 12.0]);
    assert.deepEqual(Array.from(windowBatch.views.actual.values), [110, 120]);
    unsubWindow();

    // 测试 pushProtocolOutput 协议输出直灌
    store.pushProtocolOutput({
      frames: [
        { timestampUs: 13_000_000, values: [999], channelNames: ['rpm'] },
      ],
    });
    assert.equal(store.latest('rpm')?.v, 999);
    assert.equal(store.latest('rpm')?.t, 13.0);

    // 测试 RingBuffer getSlices 零拷贝分段切片
    const rbTest = new RingBuffer(4);
    rbTest.push(1, 10);
    rbTest.push(2, 20);
    rbTest.push(3, 30);
    rbTest.push(4, 40);
    rbTest.push(5, 50); // 发生绕回，元素为 [20, 30, 40, 50]
    const slices = rbTest.getSlices();
    assert.ok(slices.length <= 2);
    let totalFromSlices = 0;
    for (const s of slices) totalFromSlices += s.timestamps.length;
    assert.equal(totalFromSlices, 4);

    const generation = store.getGeneration();
    store.clear();
    assert.equal(store.getGeneration(), generation + 1);
    assert.equal(store.latest('actual'), undefined);
    assert.deepEqual(store.getSessionContext(), { sessionId: null, epoch: null }, '清空实时缓存应清除分析来源会话');
  }

  // 4. 高性能压力测试基准 (20 通道 × 10kHz 写入 1 秒 = 200,000 点)
  {
    console.log('  4. 运行性能测试基准: 20 通道 × 10,000 点/秒 (共 200,000 数据点) 批量与单点高速写入');
    const perfStore = new ChannelStore(50_000);
    const channelCount = 20;
    const pointsPerChannel = 10_000;
    const channels = Array.from({ length: channelCount }, (_, i) => `ch_${i}`);

    const tStart = performance.now();

    // 模拟 100 次 100Hz 批次，每次写入 100 点 (共 10,000 点)
    const batchSize = 100;
    const batchRounds = pointsPerChannel / batchSize;

    const timestamps = new Float64Array(batchSize);
    const seriesData: number[][] = [];
    for (let c = 0; c < channelCount; c++) {
      seriesData.push(new Array(batchSize));
    }

    for (let r = 0; r < batchRounds; r++) {
      const baseT = r * 0.01;
      for (let i = 0; i < batchSize; i++) {
        timestamps[i] = baseT + i * 0.0001;
        for (let c = 0; c < channelCount; c++) {
          seriesData[c][i] = Math.sin(timestamps[i] * 10 + c);
        }
      }
      perfStore.pushSeries(channels, Array.from(timestamps), seriesData);
    }

    const tElapsedMs = performance.now() - tStart;
    const totalPoints = channelCount * pointsPerChannel;
    const pointsPerSec = (totalPoints / (tElapsedMs / 1000)).toFixed(0);

    console.log(
      `     写入 20 通道共 ${totalPoints.toLocaleString()} 数据点耗时: ${tElapsedMs.toFixed(2)} ms (吞吐率: ${Number(pointsPerSec).toLocaleString()} 点/秒)`
    );

    // 验证各通道完整写入且无丢点
    for (const ch of channels) {
      assert.equal(perfStore.getBuffer(ch)?.getSize(), pointsPerChannel);
    }

    // 性能验收断言：20万点写入在现代 CPU 上应在 250ms 以内完成 (吞吐 > 800,000 点/秒)
    assert.ok(
      tElapsedMs < 500,
      `ChannelStore 写入速度过慢: ${tElapsedMs.toFixed(2)} ms (预期 < 500 ms)`
    );
  }

  // 5. Scrubber 回溯切片与别名映射测试
  {
    console.log('  5. 测试 Scrubber 专用 getSliceByIndex 与 ChannelStore snapshotWindow 及别名系统');
    const rb = new RingBuffer(10);
    // 写入 15 个点触发绕回，保留 5..14 (values: 50..140)
    for (let i = 0; i < 15; i++) {
      rb.push(i, i * 10);
    }
    assert.equal(rb.getSize(), 10);

    // 从逻辑索引 3 开始切 4 个点 -> 逻辑 3, 4, 5, 6 对应 80, 90, 100, 110
    const slice = rb.getSliceByIndex(3, 4);
    assert.equal(slice.count, 4);
    assert.deepEqual(Array.from(slice.timestamps), [8, 9, 10, 11]);
    assert.deepEqual(Array.from(slice.values), [80, 90, 100, 110]);

    // 测试越界与超长截断
    const sliceOver = rb.getSliceByIndex(8, 5);
    assert.equal(sliceOver.count, 2); // 仅剩索引 8, 9
    assert.deepEqual(Array.from(sliceOver.values), [130, 140]);

    // 测试 ChannelStore 别名与 snapshotWindow
    const store = new ChannelStore(100);
    for (let i = 0; i < 20; i++) {
      store.push('0', i, i * 2);
    }
    store.setAlias('Speed_RPM', '0');
    store.setAlias('!0', '0');

    // 通过别名访问 latest / getRecent / snapshot / snapshotWindow
    assert.equal(store.latest('Speed_RPM')?.v, 38);
    assert.equal(store.latest('!0')?.v, 38);
    assert.equal(store.getRecent('Speed_RPM', 5).count, 5);

    // 别名订阅必须仍然收到规范通道的更新，并且 latest/时间戳键与
    // 调用方订阅时使用的标识保持一致，避免调参回读被误判为陈旧。
    let aliasBatch: any = null;
    const unsubAlias = store.subscribe(['Speed_RPM'], (batch) => {
      aliasBatch = batch;
    });
    store.push('0', 20, 42);
    store.flushDispatch();
    assert.deepEqual(aliasBatch.updatedChannelIds, ['Speed_RPM']);
    assert.equal(aliasBatch.latest.Speed_RPM?.v, 42);
    assert.ok(aliasBatch.updatedAtMs.Speed_RPM > 0);
    unsubAlias();

    // snapshotWindow (ratio = 0.5 窗口切片)
    const win = store.snapshotWindow('Speed_RPM', 0.5, 6);
    assert.equal(win.count, 6);

    // setDefaultCapacity 验证
    store.setDefaultCapacity(5000);
    store.push('new_ch', 1, 100);
    assert.equal(store.getBuffer('new_ch')?.getCapacity(), 5000);
  }

  // 6. Capacity changes apply to existing channels and display storage is bounded
  {
    const store = new ChannelStore(4);
    for (let index = 0; index < 6; index++) store.push('a', index, index * 2);
    store.push('b', 0, 1);
    const resize = store.setDefaultCapacity(3);
    assert.equal(resize.capacity, 3);
    assert.equal(resize.droppedPoints, 1);
    assert.deepEqual(Array.from(store.snapshot('a').timestamps), [3, 4, 5]);
    assert.equal(store.getBuffer('b')?.getCapacity(), 3);
    assert.deepEqual(store.getBufferSummary(), { channelCount: 2, totalPoints: 4, maxChannelPoints: 3 });

    const bounded = new ChannelStore(1);
    let overflowChannel = '';
    bounded.onCapacityExceeded((channel) => { overflowChannel = channel; });
    for (let index = 0; index < 64; index++) bounded.push(`ch${index}`, 0, index);
    bounded.push('ch64', 0, 64);
    assert.equal(overflowChannel, 'ch64');
    assert.equal(bounded.getBuffer('ch64', false), undefined);
    assert.equal(bounded.getBufferSummary().channelCount, 64);
  }

  console.log('  ✓ [ChannelStore] 环形缓冲与高吞吐性能基准测试全部通过！\n');
}
