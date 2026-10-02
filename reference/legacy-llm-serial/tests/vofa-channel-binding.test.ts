/**
 * VOFA+ 级联右键通道绑定与变量选择器核心测试套件
 */

import assert from 'node:assert/strict';
import {
  formatChannelFloatValue,
  normalizeChannelId,
  getAvailableChannels,
  getWidgetBoundChannel,
  isChannelBindableWidget,
  bindWidgetChannel,
  toggleChartSeriesChannel,
  isChannelInChartSeries,
  formatBindingDisplay,
} from '../src/utils/channelHelpers';
import { ChannelStore } from '../src/core/channel/ChannelStore';
import { createNewWidget } from '../src/stores/widgetStore';

export async function runVofaChannelBindingTests() {
  console.log('--- [VOFA+ Channel Binding] 开始执行通道选择与级联绑定机制全量测试 ---');

  // 1. 测试高精浮点 6 位小数格式化与异常值保护
  console.log('  1. 测试高精浮点 6 位格式化与空值保护');
  assert.equal(formatChannelFloatValue(0), '0.000000');
  assert.equal(formatChannelFloatValue(12.3456789), '12.345679');
  assert.equal(formatChannelFloatValue(-3.14159), '-3.141590');
  assert.equal(formatChannelFloatValue(undefined), '--');
  assert.equal(formatChannelFloatValue(null), '--');
  assert.equal(formatChannelFloatValue(NaN), '--');

  // 2. 测试通道 ID 规范化 (数字、空白、空值)
  console.log('  2. 测试通道 ID 规范化与边界容错');
  assert.equal(normalizeChannelId('0'), '!0');
  assert.equal(normalizeChannelId('7'), '!7');
  assert.equal(normalizeChannelId(0 as any), '!0');
  assert.equal(normalizeChannelId(7 as any), '!7');
  assert.equal(normalizeChannelId('  !4  '), '!4');
  assert.equal(normalizeChannelId('  5  '), '!5');
  assert.equal(normalizeChannelId('!4'), '!4');
  assert.equal(normalizeChannelId('actual'), 'actual');
  assert.equal(normalizeChannelId('  actual  '), 'actual');
  assert.equal(normalizeChannelId(''), '');
  assert.equal(normalizeChannelId(null), '');
  assert.equal(normalizeChannelId(undefined), '');

  // 3. 测试 getAvailableChannels 预置通道常驻与动态数据发现
  console.log('  3. 测试 getAvailableChannels 预置常驻与动态数据流聚合');
  const mockChannelStore = new ChannelStore(100);
  mockChannelStore.push('!4', 1.0, 24.5123);
  mockChannelStore.push('speed_rpm', 1.0, 1500.0);

  const mockWidgetStore = {
    channelMetaMap: {
      value: {
        '!4': { id: '!4', name: '速度反馈', color: '#4ADE80' },
      },
    },
    getChannelMeta: (id: string) => {
      if (id === '!4') return { id: '!4', name: '速度反馈', color: '#4ADE80' };
      return { id, name: id, color: '#38BDF8' };
    },
  };

  const channels = getAvailableChannels(mockWidgetStore, mockChannelStore);
  // 必须包含 !0 ~ !7 (共8个预置) + speed_rpm
  assert.ok(channels.some((c) => c.id === '!0'));
  assert.ok(channels.some((c) => c.id === '!7'));
  assert.ok(channels.some((c) => c.id === 'speed_rpm'));

  // 检查 !4 的动态值与别名
  const ch4 = channels.find((c) => c.id === '!4');
  assert.ok(ch4 !== undefined);
  assert.equal(ch4?.name, '速度反馈');
  assert.equal(ch4?.color, '#4ADE80');
  assert.equal(ch4?.isActive, true);
  assert.equal(ch4?.formattedValue, '24.512300');

  // 检查未到达数据的 !0 的 isActive 状态
  const ch0 = channels.find((c) => c.id === '!0');
  assert.ok(ch0 !== undefined);
  assert.equal(ch0?.isActive, false);
  assert.equal(ch0?.formattedValue, '--');

  // 4. 测试不同单值控件的通道绑定与解绑 (getWidgetBoundChannel / bindWidgetChannel)
  console.log('  4. 测试单值控件 (Gauge / Slider / Number / LED / Knob / StatCard) 绑定与解绑');
  const gauge = createNewWidget('gauge', 0, 0);
  assert.equal(isChannelBindableWidget(gauge), true);
  bindWidgetChannel(gauge, '4'); // 传入纯数字字符串 '4'
  assert.equal(getWidgetBoundChannel(gauge), '!4'); // 自动规范化为 '!4'
  assert.equal(gauge.config.channel, '!4');
  assert.equal(formatBindingDisplay(gauge, mockWidgetStore), '!4 (速度反馈)');

  // 清除绑定
  bindWidgetChannel(gauge, null);
  assert.equal(getWidgetBoundChannel(gauge), null);
  assert.equal(formatBindingDisplay(gauge, mockWidgetStore), '未绑定');

  // 滑块反馈回显通道 (数字规范化)
  const slider = createNewWidget('slider', 0, 0);
  bindWidgetChannel(slider, '1');
  assert.equal(getWidgetBoundChannel(slider), '!1');
  assert.equal(slider.config.feedback_channel, '!1');

  // 旋钮反馈回显通道
  const knob = createNewWidget('knob', 0, 0);
  bindWidgetChannel(knob, '!2');
  assert.equal(getWidgetBoundChannel(knob), '!2');
  assert.equal(knob.config.feedback_channel, '!2');

  // 阶跃响应实际通道
  const stepCard = createNewWidget('step_card', 0, 0);
  bindWidgetChannel(stepCard, 'actual');
  assert.equal(getWidgetBoundChannel(stepCard), 'actual');
  assert.equal(stepCard.config.actual_channel, 'actual');

  // 5. 测试多通道控件波形图 (ChartWidget) 的多选复选框曲线增删与规范化排重
  console.log('  5. 测试多通道图表复选增删、显隐切换与槽位复用 (toggleChartSeriesChannel)');
  const chart = createNewWidget('chart', 0, 0);
  chart.config.series = []; // 清空初始曲线

  // 添加曲线 !0
  toggleChartSeriesChannel(chart, '!0', '#38BDF8');
  assert.equal(chart.config.series.length, 1);
  assert.equal(chart.config.series[0].channel, '!0');
  assert.equal(chart.config.series[0].visible, true);
  assert.deepEqual(isChannelInChartSeries(chart, '!0'), { exists: true, visible: true });
  // 用纯数字 '0' 查询也应自适应匹配
  assert.deepEqual(isChannelInChartSeries(chart, '0'), { exists: true, visible: true });

  // 再次传入纯数字 '0' 切换可见性 (显隐切换，不应追加重复曲线)
  toggleChartSeriesChannel(chart, '0');
  assert.equal(chart.config.series.length, 1);
  assert.equal(chart.config.series[0].visible, false);
  assert.deepEqual(isChannelInChartSeries(chart, '!0'), { exists: true, visible: false });

  // 追加曲线 !1
  toggleChartSeriesChannel(chart, '!1', '#4ADE80');
  assert.equal(chart.config.series.length, 2);
  assert.equal(chart.config.series[1].channel, '!1');
  assert.equal(chart.config.series[1].visible, true);

  // 检查右键菜单展示标签
  assert.equal(formatBindingDisplay(chart), '1 条曲线'); // 仅 1 条 visible === true

  toggleChartSeriesChannel(chart, '!0'); // 重新变为 visible
  assert.equal(formatBindingDisplay(chart), '2 条曲线');

  // 6. 测试波形图满 8 条曲线时的隐藏槽位复用与一键解绑
  console.log('  6. 测试波形图满 8 曲线槽位复用与 bindWidgetChannel(chart, null) 清空');
  for (let i = 2; i < 8; i++) {
    toggleChartSeriesChannel(chart, `!${i}`);
  }
  assert.equal(chart.config.series.length, 8);
  // 将 !1 设为隐藏
  toggleChartSeriesChannel(chart, '!1');
  assert.equal(isChannelInChartSeries(chart, '!1').visible, false);

  // 此时尝试添加第 9 个通道 !8，应自动复用已隐藏的槽位
  toggleChartSeriesChannel(chart, '!8');
  assert.equal(chart.config.series.length, 8);
  assert.equal(isChannelInChartSeries(chart, '!8').visible, true);
  assert.equal(isChannelInChartSeries(chart, '!1').exists, false);

  // 测试 bindWidgetChannel(chart, null) 一键清除全部波形曲线可见性
  bindWidgetChannel(chart, null);
  assert.equal(formatBindingDisplay(chart), '未添加曲线');
  for (const s of chart.config.series) {
    assert.equal(s.visible, false);
  }

  console.log('✓ [VOFA+ Channel Binding] 通道选择与级联绑定机制 6 项自动化测试 100% 全部通过！\n');
}
