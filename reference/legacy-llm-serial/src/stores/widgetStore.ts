import { ref, computed } from 'vue';
import type {
  VofaDashboardState,
  CanvasTab,
  CanvasWidgetInstance,
  WidgetType,
  GridSize,
  ChannelMeta,
} from '../types/widget';
import { snap, normalizeSize, clampToCanvas } from '../utils/grid';
import { globalSendGate } from '../core/widget/sendGate';
import { globalWidgetRegistry } from '../core/widget/registry';
import { createDefaultVofaPreset, validateAndMigrateDashboard } from '../core/widget/schema';
import { globalRenderScheduler } from '../core/widget/renderScheduler';
import { normalizeChannelUnitMetadata } from '../core/channel/channelPresentation';

export { createDefaultVofaPreset } from '../core/widget/schema';

export const DEFAULT_CHANNEL_PALETTE = [
  '#DA7756', // Claude 陶土红 (Terracotta)
  '#7AA89B', // 自然鼠尾草绿 (Sage Green)
  '#759CB5', // 石板灰蓝 (Slate Blue)
  '#E59E38', // 温暖琥珀 (Warm Amber)
  '#9D6CF0', // 静谧紫罗兰 (Quiet Violet)
  '#E06D85', // 柔和洋红 (Soft Magenta)
  '#5EA880', // 薄荷碧绿 (Mint Green)
  '#4F85A6', // 海青色 (Ocean Cyan)
  '#C8875A', // 烤赤陶 (Roasted Sienna)
  '#8E9A74', // 橄榄青 (Muted Olive)
  '#6882A3', // 灰青蓝 (Steel Blue)
  '#B87383', // 烟熏粉 (Dusty Rose)
];

const STORAGE_KEY_V2 = 'llm-serial.vofa-dashboard.v2';
const STORAGE_KEY_V1 = 'llm-serial.widgets.v1';

import { globalChannelStore, type ChannelAliasConflict } from '../core/channel/ChannelStore';
const DASHBOARD_ALIAS_OWNER = Symbol('widget-dashboard-aliases');
const channelAliasConflicts = ref<ChannelAliasConflict[]>([]);

export interface PointerDragState {
  active: boolean;
  widgetType: WidgetType | null;
  pointerX: number;
  pointerY: number;
  previewW: number;
  previewH: number;
  icon: string;
  name: string;
}

// 核心全局响应式状态
const dashboardState = ref<VofaDashboardState>(createDefaultVofaPreset());

/** Migrate only explicit data fields whose current owner mapping is confirmed. */
function canonicalizeOwnedWidgetBindings() {
  const canonical = (value: unknown) => {
    if (typeof value !== 'string') return value;
    const target = globalChannelStore.getOwnedAliasTarget(DASHBOARD_ALIAS_OWNER, value);
    return target && globalChannelStore.resolveChannelKey(value) === target ? target : value;
  };
  for (const tab of dashboardState.value.tabs) {
    for (const widget of tab.widgets) {
      const config = widget.config as unknown as Record<string, unknown>;
      if (widget.type === 'chart' && Array.isArray(config.series)) {
        for (const series of config.series) if (series && typeof series === 'object') series.channel = canonical(series.channel);
      }
      const fields = widget.type === 'chart' || widget.type === 'step_card' ? ['actual_channel', 'target_channel']
        : ['gauge', 'number', 'led', 'stat_card'].includes(widget.type) ? ['channel']
        : widget.type === 'slider' || widget.type === 'knob' ? ['feedback_channel'] : [];
      for (const field of fields) if (Object.prototype.hasOwnProperty.call(config, field)) config[field] = canonical(config[field]);
    }
  }
}

