# ADR 0006: 采用双运行时串口传输适配架构（Tauri 原生 + 浏览器 Web Serial API）

- **状态 (Status)**: 已接受 (Accepted)
- **日期 (Date)**: 2026-09-24
- **决策人 (Deciders)**: 架构团队、使用者反馈

---

## 1. 背景与问题陈述 (Context)

项目最初定位为深度集成 Rust 后端的高性能桌面应用（基于 Tauri v2），利用 Rust `serialport` 与 `tokio` 管道提供百万级吞吐与微秒级延迟。  
然而，在实际工程使用场景中，使用者经常通过标准浏览器（Chrome / Edge）直接打开预览或在受限机器（未安装客户端/无权限安装软件）上调试单片机。使用者明确提出：**在浏览器中打开时也需要具备连接串口并进行完整调试使用的同等能力**。

因此，系统需要在“原生桌面极致性能”与“现代浏览器即开即用”之间建立统一的架构支撑。

---

## 2. 备选方案权衡 (Alternatives & Trade-offs)

### 方案 A：强依赖 Tauri 桌面，Web 模式直接阻断
- **优点**：仅维护一套 Rust 后端数据管线，逻辑最简单。
- **缺点**：丧失 Web 端免安装、跨设备分享和轻量化现场排障的灵活性，不满足使用者诉求。

### 方案 B：纯 Web 化（完全放弃 Tauri，仅使用 Web Serial API）
- **优点**：单一代码库，纯前端搞定。
- **缺点**：丢失 Rust 原生生态优势（如本地文件系统快速存盘、高吞吐内存环形缓冲、系统托盘、全局急停高优先级进程响应、离线 MCP 端点服务等）。

### 方案 C（选定）：双运行时统一适配器（TransportAdapter 抽象层）
- **方案描述**：
  1. 定义统一的前端串口通信接口 `ISerialTransport`（包含 `listPorts`、`connect`、`disconnect`、`send`、`onData` 等）。
  2. 实现两个驱动驱动实现类：
     - `TauriTransport`：在桌面环境下激活，通过 `invoke` 调用 Rust 后端，享受最高性能与完整系统权限。
     - `WebSerialTransport`：在普通浏览器环境下激活，基于 W3C `navigator.serial` API，直接在浏览器中与物理串口通信，并在前端/Worker 跑轻量分流器。
  3. 运行时根据 `window.__TAURI_INTERNALS__` 自动嗅探当前宿主环境，无缝切换对应适配器。
- **代价**：前端需实现一套轻量级的流分流与波形解析逻辑（或复用 WASM/TS 模块），用于在缺少 Rust 后端时的解析支撑。

---

## 3. 决策内容 (Decision)

1. **架构抽象**：在前端服务层引入 `TransportAdapter` 工厂，对外暴露统一的串口生命周期事件与数据流。
2. **桌面优先**：在 Tauri 运行时下默认走 Rust 原生通道，支持离线 AI、本地文件快速落盘及全局安全急停；
3. **网页同权**：在非 Tauri 浏览器（支持 Web Serial 的 Chromium 内核）下，自动降级为浏览器 Web Serial 通信，允许用户授权 COM 口直接采集与调参。
4. **统一 UI**：上层界面（波形图、调参卡片、底栏日志抽屉）完全与底层传输解耦，无感知底层是 Rust 还是 Web Serial。

---

## 4. 影响与后续结果 (Consequences)

- **正面影响**：
  - 极大提升工具可用性，既能作为免安装 Web 工具在任何电脑的 Chrome/Edge 上插线即用，又能作为高稳定性桌面客户端安装使用。
  - 用户体验统一，学习成本为零。
- **负面影响 / 应对**：
  - Web Serial 仅支持 Chromium 系浏览器（Chrome、Edge、Opera），在 Safari/Firefox 上需弹出清晰的“请使用 Chrome/Edge 浏览器或下载桌面客户端”的浏览器兼容指引。
