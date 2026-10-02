/**
 * VOFA+ 统一控件注册表 (Widget Registry)
 * 集中管理所有元器件的元数据、分类、默认尺寸、配置工厂与校验器
 */

import type {
  WidgetType,
  CanvasWidgetInstance,
  ChartConfig,
  GaugeConfig,
  NumberConfig,
  LedConfig,
  SliderConfig,
  ButtonConfig,
  KnobConfig,
  StatCardConfig,
  StepCardConfig,
  BodeConfig,
} from '../../types/widget';
import { WIDGET_DEFAULT_SIZES } from '../../types/widget';

export type WidgetCategory = 'chart' | 'display' | 'control' | 'analysis';

export interface WidgetDefinition<T extends WidgetType = WidgetType, C = any> {
  type: T;
  name: string;
  category: WidgetCategory;
  icon: string;
  desc: string;
  defaultSize: { w: number; h: number; min_w: number; min_h: number };
  createDefaultConfig: () => C;
  validateConfig?: (config: C) => boolean;
}

export class WidgetRegistry {
  private registry: Map<WidgetType, WidgetDefinition> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * 注册控件元信息
   */
  public register<T extends WidgetType, C>(def: WidgetDefinition<T, C>): void {
    this.registry.set(def.type, def as unknown as WidgetDefinition);
  }

  /**
   * 获取指定类型的控件定义
   */
  public get(type: WidgetType): WidgetDefinition | undefined {
    return this.registry.get(type);
  }

  /**
   * 检查是否已注册该类型
   */
  public has(type: string): boolean {
    return this.registry.has(type as WidgetType);
  }

  /**
   * 获取所有已注册控件定义列表
   */
  public list(): WidgetDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * 按分类获取控件定义列表
   */
  public listByCategory(category: WidgetCategory): WidgetDefinition[] {
    return this.list().filter((d) => d.category === category);
  }

