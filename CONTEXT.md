# 领域统一术语表 (Ubiquitous Language / Context)

本文档记录“LLM串口”系统中的核心业务概念与统一领域词汇，作为系统架构与代码命名的一致性基准。

---

## 1. 通信与会话领域 (Communication & Session)

| 术语 (Domain Term) | 英文标识 | 概念定义与业务语义 |
| :--- | :--- | :--- |
| **设备会话** | `DeviceSession` | 针对特定物理单片机或机器人控制器的连接配置集合，包含通信端口（COMx/BLE UUID）、波特率、通道映射、被控对象预设及历史 PID 快照。 |
| **会话管理器** | `SessionManager` | 负责多设备会话的增删改查、配置持久化（LocalStorage/SQLite）以及断线自动重连。 |
| **数据源** | `DataSource` | 统一的底层硬件 I/O 抽象 trait，封装具体的硬件物理传输（SerialPort、BLE、Mock 仿真源）。 |
| **原始日志抽屉** | `LogDrawer` | 界面底部可折叠的控制台终端，用于捕获和显示单片机上送的非波形文本日志（如 `[INFO]`、`[ERROR]`）以及十六进制原始报文。 |
| **流分流器** | `StreamDemuxer` | Rust 核心数据管线中的智能分路器，负责在单物理串口流中实时甄别波形数值行与系统文本日志行，分别派发至不同处理管道。 |
| **日志环形缓冲** | `LogRingBuffer` | Rust 内存中的文本日志队列（固定容量，如保留最近 2000 行），支持节流向前端推送，防止高频刷屏卡顿。 |
| **快捷指令** | `QuickCommand` | 工程师预设的一键发送文本或 HEX 报文（如 `RST\n`、`CALIB\n`），支持一键点击下发。 |

---

## 2. 数据管线与控制分析领域 (Data Pipeline & Control Analysis)

| 术语 (Domain Term) | 英文标识 | 概念定义与业务语义 |
| :--- | :--- | :--- |
| **数据管线** | `DataPipeline` | 从原始字节流到可视化与 AI 诊断的处理链路：`InputSource -> Parser -> RingBuffer/Decimator -> StepAnalyzer -> UI/AI`。 |
| **自动嗅探器** | `ProtocolSniffer` | 协议识别引擎，自动区分行文本 CSV 流、Teleplot 键值流、纯文本日志与二进制帧。 |
| **阶跃响应指标** | `StepResponseMetrics` | 从时序测量数据中自动计算出的控制工程量化指标，包含超调量 ($M_p$)、调节时间 ($t_s$)、上升时间 ($t_r$)、稳态误差 ($e_{ss}$) 与阻尼比估算。 |
| **被控对象模型** | `PlantModel` | 硬件系统的物理分类（如两轮自平衡车直立环、FOC 速度环、倒立摆），用于指导 AI 调参专家的物理推理方向。 |
| **语义绑定** | `SemanticBinding` | 将物理未知的数据通道映射为具体的控制逻辑身份（如 Target 目标值、Actual 实际响应、Output 控制输出），是阶跃特征提取的前置条件。 |
| **阶跃快照** | `StepSnapshot` | 由底层算法引擎在捕获到一次完整阶跃响应后，自动生成的包含原始数据截段与已计算指标的只读不可变记录包。 |

---

## 3. AI 专家与安全闭环领域 (AI & Safety Guard)

| 术语 (Domain Term) | 英文标识 | 概念定义与业务语义 |
| :--- | :--- | :--- |
| **AI 调参建议** | `TuningSuggestion` | LLM 根据阶跃指标输出的下一轮结构化推荐参数，遵循“建议而非提交（Suggest, Do Not Commit）”准则。 |
| **核准下发** | `ApproveAndCommit` | 工程师对 AI 建议进行人工审查确认后，将新参数打包为控制指令写入单片机的操作。 |
| **安全限幅器** | `SafetyGuard` | 软件本地最后的安全防线，在下发前检查参数是否存在极值、NaN 或符号反转，防止大模型幻觉导致硬件飞车。 |
| **紧急急停** | `EmergencyStop` | 全局最高优先级发送通道（空格键触发），**发送内容由使用者按自己硬件配置**，默认未绑定。未绑定时按键只给出明确提示且**不发出任何字节**；已绑定时跳过审批/限幅/冷却，但不跳过物理现实（未连接、未确认均须如实上报）。绝不自动声称设备已停机。详见 [ADR 0004](docs/adr/0004-emergency-stop-user-configured-slot.md)。 |
| **MCP 端点** | `McpEndpoint` | 基于 Model Context Protocol (MCP) 的标准对外服务接口，允许外部智能体（如 Cursor、Claude Desktop、Antigravity）远程调用波形指标查询与参数回写工具。 |
| **双模 AI 体系** | `DualModeAi` | 兼具“应用内一键调参交互卡片”与“外部 IDE 智能体通过 MCP 协同控制”的混合架构设计。 |
