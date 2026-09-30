// ==========================================
// VOFA+ 拖拽控件工作台 - 核心数据契约 (TypeScript)
// ==========================================

export const WIDGET_SCHEMA_VERSION = 2;

export type WidgetType =
  | 'chart'
  | 'gauge'
  | 'number'
  | 'led'
  | 'slider'
  | 'button'
  | 'knob'
  | 'stat_card'
  | 'step_card'
  | 'bode';

export type GridSize = 10 | 20 | 40;
export type PayloadEncoding = 'text' | 'hex';

export interface SendResult {
  ok: boolean;
  reason?: 'port_closed' | 'disabled' | 'out_of_range' | 'nan' | 'timeout' | 'error' | 'io_error' | 'superseded';
  message?: string;
  payload?: string;
  bytes?: Uint8Array;
}

/**
 * 控件基础外壳定义
 */
export interface WidgetBase<T extends WidgetType, C> {
  id: string;        // 唯一标识 (如 "w_1740000000000_a1b2")
  type: T;
  title: string;
  x: number;         // 绝对横坐标 (px，grid_size 整数倍，≥ 0)
  y: number;         // 绝对纵坐标 (px，grid_size 整数倍，≥ 0)
  w: number;         // 宽度 (px，grid_size 整数倍，≥ 该类型最小尺寸)
  h: number;         // 高度 (px)
  z: number;         // 层级，数值越大越靠上
  order?: number;    // 可选顺序
  config: C;
}

// 1. 指针仪表盘配置 (270° 表盘)
export interface GaugeConfig {
  channel: string | null;   // 绑定的数据流通道 (如 'actual' / 'speed')
  min: number;              // 默认 -1.0
  max: number;              // 默认 1.0，必须 > min
  unit: string;             // 物理单位 (默认 '')
  precision: number;        // 读数小数位 (默认 2)
  redline_ratio: number;    // 红线起始比例 (0 ~ 1，默认 0.8)
}

// 2. 实时波形曲线图配置 (旗舰级 uPlot 多通道曲线)
export interface ChartSeries {
  channel: string;          // 绑定的数据流通道
  color: string;            // 十六进制颜色代码 (如 '#DA7756')
  visible: boolean;         // 是否可见
}

export interface ChartConfig {
  auto_bind?: boolean;     // 快速波形：自动显示实际收到的前 8 个通道
  series: ChartSeries[];    // 最多 8 条曲线
  time_window: number;      // 历史时间窗 (秒，默认 10)
  y_mode: 'auto' | 'manual';// Y 轴缩放模式
  y_min: number;            // manual 模式下生效
  y_max: number;            // manual 模式下生效
  show_cursor?: boolean;    // 十字光标与悬停指示 (默认 true)
  show_stats?: boolean;     // 区间测距与统计 (默认 true)
  target_channel?: string;  // 阶跃分析目标通道
  actual_channel?: string;  // 阶跃分析响应通道
}

// 3. 动作按键配置 (一键下发 / 危险二次确认 / 工业点动)
export interface ButtonConfig {
  button_text: string;      // 按钮文字 (如 "复位系统")
  command_template: string; // 下发指令内容 (如 "CMD:RST\n")
  encoding: PayloadEncoding;// 编码格式
  enabled?: boolean;        // 未绑定设备协议时保持禁用
  is_danger: boolean;       // 危险操作二次倒计时确认
  icon?: string;            // 可选图标
  mode?: 'click' | 'jog';   // 单发点击或点动模式 (按下/抬起)
  press_command?: string;   // 点动模式下按下指令
  release_command?: string; // 点动模式下抬起指令
}

// 4. 滑块调参器配置
export interface SliderConfig {
  command_template: string; // 下发指令模板 (如 "SET_KP {val}\n")
  encoding: PayloadEncoding;// 编码格式 (默认 'text')
  enabled?: boolean;        // 未绑定设备协议时保持禁用
  min: number;              // 最小值 (默认 0)
  max: number;              // 最大值 (默认 100)
  step: number;             // 步长 (默认 1)
  precision: number;        // 读数精度 (默认 0)
  unit: string;             // 物理单位
  default_value: number;    // 初始默认值
  send_mode: 'change' | 'input'; // 下发策略
  throttle_ms?: number;     // 连续下发节流时间 (ms，默认 50)
  feedback_channel?: string | null; // 反馈回显通道 (双向绑定)
}

