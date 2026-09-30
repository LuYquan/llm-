# 《LLM 串口 - VOFA+ 式拖拽控件工作台落地实施方案》（修订版 v1.1 - 正式执行基准）

> **状态**：执行中 (In Progress)  
> **基准来源**：用户最终评审方案 (2026-09-25)  
> **设计对标**：VOFA+ 1.3.10 原生拖拽仪表板（参考截图存放于 `docs/ref/vofa-*.png`）  
> **核心架构**：左侧控件仓库 + 右侧自由拖拽网格画布 + 🔒 挂锁运行锁定 + 全局通道数据中枢 (`ChannelHub`)

---

## 模块一：待决策与可调参数清单

| 参数项 | 默认值 | 推荐范围 / 可选值 | 说明 / 修改影响 | 确认状态 |
|---|---|---|---|:---:|
| 画布网格吸附步长 `grid_size` | 20px | 10 / 20 / 40px | 拖拽、拉伸的最小对齐单位。所有尺寸和最小尺寸按新步长向上取整；已有控件的坐标在下次移动时重新吸附 | [x] 20px |
| 仪表盘渲染帧率 | 30Hz | 10 ~ 60Hz | 仅控制重绘频率，与平滑效果无关 | [x] 30Hz |
| 指针平滑时间常数 | 100ms | 0 ~ 300ms（0 = 不平滑） | 在 requestAnimationFrame 中做指数平滑，值越大指针越"稳"，响应越平滑 | [x] 100ms |
| 波形图渲染帧率 | 30Hz | 15 ~ 60Hz | 与数据接收频率解耦，每帧最多重绘一次 | [x] 30Hz |
| 波形图默认时间窗口 | 10 秒 | 5 ~ 60s | 横轴展示的历史时长 | [x] 10s |
| 通道历史缓冲上限 | 60s，且单通道 ≤ 200,000 点 | 需 ≥ 最大时间窗 | 环形缓冲区，超出后丢弃最旧数据；决定内存上限 | [x] 60s / 20万点 |
| 初始画布尺寸 | 2400 × 1600 | 可滚动的虚拟画布 | 滚轮纵向滚动，Shift+滚轮横向滚动 | [x] 2400x1600 |
| 画布自动扩展 | 开启 | 控件距边缘 < 200px 时扩展 400px | 保证有足够空间排布复杂布局；画布只扩展不自动缩小 | [x] 开启 |
| 挂锁初始状态 | 新建/空白 Tab：解锁；重新打开：恢复上次状态 | — | 引导新用户拖入控件，同时避免老用户误触 | [x] 恢复上次/新建解锁 |
| 编辑态是否允许按键/滑块下发 | 禁止 | 禁止 / 允许 | 防止调整布局时误发指令 | [x] 禁止 |
| 控件重叠策略 | 允许重叠，点击置顶 | 允许重叠 / 禁止重叠 | 与 VOFA+ 自由布局保持一致 | [x] 允许重叠点击置顶 |
| 波形图默认尺寸 (W×H) | 480 × 280 | 最小 240 × 160 | 拖入时的初始尺寸 | [x] 480x280 |
| 仪表盘默认尺寸 (W×H) | 240 × 240 | 最小 160 × 160 | 同上 | [x] 240x240 |
| 动作按键默认尺寸 (W×H) | 160 × 80 | 最小 120 × 60 | 同上 | [x] 160x80 |
| 滑块调参器默认尺寸 (W×H) | 320 × 100 | 最小 200 × 80 | 同上（步长为 40 时取整为 320×120 / 200×80） | [x] 320x100 |
| 滑块实时下发节流间隔 | 100ms | 50 ~ 500ms | `send_mode=input` 时两次下发的最小间隔 | [x] 100ms |
| 危险操作确认倒计时 | 1s | 0 ~ 3s | 二次确认弹窗中"确认"按钮可点击前的等待时间 | [x] 1s |
| 按键防连击间隔 | 300ms | 0 ~ 1000ms | 间隔内的重复点击被忽略 | [x] 300ms |
| 持久化写入防抖 | 500ms | 200 ~ 2000ms | 连续变更合并为一次写入 | [x] 500ms |
| 性能护栏 | Tab ≤ 20 个，单 Tab 控件 ≤ 50 个 | — | 超出时提示，不强制阻止 | [x] 提示 |

---

## 模块二：VOFA+ 核心交互行为对照与验收规范

### 2.0 编辑态 / 运行态能力矩阵

