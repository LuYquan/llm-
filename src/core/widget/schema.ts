import {
  WIDGET_SCHEMA_VERSION,
  type VofaDashboardState,
  type CanvasTab,
  type CanvasWidgetInstance,
  type WidgetDashboardState,
  type WidgetItem,
  type SliderWidgetConfig,
  type ButtonWidgetConfig,
  type NumberInputWidgetConfig,
  type ChannelMeta,
} from '../../types/widget';
import { validateTemplate } from './templateEngine';
import { globalWidgetRegistry } from './registry';
import { normalizeChannelUnitMetadata } from '../channel/channelPresentation';

/**
 * 校验单项控件配置合法性
 */
export function validateWidgetConfig(item: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!item || typeof item !== 'object') {
    return { valid: false, errors: ['控件配置必须为有效对象'] };
  }

  if (!item.id || typeof item.id !== 'string') {
    errors.push('控件 ID 缺失或格式错误');
  }

  if (!item.title || typeof item.title !== 'string' || item.title.trim() === '') {
    errors.push('控件标题不能为空');
  }

  const validTypes = [
    'chart',
    'gauge',
    'number',
    'led',
    'slider',
    'button',
    'knob',
    'stat_card',
    'step_card',
    'bode',
    // 兼容历史老类型
    'number-input',
    'toggle',
    'select',
  ];
  if (!validTypes.includes(item.type)) {
    errors.push(`不支持的控件类型: ${item.type}`);
  }

  // 针对控制类控件校验指令模板
  if (item.type === 'slider' || item.type === 'button' || item.type === 'knob' || item.type === 'number-input') {
    const encoding = item.encoding === 'hex' ? 'hex' : 'text';
    const requireVal = item.type === 'slider' || item.type === 'knob' || item.type === 'number-input';
    const tplCheck = validateTemplate(item.command_template || item.config?.command_template || '', encoding, requireVal);
    if (!tplCheck.valid) {
      errors.push(tplCheck.error || '指令模板校验失败');
    }
  }

  // 针对数值范围类控件
  if (item.type === 'slider' || item.type === 'knob' || item.type === 'number-input') {
    const src = item.config || item;
    if (typeof src.min === 'number' && typeof src.max === 'number') {
      if (src.min >= src.max) {
        errors.push(`最小值 (${src.min}) 必须严格小于最大值 (${src.max})`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 官方预置两大开箱即用模板 Tab：
 * Tab 1「实时波形监控」= 全屏 ChartWidget
 * Tab 2「控制联调台」= ChartWidget + Slider + Gauge + StepResponseCard
 */
export function createDefaultVofaPreset(): VofaDashboardState {
  return { version: 2, active_tab_id: 'tab_waveform', grid_size: 20, locked: true, updated_at: Date.now(),
    tabs: [{ id: 'tab_waveform', name: '波形', canvas_w: 2400, canvas_h: 1600, widgets: [{
      id: 'w_chart_full', type: 'chart', title: '实时波形', x: 20, y: 20, w: 960, h: 560, z: 1,
      config: { series: [], auto_bind: true, time_window: 10, y_mode: 'auto', y_min: -10, y_max: 10, show_cursor: true, show_stats: true },
    }] }],
  };
}

/** Optional control laboratory template; it never activates device commands. */
export function createControlLabPreset(): VofaDashboardState {
  const tabWaveform: CanvasTab = {
    id: 'tab_waveform',
    name: '实时波形',
    canvas_w: 2400,
    canvas_h: 1600,
    widgets: [
      {
        id: 'w_chart_full',
        type: 'chart',
        title: '实时多通道波形监控',
        x: 20,
        y: 20,
        w: 960,
        h: 560,
        z: 1,
        config: {
          series: [
            { channel: 'setpoint', color: '#DA7756', visible: true },
            { channel: 'actual', color: '#7AA89B', visible: true },
            { channel: 'output', color: '#759CB5', visible: true },
          ],
          time_window: 10,
          y_mode: 'auto',
          y_min: -10,
          y_max: 10,
          show_cursor: true,
          show_stats: true,
          target_channel: 'setpoint',
          actual_channel: 'actual',
        },
      },
    ],
  };

  const tabControl: CanvasTab = {
    id: 'tab_control',
    name: '控制联调台',
    canvas_w: 2400,
    canvas_h: 1600,
    widgets: [
      {
        id: 'w_ctrl_chart',
        type: 'chart',
        title: '控制响应实时曲线',
        x: 280,
        y: 20,
        w: 680,
        h: 420,
        z: 1,
        config: {
          series: [
            { channel: 'setpoint', color: '#DA7756', visible: true },
            { channel: 'actual', color: '#7AA89B', visible: true },
          ],
          time_window: 10,
          y_mode: 'auto',
          y_min: -10,
          y_max: 10,
          show_cursor: true,
          show_stats: true,
          target_channel: 'setpoint',
          actual_channel: 'actual',
        },
      },
      {
        id: 'w_ctrl_gauge',
        type: 'gauge',
        title: '电机实时转速',
        x: 20,
        y: 20,
        w: 240,
        h: 240,
        z: 2,
        config: {
          channel: 'actual',
          min: -1000,
          max: 1000,
          unit: 'rpm',
          precision: 1,
          redline_ratio: 0.85,
        },
      },
      {
        id: 'w_ctrl_step',
        type: 'step_card',
        title: '阶跃响应动态指标',
        x: 20,
        y: 280,
        w: 240,
        h: 280,
        z: 3,
        config: {
          actual_channel: 'actual',
          target_channel: 'setpoint',
          time_window: 10,
          band_percent: 0.02,
          auto_refresh: true,
        },
      },
      {
        id: 'w_ctrl_slider_kp',
        type: 'slider',
        title: 'Kp 比例增益调节',
        x: 280,
        y: 460,
        w: 220,
        h: 100,
        z: 4,
        config: {
          command_template: '',
          encoding: 'text',
          enabled: false,
          min: 0,
          max: 50,
          step: 0.1,
          precision: 2,
          unit: '',
          default_value: 12.5,
          send_mode: 'change',
          throttle_ms: 50,
        },
      },
      {
        id: 'w_ctrl_slider_ki',
        type: 'slider',
        title: 'Ki 积分增益调节',
        x: 510,
        y: 460,
        w: 220,
        h: 100,
        z: 5,
        config: {
          command_template: '',
          encoding: 'text',
          enabled: false,
          min: 0,
          max: 20,
          step: 0.05,
          precision: 2,
          unit: '',
          default_value: 1.2,
          send_mode: 'change',
          throttle_ms: 50,
        },
      },
      {
        id: 'w_ctrl_slider_kd',
        type: 'slider',
        title: 'Kd 微分增益调节',
        x: 740,
        y: 460,
        w: 220,
        h: 100,
        z: 6,
        config: {
          command_template: '',
          encoding: 'text',
          enabled: false,
          min: 0,
          max: 10,
          step: 0.01,
          precision: 2,
          unit: '',
          default_value: 0.05,
          send_mode: 'change',
          throttle_ms: 50,
        },
      },
    ],
  };

  return {
    version: 2,
    active_tab_id: 'tab_waveform',
    grid_size: 20,
    locked: true,
    tabs: [tabWaveform, tabControl],
    updated_at: Date.now(),
  };
}

/**
 * 校验并规整导入的外部 VofaDashboardState JSON
 */
export function validateAndMigrateDashboard(raw: any): { ok: boolean; data?: VofaDashboardState; error?: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '导入数据必须为有效 JSON 对象' };
  }

  // 1. 若为标准 V2 结构
  if (raw.version === 2 && Array.isArray(raw.tabs) && raw.tabs.length > 0) {
    const channels: Record<string, ChannelMeta> = {};
    if (raw.channels !== undefined) {
      if (!raw.channels || typeof raw.channels !== 'object' || Array.isArray(raw.channels)) {
        return { ok: false, error: '通道元数据必须为对象。' };
      }
      for (const [id, value] of Object.entries(raw.channels)) {
        try {
          const unitMetadata = normalizeChannelUnitMetadata(value);
          const meta = { ...(value as ChannelMeta) };
          delete meta.unit;
          delete meta.unitSource;
          Object.assign(meta, unitMetadata);
          Object.defineProperty(channels, id, { value: meta, enumerable: true, configurable: true, writable: true });
        } catch (error) {
          return { ok: false, error: `通道 ${id} 的原始单位无效：${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }
    const validTabs: CanvasTab[] = [];
    for (const tab of raw.tabs) {
      if (!tab || typeof tab !== 'object') continue;
      const widgets: CanvasWidgetInstance[] = [];
      if (Array.isArray(tab.widgets)) {
        for (const w of tab.widgets) {
          if (!w || !w.type) continue;
          if (globalWidgetRegistry.has(w.type)) {
            const def = globalWidgetRegistry.get(w.type)!;
            const incomingConfig = w.config && typeof w.config === 'object' ? w.config : {};
            const mergedConfig: any = {
              ...def.createDefaultConfig(),
              ...incomingConfig,
            };
            // V2 files created before the explicit enable flag should keep
            // their authored command active. New unbound controls remain off.
            if (['button', 'slider', 'knob'].includes(w.type) && typeof incomingConfig.enabled !== 'boolean') {
              mergedConfig.enabled = Boolean(
                mergedConfig.command_template?.trim()
                  || mergedConfig.press_command?.trim()
              );
            }
            const sanitized: CanvasWidgetInstance = {
              id: w.id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: w.type,
              title: w.title || def.name,
              x: typeof w.x === 'number' && !isNaN(w.x) ? Math.max(0, w.x) : 20,
              y: typeof w.y === 'number' && !isNaN(w.y) ? Math.max(0, w.y) : 20,
              w: typeof w.w === 'number' && !isNaN(w.w) ? Math.max(def.defaultSize.min_w, w.w) : def.defaultSize.w,
              h: typeof w.h === 'number' && !isNaN(w.h) ? Math.max(def.defaultSize.min_h, w.h) : def.defaultSize.h,
              z: typeof w.z === 'number' && !isNaN(w.z) ? w.z : 1,
              config: mergedConfig,
            } as CanvasWidgetInstance;
            widgets.push(sanitized);
          }
        }
      }
      validTabs.push({
        id: tab.id || `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: tab.name || '工作台',
        canvas_w: Math.max(1200, tab.canvas_w || 2400),
        canvas_h: Math.max(800, tab.canvas_h || 1600),
        widgets,
      });
    }

    if (validTabs.length > 0) {
      const activeTabId = validTabs.some((t) => t.id === raw.active_tab_id)
        ? raw.active_tab_id
        : validTabs[0].id;
      return {
        ok: true,
        data: {
          version: 2,
          active_tab_id: activeTabId,
          grid_size: [10, 20, 40].includes(raw.grid_size) ? raw.grid_size : 20,
          locked: Boolean(raw.locked),
          tabs: validTabs,
          channels,
          updated_at: Date.now(),
        },
      };
    }
  }

  // 2. 若为 V1 扁平列表结构
  if (Array.isArray(raw.widgets) && raw.widgets.length > 0) {
    const tab: CanvasTab = {
      id: 'tab_imported',
      name: raw.name || '导入工作台',
      canvas_w: 2400,
      canvas_h: 1600,
      widgets: [],
    };
    let curY = 40;
    for (const w of raw.widgets) {
      const type = globalWidgetRegistry.has(w.type) ? w.type : 'button';
      const def = globalWidgetRegistry.get(type)!;
      const incomingConfig = w.config && typeof w.config === 'object' ? w.config : w;
      const mergedConfig: any = {
        ...def.createDefaultConfig(),
        ...incomingConfig,
      };
      if (['button', 'slider', 'knob'].includes(type) && typeof incomingConfig.enabled !== 'boolean') {
        mergedConfig.enabled = Boolean(
          mergedConfig.command_template?.trim()
            || mergedConfig.press_command?.trim()
        );
      }
      tab.widgets.push({
        id: w.id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type,
        title: w.title || def.name,
        x: typeof w.x === 'number' ? w.x : 40,
        y: typeof w.y === 'number' ? w.y : curY,
        w: typeof w.w === 'number' ? w.w : def.defaultSize.w,
        h: typeof w.h === 'number' ? w.h : def.defaultSize.h,
        z: 1,
        config: mergedConfig,
      } as CanvasWidgetInstance);
      curY += def.defaultSize.h + 20;
    }

    return {
      ok: true,
      data: {
        version: 2,
        active_tab_id: tab.id,
        grid_size: 20,
        locked: false,
        tabs: [tab],
        updated_at: Date.now(),
      },
    };
  }

  return { ok: false, error: 'JSON 格式不符合工作台规范，未找到有效 tabs 或 widgets' };
}

/**
 * 兼容旧版的 migrateWidgetDashboard
 */
export function migrateWidgetDashboard(data: any): WidgetDashboardState {
  const now = new Date().toISOString();
  if (!data || typeof data !== 'object') {
    return createDefaultPreset();
  }

  const rawWidgets = Array.isArray(data.widgets) ? data.widgets : [];
  const widgets: WidgetItem[] = [];

  let nextOrder = 0;
  for (const raw of rawWidgets) {
    if (!raw || typeof raw !== 'object') continue;
    const item: any = { ...raw };
    if (!item.id || typeof item.id !== 'string') {
      item.id = `widget_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }
    item.order = typeof item.order === 'number' ? item.order : nextOrder++;
    item.col_span = item.col_span === 2 ? 2 : 1;
    item.enabled = item.enabled !== false;
    item.encoding = item.encoding === 'hex' ? 'hex' : 'text';

    widgets.push(item as WidgetItem);
  }

  return {
    schema_version: WIDGET_SCHEMA_VERSION,
    name: typeof data.name === 'string' ? data.name : '我的自定义工作台',
    updated_at: now,
    widgets,
  };
}

/**
 * 开箱即用的默认电机 PID 调参预设 (向后兼容)
 */
export function createDefaultPreset(): WidgetDashboardState {
  const now = new Date().toISOString();
  const widgets: WidgetItem[] = [
    {
      id: 'w_pid_kp',
      type: 'slider',
      title: '比例增益 Kp 微调',
      description: '影响系统响应速度，过大会引发剧烈震荡',
      command_template: 'SET_KP {val}\\n',
      encoding: 'text',
      order: 0,
      col_span: 1,
      enabled: true,
      min: 0,
      max: 50,
      step: 0.1,
      default_value: 12.5,
      precision: 2,
      unit: '',
      send_mode: 'change',
    } as SliderWidgetConfig,
    {
      id: 'w_target_speed',
      type: 'number-input',
      title: '目标转速设定',
      description: '电机闭环设定点 Target',
      command_template: 'SET_SPD {val}\\n',
      encoding: 'text',
      order: 1,
      col_span: 1,
      enabled: true,
      min: -3000,
      max: 3000,
      step: 50,
      default_value: 1000,
      precision: 0,
      unit: 'rpm',
      submit_on_blur: false,
    } as NumberInputWidgetConfig,
    {
      id: 'w_btn_rst',
      type: 'button',
      title: '控制器复位',
      description: '触发单片机控制回路状态机重新初始化',
      command_template: 'CMD:RESET\\n',
      encoding: 'text',
      order: 2,
      col_span: 1,
      enabled: true,
      button_text: '🔄 执行复位',
      is_danger: false,
      debounce_ms: 500,
    } as ButtonWidgetConfig,
  ];

  return {
    schema_version: WIDGET_SCHEMA_VERSION,
    name: '电机 PID 调参预设',
    updated_at: now,
    widgets,
  };
}