  /**
   * 创建全新的控件实例工厂方法
   */
  public createInstance(
    type: WidgetType,
    x: number,
    y: number,
    title?: string,
    customConfig?: any,
    id?: string
  ): CanvasWidgetInstance {
    const def = this.get(type);
    if (!def) {
      throw new Error(`[WidgetRegistry] 未知的控件类型: ${type}`);
    }

    const widgetId = id || `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const size = def.defaultSize;
    const config = {
      ...def.createDefaultConfig(),
      ...(customConfig || {}),
    };

    return {
      id: widgetId,
      type,
      title: title || def.name,
      x,
      y,
      w: size.w,
      h: size.h,
      z: 1,
      config,
    } as CanvasWidgetInstance;
  }

  /**
   * 初始化注册所有 9 大内置控件
   */
  private registerDefaults(): void {
    // 1. 旗舰波形图 (Chart)
    this.register<WidgetType, ChartConfig>({
      type: 'chart',
      name: '波形曲线图',
      category: 'chart',
      icon: '📈',
      desc: 'uPlot 毫秒级流式渲染多通道曲线，带光标十字标尺与区间测距',
      defaultSize: WIDGET_DEFAULT_SIZES.chart,
      createDefaultConfig: () => ({
        series: [],
        auto_bind: false,
        time_window: 10,
        y_mode: 'auto',
        y_min: -10,
        y_max: 10,
        show_cursor: true,
        show_stats: true,
      }),
    });

    // 2. 指针仪表盘 (Gauge)
    this.register<WidgetType, GaugeConfig>({
      type: 'gauge',
      name: '指针仪表盘',
      category: 'display',
      icon: '🧭',
      desc: '270° 高频阻尼平滑模拟表盘，红线危险区预警',
      defaultSize: WIDGET_DEFAULT_SIZES.gauge,
      createDefaultConfig: () => ({
        channel: null,
        min: -100,
        max: 100,
        unit: '',
        precision: 1,
        redline_ratio: 0.85,
      }),
    });

    // 3. 数值框 / 数字LED显示 (Number)
    this.register<WidgetType, NumberConfig>({
      type: 'number',
      name: '数值显示框',
      category: 'display',
      icon: '🔢',
      desc: '大字号工业级读数面板，支持上下限超限警报与变化趋势指示',
      defaultSize: WIDGET_DEFAULT_SIZES.number,
      createDefaultConfig: () => ({
        channel: null,
        unit: '',
        precision: 2,
        prefix: '',
      }),
    });

    // 4. LED 状态灯 (Led)
    this.register<WidgetType, LedConfig>({
      type: 'led',
      name: '状态指示灯',
      category: 'display',
      icon: '💡',
      desc: '高亮发光二极管，支持多条件阈值触发与双色状态切换',
      defaultSize: WIDGET_DEFAULT_SIZES.led,
      createDefaultConfig: () => ({
        channel: null,
        label: '状态',
        active_condition: 'positive',
        threshold: 0,
        color_on: '#22C55E',
        color_off: '#383633',
        shape: 'circle',
      }),
    });

    // 5. 滑块调参器 (Slider)
    this.register<WidgetType, SliderConfig>({
      type: 'slider',
      name: '滑块调参器',
      category: 'control',
      icon: '🎚️',
      desc: '双向连续微调滑块，集成 SafetyGuard 限幅与指令模板绑定',
      defaultSize: WIDGET_DEFAULT_SIZES.slider,
      createDefaultConfig: () => ({
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
      }),
    });

    // 6. 动作按键 (Button)
    this.register<WidgetType, ButtonConfig>({
      type: 'button',
      name: '动作按键',
      category: 'control',
      icon: '🔘',
      desc: '单次触发脉冲按键，支持危险操作二次倒计时防呆确认',
      defaultSize: WIDGET_DEFAULT_SIZES.button,
      createDefaultConfig: () => ({
        button_text: '未绑定动作',
        command_template: '',
        encoding: 'text',
        enabled: false,
        is_danger: false,
      }),
    });

    // 7. 旋转旋钮 (Knob)
    this.register<WidgetType, KnobConfig>({
      type: 'knob',
      name: '旋钮调参器',
      category: 'control',
      icon: '🎛️',
      desc: '300° 拟真金属旋转电位器，支持触控拖拽与连续微调',
      defaultSize: WIDGET_DEFAULT_SIZES.knob,
      createDefaultConfig: () => ({
        command_template: '',
        encoding: 'text',
        enabled: false,
        min: -1000,
        max: 1000,
        step: 10,
        precision: 0,
        unit: 'rpm',
        default_value: 0,
        send_mode: 'change',
        throttle_ms: 50,
      }),
    });

    // 8. 统计卡片 (StatCard)
    this.register<WidgetType, StatCardConfig>({
      type: 'stat_card',
      name: '统计分析卡片',
      category: 'analysis',
      icon: '📊',
      desc: '计算并展示时间窗内信号均值、极值、峰峰值 (Pk-Pk) 与标准差',
      defaultSize: WIDGET_DEFAULT_SIZES.stat_card,
      createDefaultConfig: () => ({
        channel: 'actual',
        time_window: 5,
        unit: '',
      }),
    });

    // 9. 阶跃响应指标卡 (StepResponseCard)
    this.register<WidgetType, StepCardConfig>({
      type: 'step_card',
      name: '阶跃指标卡',
      category: 'analysis',
      icon: '🎯',
      desc: '控制理论特征提取：超调量 Mp、上升时间 tr、调节时间 ts 与阻尼比',
      defaultSize: WIDGET_DEFAULT_SIZES.step_card,
      createDefaultConfig: () => ({
        actual_channel: 'actual',
        target_channel: 'setpoint',
        time_window: 10,
        band_percent: 0.02,
        auto_refresh: true,
      }),
    });

    // 10. 波特图分析仪 (BodeWidget)
    this.register<WidgetType, BodeConfig>({
      type: 'bode',
      name: '波特图分析仪',
      category: 'analysis',
      icon: '📉',
      desc: '常驻绘制开环幅频/相频波特图，实时计算剪切频率 ωc 与相位裕度 γ，支持 ZOH 延时相角叠加',
      defaultSize: WIDGET_DEFAULT_SIZES.bode,
      createDefaultConfig: () => ({
        loop_id: 'speed',
        auto_refresh: true,
        show_stability_margins: true,
        show_delay_loss: true,
        omega_min: 0.1,
        omega_max: 1000,
      }),
    });
  }
}

export const globalWidgetRegistry = new WidgetRegistry();
