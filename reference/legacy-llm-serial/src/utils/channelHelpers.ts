/**
 * VOFA+ 风格控件通道绑定与变量管理核心辅助函数
 */

import type { CanvasWidgetInstance, ChannelMeta } from '../types/widget';
import { DEFAULT_CHANNEL_PALETTE } from '../stores/widgetStore';

export interface ChannelSelectItem {
  id: string;               // 通道唯一标识 (如 "!0", "!4", "speed")
  name: string;             // 通道显示别名 (如 "速度反馈" 或 "!4")
  color: string;            // 通道曲线与标牌色彩
  latestValue?: number;     // 最新高精浮点读数
  formattedValue: string;   // 6 位高精浮点格式化文本 (如 "12.345678" 或 "--")
  isActive: boolean;        // 是否有真实数据流到达
}

/**
 * 格式化高精浮点数为 6 位小数
 */
export function formatChannelFloatValue(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val)) {
    return '--';
  }
  return Number(val).toFixed(6);
}

/**
 * 规范化通道 ID (将纯数字 0~7 规范化为 !0~!7，并清理首尾空格)
 */
export function normalizeChannelId(id: string | number | null | undefined): string {
  if (id === null || id === undefined || id === '') return '';
  const trimmed = String(id).trim();
  if (/^\d+$/.test(trimmed)) {
    return `!${trimmed}`;
  }
  return trimmed;
}

/**
 * 聚合所有可用通道 (预置 !0 ~ !7 + 动态数据流通道 + 工程注册通道 + 当前控件通道)
 */
export function getAvailableChannels(
  widgetStore: any,
  channelStore: any,
  currentChannel?: string | null
): ChannelSelectItem[] {
  const idsSet = new Set<string>();

  // 1. VOFA+ 默认常驻预置 !0 ~ !7
  for (let i = 0; i < 8; i++) {
    idsSet.add(`!${i}`);
  }

  // 2. 从 ChannelStore 获取动态数据流发现的所有通道
  const storeChannels: string[] =
    (typeof channelStore?.getAllChannels === 'function'
      ? channelStore.getAllChannels()
      : typeof channelStore?.listChannels === 'function'
      ? channelStore.listChannels()
      : []) || [];

  for (const ch of storeChannels) {
    if (ch) idsSet.add(normalizeChannelId(ch));
  }

  // 3. 从 widgetStore.channelMetaMap / channelMetas 获取已配置元数据的通道
  const metaMap =
    widgetStore?.channelMetaMap?.value ||
    widgetStore?.channelMetas?.value ||
    widgetStore?.channelMetaMap ||
    widgetStore?.channelMetas ||
    {};

  for (const ch of Object.keys(metaMap)) {
    if (ch) idsSet.add(normalizeChannelId(ch));
  }

  // 4. 确保当前绑定的通道不丢失
  if (currentChannel) {
    idsSet.add(normalizeChannelId(currentChannel));
  }

  // 5. 排序规则：!0 ~ !7 优先排在前面，其余 !N 递增，最后其他英文字符通道字母排序
  const sortedIds = Array.from(idsSet).sort((a, b) => {
    const isAPreset = /^![0-7]$/.test(a);
    const isBPreset = /^![0-7]$/.test(b);
    if (isAPreset && isBPreset) {
      return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
    }
    if (isAPreset) return -1;
    if (isBPreset) return 1;

    const isANum = /^!\d+$/.test(a);
    const isBNum = /^!\d+$/.test(b);
    if (isANum && isBNum) {
      return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
    }
    if (isANum) return -1;
    if (isBNum) return 1;

    return a.localeCompare(b);
  });

  // 6. 构造成员对象
  return sortedIds.map((id) => {
    const meta: ChannelMeta =
      typeof widgetStore?.getChannelMeta === 'function'
        ? widgetStore.getChannelMeta(id)
        : {
            id,
            name: id,
            color: '#DA7756',
            visible: true,
            scale: 1,
            yOffset: 0,
            xOffset: 0,
            decimal: 6,
          };

    // 读取最新点
    let pt = typeof channelStore?.latest === 'function' ? channelStore.latest(id) : undefined;
    if (!pt && meta.name && meta.name !== id) {
      pt = typeof channelStore?.latest === 'function' ? channelStore.latest(meta.name) : undefined;
    }

    const val = pt?.v;
    const isActive = val !== undefined && val !== null && !isNaN(val);

    return {
      id,
      name: meta.name || id,
      color: meta.color || '#DA7756',
      latestValue: val,
      formattedValue: formatChannelFloatValue(val),
      isActive,
    };
  });
}

/**
 * 获取任意控件当前绑定的通道标识 (单值控件或图表首曲线，统一规范化返回)
 */
export function getWidgetBoundChannel(widget: CanvasWidgetInstance | null | undefined): string | null {
  if (!widget || !widget.config) return null;
  const cfg = widget.config as any;

  let raw: any = null;
  switch (widget.type) {
    case 'gauge':
    case 'number':
    case 'led':
    case 'stat_card':
      raw = cfg.channel;
      break;
    case 'slider':
    case 'knob':
      raw = cfg.feedback_channel;
      break;
    case 'step_card':
      raw = cfg.actual_channel;
      break;
    case 'chart':
      raw = cfg.series?.[0]?.channel;
      break;
    default:
      return null;
  }

  if (raw === null || raw === undefined || raw === '') return null;
  const normalized = normalizeChannelId(raw);
  return normalized || null;
}

