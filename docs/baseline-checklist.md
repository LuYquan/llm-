# 《LLM 串口工作�?- 功能基线与回归保护清单�?
| 文档属�?| 说明 |
|---|---|
| **文档版本** | v1.0（阶段零归档基线�?|
| **生效阶段** | 阶段零：基线确认与回归保护（重构前必做） |
| **关联文档** | [开发计划](dev-plan-desktop-and-web.md)、[ADR 0004 急停槽位](adr/0004-emergency-stop-user-configured-slot.md)、[ADR 0006 双运行时架构](adr/0006-dual-runtime-serial-transport.md)、[工程决策基准](engineering-decisions.md) |
| **核对目标** | 为阶段一（`ISerialTransport` 抽象层与 `TauriTransport` 迁移）提供不可动摇的回归核对基准，确保现有桌面端所�?30 �?IPC 命令�? 个事件流�?15 项核心业务组件零回归，并作为阶段二网页端对齐的唯一规范�?|

---

## 一、架构拓扑与代码资产全景

### 1.1 前端代码资产全景 (`src/`)

| 文件/组件 | 核心职责 | 当前直接依赖 / IPC 调用 | 对应 UI 区域与表�?|
|---|---|---|---|
| [`src/App.vue`](../src/App.vue) | 顶层状态机、双模视图调度器、急停热键总控、持久化防抖调度 | 监听 `serial://status`, `serial-disconnected`, `logs://batch`, `step://snapshot`；调�?`load_app_config`, `save_app_config`, `start_pipeline`, `stop_pipeline`, `reset_pipeline`, `get_pipeline_status`, `open_log_dir`, `send_emergency_stop`, `list_serial_ports`, `send_serial_data`, `score_step_metrics` | 工作区总框架、核心双模切换（波形/调试）、底栏日志抽屉、全局断线 Banner、急停 Toast 提示 |
| [`src/components/TopBar.vue`](../src/components/TopBar.vue) | 顶栏设备连接面板、波特率选择、数据源切换、采样率与样本数指标展示 | 向上派发 `toggleConnect`, `reset`, `changeMode`, `changeActiveTab`, `changePort`, `changeBaud`, `refreshPorts` 事件 | 顶栏：Logo、模式切换切换卡、数据源下拉框（Mock/Serial）、端口下拉框与刷新旋转按钮、波特率选择、启�?停止按钮、清空按钮、吞吐速率指示徽章 |
| [`src/components/WaveformViewer.vue`](../src/components/WaveformViewer.vue) | uPlot 高性能 60FPS 实时曲线渲染引擎、通道语义绑定、历史视窗提�?| 监听 `waveform://batch`, `waveform://reset`；调�?`get_channel_mapping`, `set_channel_mapping`, `get_waveform_window` | 左侧波形大屏：目标曲线（天蓝虚线）、响应曲线（翡翠绿实线）、输出曲线（琥珀黄实线）、当前读数卡片、通道语义映射下拉框（Target/Actual/Output）、历史波形拉取按钮、鼠标滚轮缩放与双击复位 |
| [`src/components/GeneralTerminal.vue`](../src/components/GeneralTerminal.vue) | 常规串口调试监视器、HEX/ASCII 双显、输入历史、多行滚�?| 向上派发 `send-data`, `clear-logs`, `diagnose-log` 事件 | 调试模式左区：黑色高对比终端窗口、自动滚屏开关、HEX显示开关、清屏按钮、单行诊断按钮、底部发送输入框与回车发�?|
| [`src/components/QuickCommandPanel.vue`](../src/components/QuickCommandPanel.vue) | 快捷指令管理、循环定时发送管理、危险指令防误触 | 调用 `start_periodic_send`, `stop_periodic_send`；向上派�?`send-command`, `emergency-stop` | 调试模式右区上方：预设指令列表（复位、校准、急停）、新�?删除指令弹窗、循环发送勾选框与周期数值输入框（ms�?|
| [`src/components/CrcTools.vue`](../src/components/CrcTools.vue) | 工业硬件校验实时计算（Modbus CRC16、CRC32、Sum8、XOR8�?| 调用 `calculate_checksums` 与前�?`utils/crc.ts` 双向核对 | 调试模式右区下方：HEX 输入框�? 大校验值实时对比卡片、一键复制按钮、一键附加至发送缓冲区按钮 |
| [`src/components/SnapshotStream.vue`](../src/components/SnapshotStream.vue) | 阶跃突变切片快照卡片流、四项工程指标展�?| 监听 `step://snapshot`；向上派�?`select-snapshot` | 波形模式右侧侧边栏上方：阶跃历史切片流（最�?0组）、阶跃幅值差值、上升时间、超调量、调节时间、稳态误差指示、收敛状态标识（已收�?未收�?被打断） |
| [`src/components/MetricRadar.vue`](../src/components/MetricRadar.vue) | 控制品质五维雷达图（超调量、响应速度、阻尼特性、系统鲁棒性、稳态精度） | 接收 `scores` 属性（调用后端 `score_step_metrics` 计算所得） | 波形模式右侧侧边栏中部：SVG 动态多边形雷达、同心五边形参考刻度、综合品质平均分徽章、五大维度标�?|
| [`src/components/AiTunerPanel.vue`](../src/components/AiTunerPanel.vue) | AI PID 闭环调参卡片、参数对比表、SafetyGuard 核准闭环 | 调用 `validate_and_apply_pid`；调�?`services/ai.ts` 诊断服务 | 波形模式右侧侧边栏下方：调参娘头像、当�?PID 读数、AI 建议 PID、Δ变动增量、控制理论依据描述、工程风险警告、核准下发设备按钮、AI 模型配置弹窗 |
| [`src/services/ai.ts`](../src/services/ai.ts) | 大模�?API 客户端（DeepSeek / OpenAI / Ollama），带强 Schema 校验与离线降�?| 调用 `diagnose_pid_offline`；通过 fetch 直连 AI 端点�?s 超时�?| 提供 `diagnoseStep` �?`explainLog` 核心业务方法 |
| [`src/utils/crc.ts`](../src/utils/crc.ts) | 纯前端硬件校验算法库 | 无外部依�?| �?Rust �?`calculate_checksums` 算法严格一�?|
| [`src/types/ipc.ts`](../src/types/ipc.ts) | 官方 IPC 数据模型 TypeScript 接口定义 | 契约镜像 `src-tauri/src/model.rs` | 规范所有的请求体与事件负载类型 |