// 5. 数值框 / 数字LED显示配置
export interface NumberConfig {
  channel: string | null;   // 绑定的数据流通道
  unit: string;             // 物理单位
  precision: number;        // 读数精度 (默认 2)
  min?: number;             // 警告下限 (可选)
  max?: number;             // 警告上限 (可选)
  prefix?: string;          // 数值前缀标签
}

// 6. LED 状态指示灯配置
export interface LedConfig {
  channel: string | null;   // 绑定的数据流通道
  label: string;            // 指示灯标签 (如 "电机使能")
  active_condition: 'non_zero' | 'positive' | 'threshold'; // 点亮判定
  threshold: number;        // threshold 模式下的触发阈值
  color_on: string;         // 点亮颜色 (默认绿色 '#22C55E')
  color_off: string;        // 熄灭颜色 (默认灰色 '#383633')
  shape: 'circle' | 'rect'; // 形状
  condition_mode?: 'two_state' | 'three_zone'; // 两态或三色区间
  warning_threshold?: number; // 警告阈值
  color_warn?: string;      // 警告颜色 (如黄色 '#EAB308')
}

// 7. 旋转旋钮调参器配置
export interface KnobConfig {
  command_template: string; // 下发指令模板 (如 "SET_SPD {val}\n")
  encoding: PayloadEncoding;// 编码格式
  enabled?: boolean;        // 未绑定设备协议时保持禁用
  min: number;              // 最小值 (默认 0)
  max: number;              // 最大值 (默认 100)
  step: number;             // 步长 (默认 1)
  precision: number;        // 读数精度 (默认 0)
  unit: string;             // 物理单位
  default_value: number;    // 默认初始值
  send_mode: 'change' | 'input'; // 下发策略
  throttle_ms?: number;     // 节流时间 (ms，默认 50)
  feedback_channel?: string | null; // 反馈回显通道 (双向绑定)
}

// 8. 实时数据统计卡片配置
export interface StatCardConfig {
  channel: string | null;   // 绑定的数据流通道
  time_window: number;      // 统计时间窗 (秒，默认 5)
  unit?: string;            // 物理单位
}

// 9. 阶跃响应指标卡配置
export interface StepCardConfig {
  actual_channel: string;   // 实际响应通道 (如 'actual')
  target_channel: string | number; // 目标设定通道或数值 (如 'target' 或 100)
  time_window: number;      // 观察分析时间窗 (秒，默认 10)
  band_percent: number;     // 稳态误差带比例 (默认 0.02 即 ±2%)
  auto_refresh: boolean;    // 是否定时自动重新检测
}

// 10. 波特图分析仪配置 (Bode Widget)
export interface BodeConfig {
  loop_id?: string;               // 绑定的环路 ID (默认使用当前激活环路)
  auto_refresh?: boolean;          // 是否定时/参数变更自动刷新 (默认 true)
  show_stability_margins?: boolean;// 是否展示相位裕度 γ 与剪切频率 ωc 徽标 (默认 true)
  show_delay_loss?: boolean;       // 是否展示 ZOH 延迟相角损失曲线 (默认 true)
  omega_min?: number;              // 频率对数下限 rad/s (默认 0.1)
  omega_max?: number;              // 频率对数上限 rad/s (默认 1000)
}

// 强类型可辨识联合
export type GaugeWidget = WidgetBase<'gauge', GaugeConfig>;
export type ChartWidget = WidgetBase<'chart', ChartConfig>;
export type ButtonWidget = WidgetBase<'button', ButtonConfig>;
export type SliderWidget = WidgetBase<'slider', SliderConfig>;
export type NumberWidget = WidgetBase<'number', NumberConfig>;
export type LedWidget = WidgetBase<'led', LedConfig>;
export type KnobWidget = WidgetBase<'knob', KnobConfig>;
export type StatCardWidget = WidgetBase<'stat_card', StatCardConfig>;
export type StepCardWidget = WidgetBase<'step_card', StepCardConfig>;
export type BodeWidget = WidgetBase<'bode', BodeConfig>;

export type CanvasWidgetInstance =
  | GaugeWidget
  | ChartWidget
  | ButtonWidget
  | SliderWidget
  | NumberWidget
  | LedWidget
  | KnobWidget
  | StatCardWidget
  | StepCardWidget
  | BodeWidget;