| 能力 | 🔓 解锁（编辑态） | 🔒 锁定（运行态） |
|---|---|---|
| 从控件库拖入 | ✅ | ❌（控件库置灰并提示"请先解锁"） |
| 移动 / 缩放 / 删除 / 复制 | ✅ | ❌（隐藏把手、手柄与按钮） |
| 双击或 ⚙️ 打开配置 | ✅ | ❌ |
| 按键点击下发 / 滑块下发 | ❌（默认禁止） | ✅ |
| 仪表盘 / 波形图实时刷新 | ✅ | ✅ |

### 2.1 交互流程与验收标准

| 操作阶段 | 用户行为 | 系统界面表现 | 验收标准 |
|---|---|---|---|
| **1. 控件拖拽发起** | 在左侧控件库卡片上按下并移动（移动超过 4px 才判定为拖拽） | 光标变为抓手，出现半透明微缩投影跟随鼠标；左侧原卡片保持不动 | 采用 Pointer Events，不发生文本误选；锁定态下无法发起 |
| **2. 画布拖入悬停** | 拖入右侧画布区域 | 出现半透明虚线幽灵框（尺寸 = 该控件默认尺寸），左上角按"鼠标位置 − 抓取偏移 + 滚动偏移"计算，并吸附到 `grid_size` 网格 | 画布滚动后落点仍然准确；超出画布左/上边界时自动限位（x, y ≥ 0） |
| **3. 松开鼠标生成** | 在画布内松开 | 幽灵框消失，在对应位置生成控件：分配唯一 ID，层级置顶，存入当前 Tab；靠近边缘时触发画布扩展 | 控件边缘吸附到网格线；在画布外松开则取消，不生成控件 |
| **4. 控件自由移动** | 解锁态下按住控件顶部把手拖动 | 控件跟随移动，显示蓝色虚线对齐框，松手落位并置顶 | 仅解锁态可用；拖动过程中不写存储，松手后才提交 |
| **5. 控件拉伸缩放** | 解锁态下按住控件**右下角缩放手柄**拖动 | 宽高实时变化并吸附网格，内部图形随尺寸自适应重绘 | 不小于最小尺寸；仪表盘在非正方形时按 `min(w, h)` 绘制，不变形 |
| **6. 属性配置编辑** | 解锁态下双击控件或点击 ⚙️ | 弹出配置抽屉：修改时实时预览，点"确定"保存，点"取消"回滚 | 保存前校验：`min < max`、`step > 0`、hex 格式合法、模板非空；校验不通过时禁止保存并提示原因 |
| **7. 挂锁运行锁定** | 点击画布右上角挂锁（🔓 ↔ 🔒） | 按 2.0 能力矩阵切换状态；锁定状态写入持久化 | 按键可下发、滑块可调、显示类控件持续刷新 |
| **8. 多标签页管理** | 点击 Tab 栏 `+` / `✕`，双击 Tab 名称 | 新建 Tab（默认名"工作台 N"）/ 关闭 / 双击重命名 / 切换；**各 Tab 布局独立，串口数据全局共享** | 关闭非空 Tab 前需确认；禁止关闭最后一个 Tab；10 个控件的 Tab 切换 < 100ms；非激活 Tab 暂停渲染但继续缓冲数据，切回后曲线连续 |
| **9. 删除控件** | 点击 ✕ 或选中后按 Delete | 弹出确认后删除 | 锁定态无效 |
| **10. 复制控件** | 选中后按 Ctrl+D，或使用右键菜单"复制" | 在原位置右下偏移一个网格处生成副本（新 ID，配置相同） | 仅解锁态可用 |
| **11. 未连接串口时下发** | 锁定态点击按键或拖动滑块 | 显示提示"串口未连接，指令未发送"，不写入发送队列 | 不报错、不卡顿 |

---

## 模块三：首期核心元器件库规格表

### 3.0 通用约定
- **无数据**：显示类控件在未绑定通道或尚未收到数据时，数值显示为 `--`，指针停在最小值处，波形图显示"等待数据"。
- **超出量程**：指针限位在两端，数值照常显示真实值，并以红色标识。
- **通道列表**：配置表单中的通道下拉框由通道数据中枢实时提供（见 4.2），并支持手动输入尚未出现的通道名。

### 3.1 🧭 指针仪表盘（GaugeWidget）—— 对照截图左下角
- **外观呈现**：
  - 圆形表盘，按 `min(w, h)` 自适应绘制；扫描角度固定为 270°；
  - 刻度弧线（如 -1.0 ~ 1.0，或自定义 0 ~ 3000），主刻度 5 ~ 10 格，自动取整；
  - 红色告警弧段（从 `redline_ratio` 处开始）；
  - 中心高对比度指针，通过 requestAnimationFrame 按平滑时间常数（默认 100ms）指数插值旋转（不使用 CSS transition，防止高频丢帧）；
  - 底部大字号数字显示当前读数和单位。