---

### 1.2 后端代码资产全景 (`src-tauri/`)

| 模块文件 | 核心职责 | 暴露命令 / 结构�?| 关键实现细节与性能保障 |
|---|---|---|---|
| [`src/lib.rs`](../src-tauri/src/lib.rs) | Tauri 应用启动入口、状态注册、IPC 路由绑定 | `run()`, 注册全部 30 �?command | 初始化系统轮转日志，创建 `AppState { pipeline: PipelineManager::new() }` |
| [`src/commands.rs`](../src-tauri/src/commands.rs) | 30 �?Tauri IPC Command 处理程序实现 | `start_pipeline`, `stop_pipeline` �?30 个函�?| 参数校验、类型转换、转发至 `PipelineManager`、`Config`、`Secrets` 等模�?|
| [`src/pipeline/mod.rs`](../src-tauri/src/pipeline/mod.rs) | 三级数据管线总控、多任务生命周期协调、多速率事件派发 | `PipelineManager`, `PipelineStatus` | 协调 3 个后�?Tokio 异步协程�?br>1. 串口读取与智能分流任务；<br>2. 60Hz 波形批次聚合派发任务�?br>3. 10Hz 终端日志聚合派发任务�?br>支持高优先级急停通道与高精度定时发送�?|
| [`src/pipeline/demuxer.rs`](../src-tauri/src/pipeline/demuxer.rs) | 协议智能分流器（StreamDemuxer�?| `StreamDemuxer`, `DemuxOutput` | 智能识别 Teleplot（`>` 开头）、CSV（含逗号数值行）、日志前缀（`[`、`#`、`//`、`INFO:` 等）以及普通文本日志，脏数据静默容错与错误计数累加 |
| [`src/pipeline/parser.rs`](../src-tauri/src/pipeline/parser.rs) | 纯文本解析与 Teleplot 微秒对齐�?| `TextParser`, `TeleplotAligner` | 1. `TextParser`：CSV 浮点数解析，支持科学计数法，拦截 NaN/Inf�?br>2. `TeleplotAligner`�?0ms 时间窗口与变量重复翻转机制，稀疏通道保持，彻底杜绝时间轴锯齿 |
| [`src/pipeline/ring_buffer.rs`](../src-tauri/src/pipeline/ring_buffer.rs) | 内存固定容量环形缓冲、降采样算法 | `TimeSeriesRingBuffer`, `LogRingBuffer` | 1. `TimeSeriesRingBuffer`：固定容�?60,000 点（60s @ 1kHz），稀疏通道前值保持；<br>2. `LogRingBuffer`：固定容�?2,000 行，满载自动淘汰�?br>3. `get_window`：LTTB（Largest Triangle Three Buckets）降采样算法�?00% 保留波峰波谷极�?|
| [`src/pipeline/step.rs`](../src-tauri/src/pipeline/step.rs) | 阶跃突变检测状态机与四大指标分析引�?| `StepDetector`, `StepAnalyzer` | �?500ms 基准窗（y0），�?10s 观察窗；Target 突变 >10% 触发检测；计算上升时间 tr�?0%~90% 线性插值）、超调量 Mp、调节时�?ts（�?% 误差带持�?500ms）、稳态误�?ess（最�?10% 均值） |
| [`src/pipeline/data_source.rs`](../src-tauri/src/pipeline/data_source.rs) | 底层硬件 I/O 抽象与数据驱动实�?| `DataSource`, `SerialDataSource`, `MockDataSource`, `process_serial_bytes` | 1. `SerialDataSource`：独占打开物理串口，双线程收发隔离，高优先级急停优先处理，热插拔掉线探测�?br>2. `MockDataSource`�?00Hz 真实二阶惯�?ODE + PID 积分仿真，支�?0->10->20 自动/手动阶跃与日志注入；<br>3. `process_serial_bytes`：跨 chunk 半行截断拼接、非 UTF-8 容错、超�?16KB 超长行清空截断保�?|
| [`src/ai/radar.rs`](../src-tauri/src/ai/radar.rs) | 五维品质雷达指标评分计算�?| `MetricScorer`, `RadarMetrics` | 基于阶跃指标计算 0~100 标准化得分：超调得分（Mp）、速度得分（tr）、阻尼得分（zeta/Mp）、鲁棒得分、稳态得分（ess�?|
| [`src/ai/rule_engine.rs`](../src-tauri/src/ai/rule_engine.rs) | 离线控制理论专家规则引擎 | `OfflineRuleEngine`, `AiDiagnosisResult` | 经典工程整定逻辑：超调过大降 Kp �?Kd；响应过慢增 Kp；有静差�?Ki；发散失稳大幅收缩并报警；无网环境下毫秒级响�?|
| [`src/ai/safety.rs`](../src-tauri/src/ai/safety.rs) | 调参安全防线（SafetyGuard�?| `SafetyGuard` | 1. 参数绝对极值限幅（Kp: 0~100, Ki: 0~50, Kd: 0~20）；<br>2. 单次变动幅度限制（不超过 ±50%）；<br>3. 符号反转拦截（负数拦截）�?br>4. NaN / Infinity 拦截�?br>5. 格式化标准下发指令（�?`PID 1.800 0.600 0.250\n`�?|
| [`src/archive.rs`](../src-tauri/src/archive.rs) | 串口全量数据本地持久化归档记录器 | `SerialArchiveWriter`, `SharedSerialArchive` | 独立�?UI 2000 行限制，保存完整 RX/TX 原始报文；递增单调序号 `seq` 与单调微秒时间戳；单文件 10MB，最多保�?10 个文件轮转；500Hz 吞吐无丢�?|
| [`src/logger.rs`](../src-tauri/src/logger.rs) | 系统级追踪日志与文件目录管理 | `init_logger`, `open_log_directory`, `get_app_dir` | 每日轮转文件日志（`llm-serial.log`），自动清理 7 天前旧日志；跨平台资源管理器唤起（Windows explorer�?|
| [`src/secrets.rs`](../src-tauri/src/secrets.rs) | Windows DPAPI 加密凭据存储 | `save_api_key`, `load_api_key` | 使用 Windows `CryptProtectData` / `CryptUnprotectData` 硬件级用户加密，API Key 不在配置文件存明文，存入 `secrets.enc` |
| [`src/config.rs`](../src-tauri/src/config.rs) | 工作区配置文件读�?| `load_config`, `save_config`, `AppConfig` | `%APPDATA%/LLM-Serial/config.json` 结构化持久化，字段缺失时自动使用默认值，静默无感保存 |
| [`src/serial.rs`](../src-tauri/src/serial.rs) | 物理串口枚举与自然排�?| `enumerate_serial_ports`, `SerialPortInfo` | 枚举系统串口，提�?USB 描述符与厂商信息；自然数字排序（`COM2` < `COM10`�?|
| [`src/model.rs`](../src-tauri/src/model.rs) | 统一时序数据模型与校验和计算 | `WaveformBatch`, `SamplePoint`, `LogLine`, `ChecksumResult`, `StepSnapshot` | 包含 Modbus CRC16（低位在�?高位在前）、CRC32（IEEE 802.3）、Sum8、XOR8 标准工业校验实现 |

