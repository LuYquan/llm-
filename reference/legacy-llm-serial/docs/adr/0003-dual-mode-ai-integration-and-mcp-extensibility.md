# ADR 0003: 双模 AI 体系与 MCP (Model Context Protocol) 生态扩展架构

- **状态 (Status)**: 已接受 (Accepted)
- **日期 (Date)**: 2026-09-22
- **决策人 (Deciders)**: 架构师团队

---

## 1. 背景与问题陈述 (Context)

在传统的调参工具或 Serial-Studio 类软件中，AI 功能要么完全缺位，要么仅作为软件内部的一个封闭小插件存在。然而现代嵌入式与机器人工程师的开发工作流通常发生在 IDE（如 VS Code、Cursor）或专有 AI 助手（如 Claude Desktop、Antigravity）中：
- 工程师在 IDE 中编写控制代码与 PID 固件；
- 若调参工具只能在自己的封闭 UI 内部点按钮，工程师必须在 IDE 和调参软件之间频繁切屏、人工搬运数值；
- Serial-Studio 商业版探索了通过外部自动化接口与外部系统联动的思路。

如何设计 AI 接入架构，既保证普通用户开箱即用的极简闭环体验，又能让高级开发者无缝将工具能力融入 IDE 中的 AI Agent 体系？

---

## 2. 备选方案权衡 (Alternatives & Trade-offs)

### 方案 A：纯应用内内置闭环（In-App Closed Loop Only）
- **优点**：结构最简单，完全自给自足。
- **缺点**：工具成为信息孤岛，无法与开发者的外部 AI 编程工作流（如 Cursor/Claude）协同。

### 方案 B：纯 MCP Server 代理模式（Pure MCP Server Headless）
- **优点**：完全由外部 AI 驱动，无多余 UI 逻辑。
- **缺点**：门槛高，普通用户必须配置外部 Agent 客户端才能使用，失去了开箱即用的傻瓜式体验。

### 方案 C（选定）：双模 AI 体系（内置开箱即用 + 架构预留 MCP Server）
- **优点**：
  - **模态一（开箱即用）**：工作台右侧内置“AI 调参专家卡片”，输入当前阶跃指标，直接在界面上呈现推理过程与一键核准下发按钮。
  - **模态二（生态扩展）**：Rust 后端核心逻辑天然抽象为通用工具函数（`get_step_metrics`、`get_recent_waveform`、`write_pid_gains`）。在阶段五打通轻量本地 MCP Server 端点（stdio 或 SSE），让外部 IDE 中的 AI 助手可以直接调用。
- **代价**：底层控制与数据分析层必须保持极度纯粹，绝不能与前端 UI 状态强耦合，必须做清晰的 Clean Architecture 分层。

---

## 3. 决策内容 (Decision)

1. **核心计算逻辑独立化**：Rust 端的阶跃特征提取（`StepAnalyzer`）和参数下发（`SafetyGuard + SerialWrite`）必须是独立的无状态函数/服务，既供 Tauri IPC 调用，也可供未来的 MCP Server 调用。
2. **两阶段演进计划**：
   - 第一阶段（阶段一至四）：聚焦打通应用内内置 AI 调参卡片闭环；
   - 第二阶段（阶段五）：新增 MCP Server 模块，对外暴露标准化 Tool 协议。

---

## 4. 影响与后续结果 (Consequences)

- “LLM串口”不仅是一个可视化的调参上位机，更成为嵌入式硬件与大语言模型之间的标准“硬件遥测与控制上下文桥梁（Hardware Context Bridge）”。
- 为后续支持“AI 自动调参并自动修改单片机 C 源码里的默认宏定义”等高级联动场景打下坚实的生态基础。
