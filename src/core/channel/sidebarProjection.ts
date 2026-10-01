import type { CanvasWidgetInstance, ChannelMeta } from '../../types/widget';
import type { ChannelPoint } from './types';

/** Only explicit data bindings in the active canvas belong in the waiting list. */
export function widgetChannelBindings(widgets: readonly CanvasWidgetInstance[]): string[] {
  const result = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && value.trim()) result.add(value); };
  for (const widget of widgets) {
    switch (widget.type) {
      case 'chart':
        if (widget.config.auto_bind !== true && Array.isArray(widget.config.series)) {
          widget.config.series.forEach((series) => { if (series && typeof series === 'object') add(series.channel); });
        }
        break;
      case 'gauge': case 'number': case 'led': case 'stat_card': add(widget.config.channel); break;
      case 'slider': case 'knob': add(widget.config.feedback_channel); break;
      case 'step_card': add(widget.config.actual_channel); add(widget.config.target_channel); break;
    }
  }
  return [...result];
}

export interface SidebarChannelSource {
  listChannels(): string[];
  resolveChannelKey(id: string): string;
  latest(id: string): ChannelPoint | undefined;
}

export interface SidebarChannelRow {
  id: string;
  hasSamples: boolean;
  value: number | null;
}

/** Read-only projection: never allocate buffers, initialize metadata or save a workspace. */
export function projectSidebarChannels(source: SidebarChannelSource, bindings: readonly string[],
  metadata: Readonly<Record<string, ChannelMeta>> = {}): SidebarChannelRow[] {
  const received = new Map<string, SidebarChannelRow>();
  for (const allocated of source.listChannels()) {
    const id = source.resolveChannelKey(allocated);
    if (received.has(id)) continue;
    const point = source.latest(id);
    if (!point) continue;
    const meta = Object.prototype.hasOwnProperty.call(metadata, id) ? metadata[id] : undefined;
    const scale = meta?.scale === undefined ? 1 : meta.scale;
    const offset = meta?.yOffset === undefined ? 0 : meta.yOffset;
    const value = typeof scale === 'number' && Number.isFinite(scale) && typeof offset === 'number' && Number.isFinite(offset)
      ? point.v * scale + offset : NaN;
    received.set(id, { id, hasSamples: true, value: Number.isFinite(value) ? value : null });
  }
  const waiting = new Set(bindings.map((binding) => source.resolveChannelKey(binding)));
  return [...received.values(), ...[...waiting].filter((id) => !received.has(id)).map((id) => ({ id, hasSamples: false, value: null }))];
}

export function formatSidebarValue(value: number | null | undefined, decimal = 6): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const precision = Number.isInteger(decimal) ? Math.min(6, Math.max(0, decimal)) : 6;
  return value.toFixed(precision);
}

export function sidebarSampleStatus(row: SidebarChannelRow, isRunning: boolean): string {
  if (!row.hasSamples) return '等待数据';
  if (row.value === null) return '无有效显示值';
  return isRunning ? '缓冲读数' : '已停止 · 缓存读数';
}