---

## 二�?0 �?Tauri IPC 命令详尽契约�?
在重构至阶段一 `ISerialTransport` 时，各命令的调用关系与归宿如下表所规范�?
| 编号 | IPC 命令�?| Rust 处理函数与入�?| 返回类型 | 前端调用组件/文件 | 核心预期行为与副作用 | 阶段一重构规划说明 |
|---|---|---|---|---|---|---|
| **1** | `start_pipeline` | `mode: Option<String>, port: Option<String>, baud_rate: Option<u32>` | `Result<PipelineStatus, String>` | `App.vue` | 启动数据管线；若已在运行则安全终止旧连接；创建会�?`session_id` �?`channel_epoch`；启�?3 个异步分发协程；广播 `serial://status` | 转移�?`ISerialTransport.connect` 内部驱动实现 |
| **2** | `stop_pipeline` | �?| `Result<PipelineStatus, String>` | `App.vue` | 停止管线并释放底层句柄；清空发送队列；刷新归档缓冲区；广播 `serial://status` (is_connected: false) | 转移�?`ISerialTransport.disconnect` |
| **3** | `reset_pipeline` | �?| `Result<PipelineStatus, String>` | `App.vue`, `TopBar.vue` | 清空波形环形缓冲、日志缓冲、分流器与阶跃检测器；广�?`waveform://reset` | 保留为工作区级重置命�?|
| **4** | `get_pipeline_status` | �?| `Result<PipelineStatus, String>` | `App.vue` | 查询当前管线运行状态、模式、动态计算样本速率 (sample_rate)、总样本数与错误计�?| 保持不变 |
| **5** | `list_serial_ports` | �?| `Result<Vec<SerialPortInfo>, String>` | `App.vue`, `TopBar.vue` | 枚举系统当前可用物理与虚拟串口，按自然数字排�?| 转移�?`ISerialTransport.listPorts` |
| **6** | `connect_serial` | `port: String, baud_rate: Option<u32>` | `Result<PipelineStatus, String>` | 兼容命令 | 等价�?`start_pipeline(mode="serial", port, baud_rate)` | 保留作为快捷别名 |
| **7** | `disconnect_serial` | �?| `Result<PipelineStatus, String>` | 兼容命令 | 等价�?`stop_pipeline` | 保留作为快捷别名 |
| **8** | `start_mock` | `format: Option<String>` | `Result<PipelineStatus, String>` | 兼容命令 | 启动 Mock 虚拟数据源（可指�?"csv" �?"teleplot"�?| 调试辅助接口 |
| **9** | `stop_mock` | �?| `Result<PipelineStatus, String>` | 兼容命令 | 等价�?`stop_pipeline` | 调试辅助接口 |
| **10** | `send_bytes` | `bytes: Vec<u8>` | `Result<(), String>` | 底层测试 | 直接向发送队列灌入原始字节流并记�?TX 日志 | 转移�?`ISerialTransport.write` |
| **11** | `send_emergency_stop` | `data: Option<String>` | `Result<(), String>` | `App.vue` | **ADR 0004 最高优先级急停**：绕过普通队列，直接写入 emergency 队列，记�?Warn 级别 TX 日志 | 转移�?`ISerialTransport.emergencyStop` |
| **12** | `get_waveform_window` | `start_us: u64, end_us: u64, max_points: Option<usize>` | `Result<Option<WaveformBatch>, String>` | `WaveformViewer.vue` | �?Rust 环形缓冲提取指定微秒时间范围的数据，使用 LTTB 算法降采样返回最�?`max_points` 点（极值保真） | 保留作为历史波形查询通道 |
| **13** | `start_periodic_send` | `data: String, interval_ms: u64, is_hex: bool` | `Result<(), String>` | `QuickCommandPanel.vue` | �?Rust 后端启动高精�?`tokio::time::interval` 循环发送任务（周期 �?10ms�?| 保留为桌面端高精度循环发送服�?|
| **14** | `stop_periodic_send` | �?| `Result<(), String>` | `QuickCommandPanel.vue` | 终止 Rust 侧的定时循环发送协�?| 保留 |
| **15** | `calculate_checksums` | `data: String, is_hex: bool` | `Result<ChecksumResult, String>` | `CrcTools.vue` | 计算 Modbus CRC16 (LE/BE)、CRC32、Sum8、XOR8 校验�?| 保留（离线工具函数） |
| **16** | `open_log_dir` | �?| `Result<String, String>` | `App.vue` | 在操作系统资源管理器中打开 `%APPDATA%/LLM-Serial/logs` | 保持不变（仅桌面端能力） |
| **17** | `open_log_directory_cmd` | �?| `Result<String, String>` | 别名命令 | 等价�?`open_log_dir` | 兼容命令 |
| **18** | `load_app_config` | �?| `Result<AppConfig, String>` | `App.vue` | �?`%APPDATA%/LLM-Serial/config.json` 加载工作区配置；文件缺失返回默认�?| 保持不变 |
| **19** | `save_app_config` | `config: AppConfig` | `Result<(), String>` | `App.vue` | 保存配置�?`config.json` | 保持不变 |
| **20** | `get_workspace_config` | �?| `Result<AppConfig, String>` | 别名命令 | 等价�?`load_app_config` | 兼容命令 |
| **21** | `save_workspace_config` | `config: AppConfig` | `Result<(), String>` | 别名命令 | 等价�?`save_app_config` | 兼容命令 |
| **22** | `set_channel_mapping` | `mapping: ChannelMapping` | `Result<(), String>` | `WaveformViewer.vue` | 更新当前时序通道语义映射（Target/Actual/Output）并静默持久化至 `config.json` | 保持不变 |
| **23** | `get_channel_mapping` | �?| `Result<ChannelMapping, String>` | `WaveformViewer.vue` | 读取当前生效的通道语义绑定配置 | 保持不变 |
| **24** | `send_serial_data` | `data: String, is_hex: bool, append_newline: bool` | `Result<(), String>` | `GeneralTerminal.vue`, `QuickCommandPanel.vue` | 发送常规串口数据，支持转义字符解析（`\r`, `\n`）、HEX 校验与换行符自动补全 | 业务层统一封装�?`write` |
| **25** | `diagnose_pid_offline` | `metrics: StepMetrics, current_pid: PidParams` | `Result<AiDiagnosisResult, String>` | `services/ai.ts` | 运行内置离线经典控制理论专家规则引擎，给出诊断与参数调整建议 | 核心离线算法保留 |
| **26** | `score_step_metrics` | `metrics: StepMetrics` | `Result<RadarMetrics, String>` | `App.vue` | 计算阶跃响应四大指标的五维品质雷达得�?(0~100) | 核心算法保留 |
| **27** | `validate_and_apply_pid` | `current_pid: PidParams, new_pid: PidParams` | `Result<String, String>` | `AiTunerPanel.vue` | **SafetyGuard 终极安全防线**：校验范围、单次变动幅度、符号反转，通过后下发指令至串口 | 调参安全核心逻辑保留 |
| **28** | `approve_pid_params` | `current_pid: PidParams, new_pid: PidParams` | `Result<String, String>` | 别名命令 | 等价�?`validate_and_apply_pid` | 兼容命令 |
| **29** | `save_api_key` | `api_key: String` | `Result<(), String>` | 设置模块 | 使用 Windows DPAPI 将大模型 API Key 加密存储�?`secrets.enc` | 桌面凭据安全保护保留 |
| **30** | `get_api_key` | �?| `Result<String, String>` | 设置模块 | �?`secrets.enc` 解密读取大模�?API Key | 桌面凭据安全保护保留 |