// 标签页结构
export interface CanvasTab {
  id: string;
  name: string;             // 标签页名称 (如 "实时波形监控")
  canvas_w: number;         // 虚拟画布宽度 (默认 2400)
  canvas_h: number;         // 虚拟画布高度 (默认 1600)
  widgets: CanvasWidgetInstance[];
}

// 通道元数据配置 (VOFA+ 右侧数据栏及各图表复用)
export interface ChannelMeta {
  id: string;               // 内部通道标识 (如 "0", "1", "speed", "!0")
  name: string;             // 显示别名 (默认 "!0", "!1", 支持双击就地重命名)
  color: string;            // 通道专属曲线与标牌色彩
  visible: boolean;         // 全局曲线可见性
  scale: number;            // 线性缩放倍率 (默认 1.0)
  yOffset: number;          // 垂直零点偏置 (默认 0.0)
  xOffset: number;          // 相位时滞偏置 (默认 0.0)
  decimal: number;          // 小数点精度 (0~6，默认 6)
  value?: number;           // 最新解析实时值
  updatedAt?: number;       // 上次数据脉冲时间戳 (用于微动效)
}

// 持久化主状态模型 (localStorage key: llm-serial.vofa-dashboard.v2)
export interface VofaDashboardState {
  version: 2;
  active_tab_id: string;
  grid_size: GridSize;      // 默认 20
  locked: boolean;          // 全局挂锁状态 (true 锁定运行 / false 解锁编辑)
  tabs: CanvasTab[];        // 至少 1 个 Tab
  channels?: Record<string, ChannelMeta>; // 通道元配置映射表
  updated_at: number;       // ms 时间戳
}

// 各控件默认尺寸与最小尺寸常量 (W x H)
export const WIDGET_DEFAULT_SIZES: Record<WidgetType, { w: number; h: number; min_w: number; min_h: number }> = {
  chart: { w: 560, h: 360, min_w: 280, min_h: 200 },
  gauge: { w: 240, h: 240, min_w: 160, min_h: 160 },
  number: { w: 200, h: 120, min_w: 140, min_h: 80 },
  led: { w: 160, h: 100, min_w: 120, min_h: 60 },
  slider: { w: 320, h: 100, min_w: 200, min_h: 80 },
  button: { w: 160, h: 80, min_w: 120, min_h: 60 },
  knob: { w: 200, h: 220, min_w: 160, min_h: 160 },
  stat_card: { w: 260, h: 180, min_w: 200, min_h: 140 },
  step_card: { w: 320, h: 260, min_w: 240, min_h: 180 },
  bode: { w: 560, h: 360, min_w: 320, min_h: 220 },
};

// ==========================================
// 辅助与向后兼容契约 (兼容安全保护与指令模板引擎)
// ==========================================

export interface BaseWidgetConfig {
  id: string;
  type: string;
  title: string;
  command_template?: string;
  encoding?: PayloadEncoding;
  enabled?: boolean;
  order?: number;
  col_span?: 1 | 2;
  debounce_ms?: number;
  throttle_ms?: number;
  [key: string]: any;
}

export interface NumericWidgetBase extends BaseWidgetConfig {
  min: number;
  max: number;
  step: number;
  precision: number;
  default_value?: number;
  unit?: string;
  hex_val_format?: 'u8' | 'i8' | 'u16le' | 'u16be' | 'i16le' | 'i16be' | 'f32le' | 'f32be';
}

export type SliderWidgetConfig = SliderConfig & BaseWidgetConfig;
export type ButtonWidgetConfig = ButtonConfig & BaseWidgetConfig;
export type NumberInputWidgetConfig = NumericWidgetBase;

export type WidgetItem = CanvasWidgetInstance | BaseWidgetConfig;

export interface WidgetRuntime {
  current_value?: number;
  status: 'idle' | 'sending' | 'ok' | 'error' | 'blocked';
  last_sent_at?: number;
  last_sent_payload?: string;
  error_message?: string;
}

export type WidgetRuntimeMap = Record<string, WidgetRuntime>;

export interface WidgetDashboardState {
  schema_version: number;
  name?: string;
  widgets: any[];
  updated_at: string;
}