- **配置项**：
  - `title`：控件标题（如"电机实时转速"）
  - `channel`：绑定的通道名
  - `min`：量程下限（默认 -1.0）
  - `max`：量程上限（默认 1.0，必须大于 `min`）
  - `unit`：物理单位（默认空）
  - `precision`：读数小数位（默认 2）
  - `redline_ratio`：红线起始比例，取值 0 ~ 1（默认 0.8；设为 1 即关闭红线）

### 3.2 📈 实时波形曲线图（ChartWidget）—— 对照截图中央主图
- **外观呈现**：
  - 深色高对比度工程背景；
  - 虚线网格（X 轴为时间，Y 轴为数值）；
  - 左侧数值标尺；右上角图例，点击可隐藏/显示对应曲线；
  - 适配高分屏像素比，尺寸变化时自动重绘。
- **配置项**：
  - `title`：图表标题
  - `series[]`：曲线列表（最多 8 条），每项包含 `channel`、`color`、`visible`。颜色预设为天蓝 `#38BDF8`、翡翠绿 `#34D399`、琥珀黄 `#FBBF24`、珊瑚粉 `#FB7185`，支持自定义十六进制色值；
  - `time_window`：时间窗（默认 10s）
  - `y_mode`：`auto`（自动适配当前窗口内数据范围，并留 10% 边距）或 `manual`
  - `y_min` / `y_max`：仅在 `manual` 模式下生效
- **绘制规则**：当窗口内的点数超过画布像素宽度的 2 倍时，按像素列做最小/最大值抽稀后再绘制；非激活 Tab 或窗口隐藏时暂停渲染。

### 3.3 🔘 动作按键（ButtonWidget）—— 对照截图左侧 name 按钮
- **外观呈现**：
  - 扁平工控风格按键，显示自定义文字；
  - 悬停高亮，点击时有下凹动效和发送波纹；
  - 发送结果短暂反馈：成功时边框闪绿，失败时闪红。
- **配置项**：
  - `button_text`：按钮文字（如"复位系统"），同时作为控件标题
  - `command_template`：下发内容（如 `CMD:RST\n`）
  - `encoding`：`text`（解析 `\r`、`\n`、`\t`、`\\`、`\xHH` 转义）或 `hex`（如 `AA 55 01`，允许空格，必须为偶数位十六进制）
  - `is_danger`：勾选后，点击**立即**弹出二次确认框，"确认"按钮在倒计时（默认 1s）结束后才可点击。防连击：300ms 内重复点击忽略。

### 3.4 🎚️ 滑块调参器（SliderWidget）
- **外观呈现**：横向导轨、当前数值指示、Min / Max 端点刻度；支持键盘 ← → 按 `step` 微调。
- **配置项**：
  - `title`：标题（如"目标转速"）
  - `command_template`：模板（如 `SET:SPEED={val}\n`）
  - `min` / `max` / `step` / `precision` / `unit`
  - `default_value`：初始值，加载时**不会**自动下发
  - `send_mode`：`change`（松手时下发，推荐）或 `input`（拖动过程中按节流间隔实时下发，松手时额外补发一次最终值）
  - `encoding`：首期仅支持 `text`。

---

## 模块四：数据契约与存储结构 (TypeScript)

### 4.1 布局与配置契约 (`src/types/widget.ts`)