function restoreDashboardAliases() {
  const declarations = Object.entries(dashboardState.value.channels ?? {}).map(([targetId, meta]) => {
    // The map key is the persisted canonical identity used by all channel lookups.
    if (meta.id !== targetId) meta.id = targetId;
    return { targetId, alias: typeof meta?.name === 'string' ? meta.name : targetId };
  });
  const result = globalChannelStore.replaceOwnedAliases(DASHBOARD_ALIAS_OWNER, declarations);
  channelAliasConflicts.value = result.conflicts;
  canonicalizeOwnedWidgetBindings();
}
const selectedWidgetId = ref<string | null>(null);
const draggingWidgetType = ref<WidgetType | null>(null);
const draggingChannelId = ref<string | null>(null);

// 全局 1:1 指针拖拽通道状态
const pointerDragState = ref<PointerDragState>({
  active: false,
  widgetType: null,
  pointerX: 0,
  pointerY: 0,
  previewW: 240,
  previewH: 240,
  icon: '',
  name: '',
});

let canvasDropHandler: ((type: WidgetType, clientX: number, clientY: number) => boolean) | null = null;

// 历史回溯 Scrubber 与全局自适应缩放状态
const scrubState = ref<{
  isScrubbing: boolean;
  ratio: number;
}>({
  isScrubbing: false,
  ratio: 1.0,
});
const autoScaleTrigger = ref(0);

let saveTimer: number | null = null;

/**
 * 500ms 防抖保存到 localStorage
 */
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      dashboardState.value.updated_at = Date.now();
      const serialized = JSON.stringify(dashboardState.value);
      localStorage.setItem(STORAGE_KEY_V2, serialized);
    } catch (err) {
      console.warn('保存控件配置失败 (可能超出本地存储限制):', err);
    }
  }, 500);
}

/**
 * 从本地存储加载配置
 */
export function loadDashboard(): VofaDashboardState {
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const parsed = JSON.parse(rawV2);
      const res = validateAndMigrateDashboard(parsed);
      if (res.ok && res.data) {
        dashboardState.value = res.data;
        restoreDashboardAliases();
        globalRenderScheduler.setActiveTab(dashboardState.value.active_tab_id);
        return dashboardState.value;
      }
    }

    // 检查是否有 v1 遗留数据，若有尝试升级迁移
    const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      console.info('检测到 v1 旧控件配置，正在平滑迁移至 v2 多工作台架构...');
      const parsedV1 = JSON.parse(rawV1);
      const res = validateAndMigrateDashboard(parsedV1);
      if (res.ok && res.data) {
        dashboardState.value = res.data;
        restoreDashboardAliases();
        debouncedSave();
        globalRenderScheduler.setActiveTab(dashboardState.value.active_tab_id);
        return dashboardState.value;
      }
    }

    // 无历史数据，使用官方两大预设模板
    dashboardState.value = createDefaultVofaPreset();
    debouncedSave();
  } catch (err) {
    console.warn('读取本地控件配置失败，恢复官方默认预设:', err);
    dashboardState.value = createDefaultVofaPreset();
  }

  restoreDashboardAliases();
  globalRenderScheduler.setActiveTab(dashboardState.value.active_tab_id);
  return dashboardState.value;
}

/**
 * 创建新控件工厂方法 (委托给 WidgetRegistry)
 */
export function createNewWidget(
  type: WidgetType,
  x: number,
  y: number,
  title?: string,
  customConfig?: any
): CanvasWidgetInstance {
  const gridSize = dashboardState.value.grid_size;
  const snappedX = snap(x, gridSize);
  const snappedY = snap(y, gridSize);

  const instance = globalWidgetRegistry.createInstance(type, snappedX, snappedY, title, customConfig);
  instance.z = getNextZIndex();
  return instance;
}

function getNextZIndex(): number {
  const tab = currentTab();
  if (!tab || tab.widgets.length === 0) return 1;
  const maxZ = Math.max(...tab.widgets.map((w) => w.z || 1));
  return maxZ + 1;
}

function currentTab(): CanvasTab | undefined {
  return (
    dashboardState.value.tabs.find((t) => t.id === dashboardState.value.active_tab_id) ||
    dashboardState.value.tabs[0]
  );
}