---

## 三�? �?Tauri Event 事件通信规范

| 事件名称 | 触发�?| 触发时机与频�?| 负载类型 (Payload) | 前端订阅组件与响应行�?|
|---|---|---|---|---|
| `waveform://batch`<br>*(兼容 `waveform-batch`)* | 后端波形分发协程 | �?16.6ms 周期（~60Hz）定时推送新产生的数�?| `WaveformBatch`（包�?`session_id`, `timestamps`, `series`, `points`�?| `WaveformViewer.vue`：使�?`requestAnimationFrame` 双缓冲入队并渲染曲线，更新实时读数指�?|
| `waveform://reset`<br>*(兼容 `waveform-reset`)* | `reset_pipeline` 命令 | 用户点击清空或重置管线时瞬时广播 | `()` (�? | `WaveformViewer.vue`：清空图�?xData/yData 内存缓冲，视图归�?|
| `logs://batch` | 后端日志分发协程 | �?100ms 周期（~10Hz）定时推送新增文本日�?| `Vec<LogLine>`（包�?`timestamp_us`, `direction`, `level`, `text`, `raw_hex`�?| `App.vue`：推入底栏日志抽屉列表，最多保�?1000 �?|
| `serial://status` | 管线启动、停止、异常断开、重插探�?| 状态发生实质变动时广播 | `SerialStatusEvent`（`is_connected`, `port`, `session_id`, `error`, `reappeared`�?| `App.vue`：更�?`connectionState`、启�?停止按钮外观；若 `reappeared=true`，提示用户设备已重新插入可一键重�?|
| `serial-disconnected` | 物理串口底层读取线程遭遇硬件断开 | 拔出串口线或驱动报错时瞬时广�?| `{"port": string, "reason": string}` | `App.vue`：弹出顶部黄色断开警告 Banner，停止管线运行状�?|
| `serial://reappeared` | 物理串口后台 2 秒轮询探测器 | 拔出后在系统重新枚举到原 COM 端口时广�?| `SerialStatusEvent` | `App.vue`：更新状态为 `reconnecting`，Toast 提示原设备已可用 |
| `step://snapshot`<br>*(兼容 `step-snapshot`)* | 阶跃检测器状态机 | 阶跃捕获完成（进入稳态或 10s 截断）时瞬时触发 | `StepSnapshot`（四大指标、收敛状态、五维得分、时序点切片�?| `SnapshotStream.vue`：推入阶跃切片历史流（最�?0组），自动选中最新快照并触发雷达评分刷新 |

---

## 四、核心业务组件功能现状与行为基准

### 4.1 物理串口管理与热插拔 (Step 2.3 & 2.4)
- **现状实现**：基�?`serialport 4.3` crate。`enumerate_serial_ports()` 自动剥离非数字字符做自然排序，确�?`COM2` 排在 `COM10` 前面�?- **独占保护**：打开物理串口时，若该端口已被其他进程独占，抛出清晰中文错误提�?`无法打开串口 [COMx]: ...`，前端捕获后转入 `error` 状态并弹出 Toast�?- **热插拔保�?*：串口读取线程遭�?`std::io::ErrorKind` 非超时错误（如设备拔出）时，立即向前端发�?`serial-disconnected` �?`serial://status`，随后自动启动后�?2 秒周期的轻量探测协程。当原端口重新出现在系统设备列表中时，发�?`serial://reappeared` 通知前端�?
### 4.2 Mock 虚拟仿真模式 (M1 Step 1.1)
- **物理模型**：基于标准二阶惯性系统积分模拟：$\ddot{y} + 2\zeta\omega_n\dot{y} + \omega_n^2 y = \omega_n^2 u$，默认自然频�?$\omega_n = 4.0\text{ rad/s}$，阻尼比 $\zeta = 0.35$（典型欠阻尼，具�?~25%~30% 明显超调）�?- **控制器积�?*：内�?PID 控制器积分运算（$dt = 0.01\text{s}$�?00Hz），带积分抗饱和限幅�?[-30, +30]$）与输出限幅�?[-50, +50]$）�?- **阶跃触发**：默认自动执�?$0 \to 10 \to 20$ 周期性阶跃变化；支持手动调用 `trigger_step` 触发任意幅值阶跃；支持 `update_pid` 实时修改 PID 参数并观测曲线收敛形态变化�?- **日志偶发混入**：仿真运行中，会在阶跃发生和参数更新时混�?`[INFO] Step Target Changed to: ...` 文本日志，测试分流稳定性�?
### 4.3 数据流三级管线与智能分流 (PRD 2.2 & ADR 0002)
- **第一级（字节与行重组�?*：`process_serial_bytes` 负责�?chunk 截断拼接，以 `\n` 为界切分行，剥离尾随 `\r`；遭遇非 UTF-8 乱码字节静默丢弃并累�?`dirty_data_count`；遭�?>16KB 无换行巨型数据触发清空截断保护�?- **第二级（智能协议分流�?*：`StreamDemuxer` 按优先级逐行扫描�?  1. `>` 开头：转入 Teleplot 解析�?  2. `[`、`#`、`//` �?`INFO:` 等开头：转入日志行解析；
  3. 包含英文逗号 `,`：先尝试纯数�?CSV 解析，若失败且首字段为数字判定为破损 CSV 丢弃并计数；若首字段非数字判定为带逗号文本日志�?  4. 其余文本：转入常规日志行�?- **第三级（多通道路由与聚合）**：数值样本送入 `TimeSeriesRingBuffer` �?`StepDetector`，日志送入 `LogRingBuffer` 与本地文件归�?`SerialArchiveWriter`�?
### 4.4 Teleplot 微秒时序对齐 (PRD 4.1 & engineering-decisions 2.1)
- **错位痛点消除**：单片机逐行发�?`>sp:10\n>act:9.2\n>out:30\n`。`TeleplotAligner` 维护最新变量缓存，在检测到“变量名在当前帧重复出现”或“距上一变量时间差超�?10ms”时，将该组变量一次性对齐打包为同一个时间戳�?`SamplePoint`�?- **稀疏通道机制**：某周期未更新的通道�?`values` 中置�?`None`，序列化�?JSON `null`。在前端与环形缓冲中采用前值保持（Forward Fill）策略，彻底消除波形抖动与锯齿�?- **流结�?Flush**：流结束时强制调�?`flush()`，确保最后一帧完整输出�?
### 4.5 内存环形缓冲与降采样 (engineering-decisions 2.2)
- **固定容量**：波形缓�?`TimeSeriesRingBuffer` 固定�?60,000 点（1kHz �?60 秒）；日志缓�?`LogRingBuffer` 固定�?2,000 行。严禁无上限动态增长，内存恒定�?<50MB�?- **LTTB 降采�?*：`get_waveform_window(start_us, end_us, max_points)` 调用最大三角形三桶算法（LTTB），�?60 秒数十万点切片中提取 1000 个代表点，严格保留极大值波峰与极小值波谷，渲染帧率稳定�?60FPS�?
### 4.6 实时波形可视�?(M2 WaveformViewer)
- **高性能架构**：基�?`uPlot 1.6` Canvas 渲染器，配合前端双缓冲队列与 `requestAnimationFrame` 60FPS 顺滑刷新�?- **通道语义映射**：支持用户在界面自由将数据通道绑定�?Target（目标设定值）、Actual（实际响应值）、Output（控制输出值）。更改后静默持久化至 `config.json`，且 StepDetector 阶跃分析自动同步绑定通道�?- **视图交互**：支持鼠标滚轮对 X 轴无级缩放（最小步�?0.05s），支持鼠标拖拽选框局部放大，支持双击图表一键复位全局视野�?
### 4.7 调试终端交互与底栏日志抽�?(M4 GeneralTerminal)
- **HEX / ASCII 双向格式�?*：常规终端支持文本格式与空格分隔�?HEX 字节串（�?`01 03 00 00 00 02 C4 0B`）无缝切换展示与发送�?- **发送历史翻�?*：终端输入框支持键盘 `ArrowUp` �?`ArrowDown` 键调取最�?50 条发送历史�?- **底栏日志抽屉**：点击工作区底栏可随时展开/收起 2,000 行纯文本日志抽屉；每行日志右侧提供一键“AI 诊断”入口�?
### 4.8 快捷指令与循环发�?(M4 QuickCommandPanel)
- **转义字符解析**：`unescape_ascii` 自动将用户输入的 `\r`, `\n`, `\t`, `\\` 转义为真�?ASCII 字节，末尾可配置是否自动补齐 `\r\n`�?- **Rust 高精度调�?*：支持配�?10ms ~ 60000ms 循环发送，�?Rust 后端 `tokio::time::interval` 执行纳秒级稳定调度，避免前端定时器在窗口后台休眠时被节流�?- **危险指令联动**：快捷指令被标记�?`danger` 时，点击直接联动触发急停通道，防止误发停机指令造成排队滞后�?
### 4.9 硬件校验计算�?(M4 CrcTools)
- **双端对齐算子**：集�?Modbus CRC16（低位在�?LE 与高位在�?BE）、CRC32（IEEE 802.3 标准）、和校验（Sum8 �?0xFF）、异或校验（XOR8）�?- **双向验证与便捷交�?*：前端输�?HEX 或文本时实时运算；提供一键复制与一键“附加至终端发送输入框”功能�?
### 4.10 ADR 0004 急停槽位与全局快捷�?(ADR 0004 & PR-001 W7)
- **安全第一准则**：系统不内置任何特定单片机停机指令。默认状态下槽位为空（`emergency_command: null`）�?- **未配置拦�?*：当槽位未配置时按下急停快捷键，严禁向串口发出任何猜测字节；界面弹出明确警告 Toast，引导用户绑定停机指令�?- **未连接拦�?*：串口断开时触发急停，界面明确提示“急停未送达：串口未连接”，不上报虚假成功�?- **输入框智能避�?*：全局监听空格键（Space），但当焦点处于 `input`、`textarea`、`select` �?`contenteditable` 元素时，严格避让，绝不打断正常文本输入�?- **独立优先发送通道**：急停通道�?Rust 后端拥有独立专属�?`emergency_tx` 优先队列，优先于普通发送队列弹出，绕过普通数据排队延迟�?
### 4.11 阶跃响应切片与四大指标分�?(M3 StepDetector)
- **触发条件**：Target 通道发生 >10% 幅值突变时触发阶跃切片记录�?- **观察窗口**：阶跃发生前 500ms（Pre-Window）提取初始基�?$y_0$；阶跃发生后持续跟踪最�?10s（Max Post-Window）�?- **算法基准（严格遵�?engineering-decisions.md�?*�?  - 上升时间 $t_r$�?10\% \to 90\%$ 幅值穿越时刻的线性插值时间差�?  - 超调�?$M_p$：峰值相对稳态终值的百分�?$\frac{y_{\max} - y_{ss}}{|y_{ss} - y_0|} \times 100\%$�?0.2% 归零）；
  - 调节时间 $t_s$：进�?$\pm 2\%$ 误差带并持续稳定 $\ge 500\text{ms}$ 的起始时刻；若中途冲出则重新计算�?  - 稳态误�?$e_{ss}$：目标值与最�?10% 采样点均值的绝对差�?$|y_{\text{target}} - y_{ss}|$�?
### 4.12 控制品质五维雷达 (M6 MetricRadar)
- **五维评价维度**：超调量得分、响应速度得分、阻尼特性得分、系统鲁棒性得分、稳态精度得分（各项 0~100 分）�?- **视觉呈现**：SVG 动态多边形雷达网，具备 25%�?0%�?5%�?00% 同心基准线与综合控制品质评分�?
### 4.13 AI 调参专家�?SafetyGuard 闭环 (M5 & M6)
- **双模 AI 架构**：支持接�?DeepSeek、OpenAI、Ollama 本地大模型；未配�?Key 或网络超时（>5s）时，无缝自动降级至内置经典控制理论离线规则引擎�?- **结构�?Prompt 与强 Schema 校验**：要求大模型以极简严格 JSON 输出（包�?`diagnosis`, `recommendation: {kp, ki, kd}`, `rationale`, `risk_warning`），格式异常则拦截降级�?- **SafetyGuard 终极安全防线**：大模型给出的建议参数，下发前必须通过 Rust �?`SafetyGuard` 静态检查：
  - 钳位绝对上下限（$K_p \in [0, 100]$, $K_i \in [0, 50]$, $K_d \in [0, 20]$）；
  - 限制单次变动幅度不超过当前参数的 $\pm 50\%$�?  - 严禁符号反转（负参数）；
  - 严禁包含 NaN �?Infinity�?- **人工核准闭环**：AI 参数绝不自动直通单片机，必须在界面呈现对比表与差值（Δ），由工程师手动点击“核准下发设备”按钮后，经 SafetyGuard 校验无误方可发出�?
### 4.14 本地配置与安全凭据持久化 (Step 2.2 & M8)
- **配置持久�?*：应用状态（选中的端口、波特率、模式、Tab、通道映射、快捷指令、AI 端点与模型）实时保存�?`%APPDATA%/LLM-Serial/config.json`，采�?500ms 防抖写入�?- **凭据隔离加密**：用户的云端大模�?API Key 严禁以明文形式写�?`config.json`，调�?Windows 原生 DPAPI 加密隔离写入 `secrets.enc`�?
---

## 五、阶段一重构回归核对�?(Regression Verification Checklist)

在完成阶段一（`ISerialTransport` 统一接口封装、`TauriTransport` 迁移、ESLint 规则限制）后，必须依照下表进�?100% 逐项验收回归�?
| 验证编号 | 功能模块 | 测试前置条件 | 验证操作步骤 | 预期检验结�?| 桌面端回归方�?| 网页端对齐预�?|
|---|---|---|---|---|---|---|
| **RC-001** | 端口枚举与排�?| 本机具备物理或虚拟串�?| 启动应用，观察顶栏端口下拉框 | 串口按自然数字顺序排列（�?COM1, COM2, COM10），非乱�?| 手动检�?UI 下拉�?| 网页端显示已授权端口，未授权引导用户请求 |
| **RC-002** | Mock 虚拟仿真启动 | 未连接状�?| 选择“Mock 仿真源”，点击连接 | 按钮变为红色“断开”，波形图以 100Hz 顺滑更新，指标指�?~100 S/s | `npm run tauri dev` 验证 | 网页�?Worker �?Mock 数据源对�?|
| **RC-003** | 波形 60FPS 双缓冲刷�?| Mock 或串口处于连接状�?| 观察波形曲线绘制 | 曲线平滑推移无卡顿，主线程无阻塞（FPS �?55�?| 浏览�?Performance 录制 | 网页�?requestAnimationFrame 驱动 |
| **RC-004** | 波形视窗滚轮与复�?| 波形图有数据 | 鼠标滚轮缩放；双击图表空白处 | 滚轮按中点缩放时间轴；双击图�?100% 还原全局视野 | 手动操作 | 行为完全一�?|
| **RC-005** | 通道语义动态映�?| 波形模式运行�?| 下拉框切�?Target/Actual/Output 绑定 | 曲线颜色对应关系更新，快照流与雷达依据新通道重新分析 | 手动修改映射 | 行为完全一�?|
| **RC-006** | 历史波形 LTTB 提取 | 积累至少 10 秒以上波�?| 点击“获取历史切片�?| 界面加载历史曲线，波峰波谷极值完好保留，不出现平顶截�?| 点击按钮观测 | 网页�?IndexedDB �?Worker 缓冲提取 |
| **RC-007** | 调试终端 HEX/ASCII 发�?| 串口�?Mock 连接状�?| 输入文本�?HEX 串，点击发送或回车 | 终端出现蓝色 TX 记录，设备收到对应报�?| 检查终端与串口助手回显 | 行为完全一�?|
| **RC-008** | 指令历史上下键翻�?| 终端已发送过 3 条以上不同指�?| 输入框按 `ArrowUp` �?`ArrowDown` | 顺序调出先前指令，光标与文本正常切换 | 键盘按键测试 | 行为完全一�?|
| **RC-009** | 硬件校验计算前后端一�?| 打开常规调试模式 | 在校验工具箱输入 HEX �?| 界面 Modbus CRC16、CRC32、Sum8、XOR8 与后端运�?100% 相同 | 比对工具箱数值与单元测试 | 纯前端直接调�?`crc.ts` |
| **RC-010** | 快捷指令循环发�?| 串口连接状�?| 点击快捷指令“循环发送”勾选框 | 指令按指定周期稳定发出，终端连续打印 TX 记录；取消后停止 | 抓包或终端观�?| 网页端受后台标签页限制，前台工作 |
| **RC-011** | ADR 0004 急停（未配置�?| 清空急停槽位配置 | 在波形或终端任意非输入框区域按空格键 | **严禁发送任何字�?*；弹出警�?Toast 提示未绑定停机指�?| 按空格键验证 | 行为完全一�?|
| **RC-012** | ADR 0004 急停（已绑定�?| 绑定停机指令（如 `CMD:STOP\n`）并连接 | 按空格键 | 急停指令以最高优先级瞬间发出，弹出警�?Toast；物理串口无排队延迟 | 按空格键验证并抓�?| 网页端焦点处于页面时生效 |
| **RC-013** | 急停输入框防误触 | 焦点处于终端或指令输入框�?| 按下空格键打�?| 正常输入空格字符�?*严禁触发急停逻辑** | 在输入框内输入文本带空格 | 行为完全一�?|
| **RC-014** | 阶跃突变切片自动捕获 | 发生目标值阶跃（Mock 自动�?| 等待阶跃过渡完成 | 快照流新增一组卡片，准确标注上升时间 tr、超调量 Mp、调节时�?ts、稳态误�?ess | 观察侧边栏快照列�?| 网页�?Worker �?StepDetector 对齐 |
| **RC-015** | 五维品质雷达图联�?| 选中某个阶跃快照 | 观察侧边栏雷达图 | 雷达图多边形顶点根据该快照得分重绘，展示综合平均�?| 切换不同快照观察 | 行为完全一�?|
| **RC-016** | 离线 AI 专家规则诊断 | 未填写云�?API Key | 点击 AI 调参卡片“请求诊断�?| 秒级返回控制工程离线诊断结论与推�?PID，标注“离线规则�?| 点击按钮验证 | 行为完全一�?|
| **RC-017** | SafetyGuard 防线拦截 | 模拟极端/非法 PID 建议（负数或过大�?| 触发下发核准 | �?Rust �?SafetyGuard 拦截，弹出红色警告，禁止向串口发�?| 单元测试与手动注�?| 网页端在 Worker 前置 SafetyGuard 校验 |
| **RC-018** | AI 建议参数人工核准下发 | 正常诊断结果生成 | 点击“核准下发设备�?| 发送标�?`PID kp ki kd\n` 指令，当�?PID 更新，提示下发成�?| 观察终端与串口抓�?| 行为完全一�?|
| **RC-019** | 单行报错日志 AI 诊断 | 抽屉日志出现 Warn/Error �?| 点击该行右侧“AI 诊断�?| 弹出诊断弹窗，给出简明故障根因分析与排查建议 | 点击日志诊断按钮 | 行为完全一�?|
| **RC-020** | 底栏日志抽屉展开与清�?| 运行中产生多行日�?| 点击底栏展开抽屉；点击“清空日志�?| 抽屉平滑滑出；日志清空，界面恢复整洁 | 点击交互 | 行为完全一�?|
| **RC-021** | 串口热插拔断线告�?| 物理串口已连�?| 物理拔掉 USB 串口�?| 200ms 内弹出黄色断开告警，停止管线运行状态，终端提示断开原因 | 拔出硬件测试 | 网页端监�?`disconnect` 事件对齐 |
| **RC-022** | 串口热插拔重插恢复提�?| 串口拔出告警�?| 重新插回同一 USB 串口�?| 2 秒内后台探测到原 COM 口，弹出重连提示 Toast，状态变为可重连 | 插回硬件测试 | 网页端监�?`connect` 事件对齐 |
| **RC-023** | �?chunk 截断拼接 | 串口流以任意字节片断到达 | 输入测试数据�?`04_chunk_boundary_half_line` | �?chunk 割裂的逗号、标签与数值无损重组，无畸变乱�?| 运行 `cargo test` 验证 | 网页端流测试集比�?|
| **RC-024** | 乱码容错与超长行防护 | 串口流包含乱码与 >16KB 数据 | 输入测试数据�?`05` �?`06` | 非法 UTF-8 静默丢弃并计数；超长行清空截断；紧随其后的正常数据完整解�?| 运行 `cargo test` 验证 | 网页端流测试集比�?|
| **RC-025** | 本地配置防抖自动保存 | 更改串口端口、波特率、模�?| 更改后重启应�?| 上次选择的端口、波特率、模式与通道映射 100% 自动还原 | 重启应用观察 | 网页端保存在 IndexedDB 中对�?|

---

## 六、基线确认结�?
经对 `src/` �?`src-tauri/` 全部源文件、IPC 命令、事件机制与自动化测试套件的全面静态分析与动态测试验证：
1. **现有功能完备�?*：串口驱动、三级数据管线、uPlot 波形引擎、常规终端、快捷指令、CRC 工具箱、ADR 0004 急停通道、阶跃分析器、五维雷达、AI 调参闭环及凭据配置系统全部正常就绪，梳理确认全部 30 �?IPC 命令�?7 个事件通道�?2. **测试验证现状**�?2 项单元测试与 7 项黄金数据集集成测试全部通过（共 89 项测试，0 失败），前端构建零类型报错�?3. **重构就绪声明**：本功能基线清单�?`tests/fixtures/stream/` 测试数据集正式生效，已完全满足【阶段零：基线确认与回归保护】的准出条件，可立即推进进入【阶段一：串口传输抽象层设计】�?