/**
 * 检查控件是否支持通道绑定
 */
export function isChannelBindableWidget(widget: CanvasWidgetInstance | null | undefined): boolean {
  if (!widget) return false;
  return [
    'gauge',
    'chart',
    'slider',
    'knob',
    'number',
    'led',
    'stat_card',
    'step_card',
  ].includes(widget.type);
}

/**
 * 将目标通道绑定到指定单值控件上 (或清除绑定)
 */
export function bindWidgetChannel(
  widget: CanvasWidgetInstance | null | undefined,
  channelId: string | null
): void {
  if (!widget || !widget.config) return;
  const cfg = widget.config as any;
  const normId = channelId ? normalizeChannelId(channelId) : null;

  switch (widget.type) {
    case 'gauge':
    case 'number':
    case 'led':
    case 'stat_card':
      cfg.channel = normId;
      break;
    case 'slider':
    case 'knob':
      cfg.feedback_channel = normId;
      break;
    case 'step_card':
      cfg.actual_channel = normId || '';
      break;
    case 'chart':
      if (!Array.isArray(cfg.series)) {
        cfg.series = [];
      }
      cfg.auto_bind = false;
      if (normId) {
        const existing = cfg.series.find((s: any) => normalizeChannelId(s.channel) === normId);
        if (existing) {
          existing.visible = true;
        } else {
          const nextColor = DEFAULT_CHANNEL_PALETTE[cfg.series.length % DEFAULT_CHANNEL_PALETTE.length] || '#DA7756';
          if (cfg.series.length < 8) {
            cfg.series.push({
              channel: normId,
              color: nextColor,
              visible: true,
            });
          } else {
            const invisibleIdx = cfg.series.findIndex((s: any) => s.visible === false);
            if (invisibleIdx !== -1) {
              cfg.series.splice(invisibleIdx, 1, {
                channel: normId,
                color: nextColor,
                visible: true,
              });
            }
          }
        }
      } else {
        // channelId 为 null 时，清除隐藏所有波形曲线
        cfg.series.forEach((s: any) => {
          s.visible = false;
        });
      }
      break;
  }
}

/**
 * 针对波形图 (ChartWidget) 增删或切换曲线显示
 */
export function toggleChartSeriesChannel(
  widget: CanvasWidgetInstance | null | undefined,
  channelId: string,
  color?: string
): void {
  if (!widget || widget.type !== 'chart' || !widget.config) return;
  const cfg = widget.config as any;
  cfg.auto_bind = false;
  if (!Array.isArray(cfg.series)) {
    cfg.series = [];
  }

  const normTarget = normalizeChannelId(channelId);
  const idx = cfg.series.findIndex((s: any) => normalizeChannelId(s.channel) === normTarget);
  if (idx !== -1) {
    // 若已存在，切换其可见性
    cfg.series[idx].visible = !cfg.series[idx].visible;
  } else {
    // 若不存在且未达 8 条上限，则直接追加
    const nextColor = color || DEFAULT_CHANNEL_PALETTE[cfg.series.length % DEFAULT_CHANNEL_PALETTE.length] || '#DA7756';
    if (cfg.series.length < 8) {
      cfg.series.push({
        channel: normTarget,
        color: nextColor,
        visible: true,
      });
    } else {
      // 若已满 8 条，复用隐藏曲线的槽位
      const invisibleIdx = cfg.series.findIndex((s: any) => s.visible === false);
      if (invisibleIdx !== -1) {
        cfg.series.splice(invisibleIdx, 1, {
          channel: normTarget,
          color: nextColor,
          visible: true,
        });
      }
    }
  }
}

/**
 * 查询通道在波形图中的激活与显示状态
 */
export function isChannelInChartSeries(
  widget: CanvasWidgetInstance | null | undefined,
  channelId: string
): { exists: boolean; visible: boolean } {
  if (!widget || widget.type !== 'chart' || !widget.config) {
    return { exists: false, visible: false };
  }
  const cfg = widget.config as any;
  if (!Array.isArray(cfg.series)) {
    return { exists: false, visible: false };
  }
  const targetNorm = normalizeChannelId(channelId);
  const found = cfg.series.find((s: any) => normalizeChannelId(s.channel) === targetNorm);
  if (!found) {
    return { exists: false, visible: false };
  }
  return { exists: true, visible: found.visible !== false };
}

/**
 * 获取右键菜单项展示标签 (如 "📈 绑定通道 -> !4 ▶")
 */
export function formatBindingDisplay(
  widget: CanvasWidgetInstance | null | undefined,
  widgetStore?: any
): string {
  if (!widget) return '未绑定';

  if (widget.type === 'chart') {
    const cfg = widget.config as any;
    const series = Array.isArray(cfg?.series) ? cfg.series : [];
    const activeCount = series.filter((s: any) => s.visible !== false).length;
    return activeCount > 0 ? `${activeCount} 条曲线` : '未添加曲线';
  }

  const bound = getWidgetBoundChannel(widget);
  if (!bound) return '未绑定';

  if (widgetStore && typeof widgetStore.getChannelMeta === 'function') {
    const meta = widgetStore.getChannelMeta(bound);
    if (meta && meta.name && meta.name !== bound) {
      return `${bound} (${meta.name})`;
    }
  }

  return bound;
}