export function useWidgetStore() {
  const activeTab = computed(() => currentTab());

  const activeWidgets = computed(() => {
    return activeTab.value ? activeTab.value.widgets : [];
  });

  const isLocked = computed({
    get: () => dashboardState.value.locked,
    set: (val: boolean) => {
      dashboardState.value.locked = val;
      debouncedSave();
    },
  });

  const gridSize = computed({
    get: () => dashboardState.value.grid_size,
    set: (val: GridSize) => {
      dashboardState.value.grid_size = val;
      debouncedSave();
    },
  });

  // Tab 管理
  function addTab(name?: string, template?: CanvasWidgetInstance[]): CanvasTab {
    const count = dashboardState.value.tabs.length + 1;
    const newTab: CanvasTab = {
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name || `工作台 ${count}`,
      canvas_w: 2400,
      canvas_h: 1600,
      widgets: template ? JSON.parse(JSON.stringify(template)) : [],
    };
    dashboardState.value.tabs.push(newTab);
    switchTab(newTab.id);
    debouncedSave();
    return newTab;
  }

  function removeTab(tabId: string): boolean {
    if (dashboardState.value.tabs.length <= 1) {
      return false; // 禁止关闭最后一个 Tab
    }
    const idx = dashboardState.value.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return false;

    dashboardState.value.tabs.splice(idx, 1);
    // 若关闭的是当前激活 Tab，切换到相邻 Tab
    if (dashboardState.value.active_tab_id === tabId) {
      const nextTab = dashboardState.value.tabs[Math.max(0, idx - 1)];
      switchTab(nextTab.id);
    }
    debouncedSave();
    return true;
  }

  function renameTab(tabId: string, newName: string) {
    const tab = dashboardState.value.tabs.find((t) => t.id === tabId);
    if (tab && newName.trim()) {
      tab.name = newName.trim();
      debouncedSave();
    }
  }

  function switchTab(tabId: string) {
    const tab = dashboardState.value.tabs.find((t) => t.id === tabId);
    if (tab) {
      dashboardState.value.active_tab_id = tab.id;
      selectedWidgetId.value = null;
      globalRenderScheduler.setActiveTab(tab.id);
      debouncedSave();
    }
  }

  function duplicateTab(tabId: string): CanvasTab | null {
    const target = dashboardState.value.tabs.find((t) => t.id === tabId);
    if (!target) return null;

    const duplicated: CanvasTab = {
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: `${target.name} (副本)`,
      canvas_w: target.canvas_w,
      canvas_h: target.canvas_h,
      widgets: JSON.parse(JSON.stringify(target.widgets)).map((w: any) => ({
        ...w,
        id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      })),
    };
    dashboardState.value.tabs.push(duplicated);
    switchTab(duplicated.id);
    debouncedSave();
    return duplicated;
  }

  // 控件 CRUD
  function addWidget(widget: CanvasWidgetInstance) {
    const tab = currentTab();
    if (!tab) return;
    tab.widgets.push(widget);
    selectedWidgetId.value = widget.id;
    expandCanvasIfNeeded(widget.x + widget.w, widget.y + widget.h);
    debouncedSave();
  }

  function updateWidget(widget: CanvasWidgetInstance) {
    const tab = currentTab();
    if (!tab) return;
    const idx = tab.widgets.findIndex((w) => w.id === widget.id);
    if (idx !== -1) {
      const clonedConfig = Array.isArray((widget.config as any)?.series)
        ? { ...(widget.config as any), series: [...(widget.config as any).series] }
        : { ...(widget.config as any) };
      tab.widgets[idx] = {
        ...widget,
        config: clonedConfig as any,
      };
      debouncedSave();
    }
  }

  function updateWidgetPosition(id: string, x: number, y: number) {
    const tab = currentTab();
    if (!tab) return;
    const target = tab.widgets.find((w) => w.id === id);
    if (target) {
      const snapped = snap(x, dashboardState.value.grid_size);
      const clamped = clampToCanvas(
        snapped,
        snap(y, dashboardState.value.grid_size),
        target.w,
        target.h,
        tab.canvas_w,
        tab.canvas_h
      );
      target.x = clamped.x;
      target.y = clamped.y;
      expandCanvasIfNeeded(target.x + target.w, target.y + target.h);
      debouncedSave();
    }
  }

  function updateWidgetSize(id: string, w: number, h: number) {
    const tab = currentTab();
    if (!tab) return;
    const target = tab.widgets.find((w) => w.id === id);
    if (target) {
      const def = globalWidgetRegistry.get(target.type);
      const minW = def ? def.defaultSize.min_w : 100;
      const minH = def ? def.defaultSize.min_h : 60;
      const norm = normalizeSize(w, h, minW, minH, dashboardState.value.grid_size);
      target.w = norm.w;
      target.h = norm.h;
      expandCanvasIfNeeded(target.x + target.w, target.y + target.h);
      debouncedSave();
    }
  }

  function updateWidgetGeometry(id: string, x: number, y: number, w: number, h: number) {
    const tab = currentTab();
    if (!tab) return;
    const target = tab.widgets.find((w) => w.id === id);
    if (target) {
      const def = globalWidgetRegistry.get(target.type);
      const minW = def ? def.defaultSize.min_w : 100;
      const minH = def ? def.defaultSize.min_h : 60;
      const norm = normalizeSize(w, h, minW, minH, dashboardState.value.grid_size);
      const snappedX = snap(x, dashboardState.value.grid_size);
      const snappedY = snap(y, dashboardState.value.grid_size);
      const clamped = clampToCanvas(
        snappedX,
        snappedY,
        norm.w,
        norm.h,
        tab.canvas_w,
        tab.canvas_h
      );
      target.x = clamped.x;
      target.y = clamped.y;
      target.w = norm.w;
      target.h = norm.h;
      expandCanvasIfNeeded(target.x + target.w, target.y + target.h);
      debouncedSave();
    }
  }

  function bringToFront(id: string) {
    const tab = currentTab();
    if (!tab) return;
    const target = tab.widgets.find((w) => w.id === id);
    if (target) {
      const maxZ = Math.max(...tab.widgets.map((w) => w.z || 1));
      target.z = maxZ + 1;
      selectedWidgetId.value = id;
      debouncedSave();
    }
  }

  function sendToBack(id: string) {
    const tab = currentTab();
    if (!tab) return;
    const target = tab.widgets.find((w) => w.id === id);
    if (target) {
      for (const w of tab.widgets) {
        if (w.id !== id) {
          w.z = (w.z || 1) + 1;
        }
      }
      target.z = 1;
      selectedWidgetId.value = id;
      debouncedSave();
    }
  }

  function deleteWidget(id: string) {
    const tab = currentTab();
    if (!tab) return;
    const idx = tab.widgets.findIndex((w) => w.id === id);
    if (idx !== -1) {
      tab.widgets.splice(idx, 1);
      if (selectedWidgetId.value === id) {
        selectedWidgetId.value = null;
      }
      debouncedSave();
    }
  }

  function duplicateWidget(id: string) {
    const tab = currentTab();
    if (!tab) return;
    const target = tab.widgets.find((w) => w.id === id);
    if (!target) return;

    const offset = dashboardState.value.grid_size;
    const newWidget: CanvasWidgetInstance = JSON.parse(JSON.stringify(target));
    newWidget.id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    newWidget.x += offset;
    newWidget.y += offset;
    newWidget.z = getNextZIndex();

    tab.widgets.push(newWidget);
    selectedWidgetId.value = newWidget.id;
    expandCanvasIfNeeded(newWidget.x + newWidget.w, newWidget.y + newWidget.h);
    debouncedSave();
  }

  function expandCanvasIfNeeded(maxX: number, maxY: number) {
    const tab = currentTab();
    if (!tab) return;
    let changed = false;
    if (tab.canvas_w - maxX < 200) {
      tab.canvas_w = Math.max(tab.canvas_w, maxX + 400);
      changed = true;
    }
    if (tab.canvas_h - maxY < 200) {
      tab.canvas_h = Math.max(tab.canvas_h, maxY + 400);
      changed = true;
    }
    if (changed) {
      debouncedSave();
    }
  }

  function resetToDefault() {
    dashboardState.value = createDefaultVofaPreset();
    restoreDashboardAliases();
    selectedWidgetId.value = null;
    globalRenderScheduler.setActiveTab(dashboardState.value.active_tab_id);
    debouncedSave();
  }

  /**
   * 导出工作台整体配置为 JSON 字符串
   */
  function exportDashboardJson(): string {
    return JSON.stringify(dashboardState.value, null, 2);
  }

  /**
   * 从外部导入 JSON 配置
   */
  function importDashboardJson(jsonStr: string): { ok: boolean; error?: string } {
    try {
      const parsed = JSON.parse(jsonStr);
      const res = validateAndMigrateDashboard(parsed);
      if (!res.ok || !res.data) {
        return { ok: false, error: res.error || '导入配置解析失败' };
      }
      dashboardState.value = res.data;
      restoreDashboardAliases();
      selectedWidgetId.value = null;
      globalRenderScheduler.setActiveTab(dashboardState.value.active_tab_id);
      debouncedSave();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: `JSON 语法错误: ${e?.message || e}` };
    }
  }

  // 通道元数据管理
  const channelMetaMap = computed(() => {
    if (!dashboardState.value.channels) {
      dashboardState.value.channels = {};
    }
    return dashboardState.value.channels;
  });

  function getChannelMeta(id: string): ChannelMeta {
    const existing = ownChannelMeta(id);
    if (!existing) {
      const channels = { ...(dashboardState.value.channels ?? {}) };
      const idx = Object.keys(channels).length;
      const defaultColor = DEFAULT_CHANNEL_PALETTE[idx % DEFAULT_CHANNEL_PALETTE.length];
      const displayName = id.startsWith('!') || isNaN(Number(id)) ? id : `!${id}`;
      const meta: ChannelMeta = {
        id,
        name: displayName,
        color: defaultColor,
        visible: true,
        scale: 1.0,
        yOffset: 0.0,
        xOffset: 0.0,
        decimal: 6,
      };
      Object.defineProperty(channels, id, { value: meta, enumerable: true, configurable: true, writable: true });
      // Replacement also notifies Vue when the new key is a prototype-like name.
      dashboardState.value.channels = channels;
      restoreDashboardAliases();
      debouncedSave();
    }
    return ownChannelMeta(id)!;
  }

  function ownChannelMeta(id: string): ChannelMeta | undefined {
    const channels = dashboardState.value.channels;
    return channels && Object.prototype.hasOwnProperty.call(channels, id) ? channels[id] : undefined;
  }

  function updateChannelMeta(id: string, partial: Partial<ChannelMeta>) {
    if (partial.id !== undefined && partial.id !== id) throw new Error('通道元数据不能改变真实通道 ID。');
    // Invalid edits must not initialize a channel or schedule persistence.
    const current = ownChannelMeta(id);
    const unitMetadata = normalizeChannelUnitMetadata({ ...current, ...partial });
    const meta = getChannelMeta(id);
    if (partial.name !== undefined) canonicalizeOwnedWidgetBindings();
    Object.assign(meta, partial);
    delete meta.unit;
    delete meta.unitSource;
    Object.assign(meta, unitMetadata);
    if (partial.name !== undefined) restoreDashboardAliases();
    debouncedSave();
  }

  function toggleChannelVisibility(id?: string) {
    if (!dashboardState.value.channels) return;
    if (id) {
      const meta = getChannelMeta(id);
      meta.visible = !meta.visible;
    } else {
      const list = Object.values(dashboardState.value.channels);
      const anyVisible = list.some((c) => c.visible);
      for (const c of list) {
        c.visible = !anyVisible;
      }
    }
    debouncedSave();
  }

  function renameChannel(id: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const meta = getChannelMeta(id);
    canonicalizeOwnedWidgetBindings();
    meta.name = trimmed;
    restoreDashboardAliases();
    debouncedSave();
  }

  function setScrubState(isScrubbing: boolean, ratio: number) {
    scrubState.value.isScrubbing = isScrubbing;
    scrubState.value.ratio = Math.max(0, Math.min(1, ratio));
  }

  function triggerAutoScale() {
    autoScaleTrigger.value++;
  }

  function startPointerDrag(params: {
    widgetType: WidgetType;
    pointerX: number;
    pointerY: number;
    previewW: number;
    previewH: number;
    icon: string;
    name: string;
  }) {
    pointerDragState.value = {
      active: true,
      widgetType: params.widgetType,
      pointerX: params.pointerX,
      pointerY: params.pointerY,
      previewW: params.previewW,
      previewH: params.previewH,
      icon: params.icon,
      name: params.name,
    };
    draggingWidgetType.value = params.widgetType;
  }

  function updatePointerDrag(x: number, y: number) {
    if (!pointerDragState.value.active) return;
    pointerDragState.value.pointerX = x;
    pointerDragState.value.pointerY = y;
  }

  function endPointerDrag(clientX?: number, clientY?: number) {
    if (!pointerDragState.value.active) return;
    const type = pointerDragState.value.widgetType;
    if (type && clientX !== undefined && clientY !== undefined && canvasDropHandler) {
      canvasDropHandler(type, clientX, clientY);
    }
    pointerDragState.value = {
      active: false,
      widgetType: null,
      pointerX: 0,
      pointerY: 0,
      previewW: 240,
      previewH: 240,
      icon: '',
      name: '',
    };
    draggingWidgetType.value = null;
  }

  function cancelPointerDrag() {
    pointerDragState.value = {
      active: false,
      widgetType: null,
      pointerX: 0,
      pointerY: 0,
      previewW: 240,
      previewH: 240,
      icon: '',
      name: '',
    };
    draggingWidgetType.value = null;
  }

  function registerDropTarget(handler: ((type: WidgetType, clientX: number, clientY: number) => boolean) | null) {
    canvasDropHandler = handler;
  }

  return {
    dashboardState,
    activeTab,
    activeWidgets,
    isLocked,
    gridSize,
    selectedWidgetId,
    draggingWidgetType,
    setDraggingWidgetType: (type: WidgetType | null) => {
      draggingWidgetType.value = type;
    },
    draggingChannelId,
    setDraggingChannelId: (id: string | null) => {
      draggingChannelId.value = id;
    },
    pointerDragState,
    startPointerDrag,
    updatePointerDrag,
    endPointerDrag,
    cancelPointerDrag,
    registerDropTarget,
    channelMetaMap,
    channelAliasConflicts: computed(() => channelAliasConflicts.value),
    channelMetas: channelMetaMap,
    channelMetaList: computed(() => Object.values(channelMetaMap.value)),
    getChannelMeta,
    updateChannelMeta,
    toggleChannelVisibility,
    renameChannel,
    scrubState,
    setScrubState,
    autoScaleTrigger,
    triggerAutoScale,
    loadDashboard,
    addTab,
    removeTab,
    renameTab,
    switchTab,
    duplicateTab,
    addWidget,
    updateWidget,
    updateWidgetPosition,
    updateWidgetSize,
    updateWidgetGeometry,
    bringToFront,
    sendToBack,
    deleteWidget,
    duplicateWidget,
    expandCanvasIfNeeded,
    resetToDefault,
    exportDashboardJson,
    importDashboardJson,
    sendGate: globalSendGate,
  };
}