```typescript
export type WidgetType = 'chart' | 'gauge' | 'button' | 'slider';
export type GridSize = 10 | 20 | 40;

interface WidgetBase<T extends WidgetType, C> {
  id: string;        // 如 "w_1740000000000_a1b2"
  type: T;
  title: string;
  x: number;         // px，grid_size 整数倍，≥ 0
  y: number;         // px，grid_size 整数倍，≥ 0
  w: number;         // px，grid_size 整数倍，≥ 该类型最小尺寸
  h: number;
  z: number;         // 层级，数值越大越靠上
  config: C;
}

export interface GaugeConfig {
  channel: string | null;
  min: number;              // 默认 -1.0
  max: number;              // 默认 1.0，必须 > min
  unit: string;             // 默认 ''
  precision: number;        // 默认 2
  redline_ratio: number;    // 0 ~ 1，默认 0.8
}

export interface ChartSeries {
  channel: string;
  color: string;            // '#RRGGBB'
  visible: boolean;
}
export interface ChartConfig {
  series: ChartSeries[];    // 最多 8 条
  time_window: number;      // 秒，默认 10
  y_mode: 'auto' | 'manual';
  y_min: number;            // manual 模式下生效
  y_max: number;
}

export interface ButtonConfig {
  button_text: string;
  command_template: string;
  encoding: 'text' | 'hex';
  is_danger: boolean;
}

export interface SliderConfig {
  command_template: string; // 如 "SET:KP={val}\n"
  encoding: 'text';         // 首期仅 text
  min: number;              // 默认 0
  max: number;              // 默认 100
  step: number;             // > 0，默认 1
  precision: number;        // 默认 0
  unit: string;
  default_value: number;    // 限位在 [min, max] 内
  send_mode: 'change' | 'input';
}

export type GaugeWidget  = WidgetBase<'gauge',  GaugeConfig>;
export type ChartWidget  = WidgetBase<'chart',  ChartConfig>;
export type ButtonWidget = WidgetBase<'button', ButtonConfig>;
export type SliderWidget = WidgetBase<'slider', SliderConfig>;
export type CanvasWidgetInstance = GaugeWidget | ChartWidget | ButtonWidget | SliderWidget;

export interface CanvasTab {
  id: string;
  name: string;             // 如 "主控仪表盘"
  canvas_w: number;         // 默认 2400，只扩展不自动缩小
  canvas_h: number;         // 默认 1600
  widgets: CanvasWidgetInstance[];
}

export interface VofaDashboardState {
  version: 2;
  active_tab_id: string;
  grid_size: GridSize;      // 默认 20
  locked: boolean;          // 全局挂锁状态
  tabs: CanvasTab[];        // 至少 1 个
  updated_at: number;       // ms 时间戳
}
```

### 4.2 通道数据中枢契约 (`src/services/channelHub.ts`)

```typescript
export interface ChannelHub {
  listChannels(): string[];
  onChannelsChanged(cb: (names: string[]) => void): () => void;
  latest(channel: string): { t: number; v: number } | undefined;
  range(channel: string, fromT: number, toT: number): { t: Float64Array; v: Float64Array };
  pushBatch(points: { timestamp: number; values: Record<string, number> }[]): void;
}
```

---

## 模块五：实施任务与交付 Checklist

- [x] **Phase 1: 数据模型、工具函数与 ChannelHub**
  - [x] 1.1 更新 `src/types/widget.ts`（包含可辨识联合类型、VofaDashboardState）；
  - [x] 1.2 创建 `src/utils/grid.ts`（网格吸附、坐标转换、边界限位纯函数）；
  - [x] 1.3 创建 `src/services/channelHub.ts`（每通道环形缓冲，与 session 数据流挂接）；
- [x] **Phase 2: VOFA+ 拖拽网格画布核心交互**
  - [x] 2.1 重构 `src/components/WidgetDashboard.vue`：
    - [x] 左侧【控件库】列表（带图标、说明，锁定态置灰）；
    - [x] 顶部 Tab 栏（新增、切换、重命名、关闭前确认、禁止关闭最后一个）；
    - [x] 右上角挂锁按钮（🔒 锁定运行 / 🔓 解锁编辑）；
    - [x] 主视区自由滚动画布（网格背景、Shift+滚轮横移、自动扩展）；
  - [x] 2.2 实现 Pointer Events 拖拽引擎（拖动 > 4px 激活、幽灵框 Ghost 预览、网格吸附落位）；
  - [x] 2.3 编写 `CanvasWidgetWrapper.vue` 卡片外壳（顶部把手平移 Move、右下角手柄缩放 Resize、层级置顶）；
  - [x] 2.4 编写属性配置抽屉/模态框（支持通道绑定下拉、量程上下限校验、指令模板与危险防误触）；
- [x] **Phase 3: 核心元器件开发与数据渲染**
  - [x] 3.1 编写 `GaugeWidget.vue`（SVG 270° 弧线、红线告警、requestAnimationFrame 指数阻尼平滑指针、无数据 `--` 占位）；
  - [x] 3.2 编写 `ChartWidget.vue`（Canvas 多曲线、高分屏 DPR 自适应、ResizeObserver 自适应、数据抽稀、图例切换、隐藏时暂停渲染）；
  - [x] 3.3 接入 `ButtonWidget.vue` 与 `SliderWidget.vue`（通过 `globalSendGate` 下发、1s 危险倒计时确认、发送闪烁反馈、未连接防呆提示）；
- [x] **Phase 4: 持久化与构建验证**
  - [x] 4.1 实现持久化规则（500ms 防抖、坏数据另存备份、默认预设恢复）；
  - [x] 4.2 执行构建与测试：`npm run build`、`npm run test:widget`、`cargo test`、`npm run build:portable`。
