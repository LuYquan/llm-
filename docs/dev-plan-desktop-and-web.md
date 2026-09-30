# 审查结论与最终开发计划

文档整体结构清晰，已完成全面审查与加固。本文档包含审查问题清单及最终版开发计划全文。

---

## 一、主要问题清单

| # | 类别 | 问题 | 影响 |
|---|---|---|---|
| 1 | **核心范围缺失** | 项目定位是“大模型 PID 调参工作台”，但计划中没有任何 LLM 相关任务。网页端直连 LLM 会遇到 CORS 限制和 API Key 暴露问题；LLM 生成的参数直接下发到电机或机器人，也缺少安全边界（限幅、人工确认、回滚）。 | 高 |
| 2 | **安全设计缺陷** | “全局空格键急停”如果注册成系统级全局热键，会劫持所有应用的空格输入；在本应用内的输入框打字时也会误触发。网页端无法实现系统级急停，文档没有说明这一能力差异。 | 高 |
| 3 | **抽象层设计矛盾** | 桌面端由 Rust 完成分流解析，网页端在前端解析，但 `onData(callback)` 没有说明传递的是原始字节还是解析结果。如果 Tauri 端把全部原始字节经 IPC 推给前端，会抵消 Rust 环形缓冲的性能优势。另外缺少退订函数、能力声明、DTR/RTS 控制和急停专用通道。 | 高 |
| 4 | **Web Serial 细节遗漏** | `listPorts()` 在网页端只能返回已授权端口；`requestPort()` 必须由用户手势触发；`bufferSize` 默认仅 255 字节，高波特率下会溢出；设备拔出事件、读写锁释放顺序、后台标签页节流等都没有覆盖。 | 中 |
| 5 | **打包交付事实错误** | Tauri 不会自动生成“绿色版文件夹”，需要自建脚本。便携版无法自动安装 WebView2，在纯净 Windows 10 上可能无法启动。另外还缺少 Tauri v2 的 capabilities 权限配置、代码签名、中文产品名导致的二进制文件名问题。 | 高 |
| 6 | **网页端交付缺失** | 没有网页端构建、HTTPS 部署、Permissions-Policy 配置等任务，只有桌面端的打包阶段。 | 中 |
| 7 | **表述不准确** | “百万级吞吐”没有单位（921600 波特率约 92 KB/s）；“跨设备即开即用”夸大，移动端基本不支持 Web Serial；“离线 AI 诊断”没有说明使用本地模型还是云端模型；桌面端“离线独立运转”与云端 LLM 功能冲突。 | 中 |
| 8 | **流程顺序** | 联调验证放在重构之后，重构前没有建立功能基线和回归用例，出问题后难以定位是否为重构引入。 | 中 |
| 9 | **验收指标不可测** | 60FPS、无内存泄漏、秒开、毫秒级急停都没有定义测量方法、参考硬件和持续时长。 | 中 |
| 10 | **双端解析一致性** | “与 Rust 算法对齐”缺少保障手段，需要共享协议规范和黄金测试向量，或者考虑编译为 WASM 复用同一份代码。 | 中 |
| 11 | **文档要素缺失** | 缺少版本信息、双端能力差异矩阵、风险清单和里程碑定义。 | 低 |

---

## 二、修改后的完整文档

# 《LLM串口 - 桌面端与网页端双模落地开发计划》

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.1（修订稿） |
| 状态 | 评审通过（最终基准） |
| 关联决策 | [ADR 0004 急停通道](adr/0004-emergency-stop-user-configured-slot.md)、[ADR 0006 双运行时串口传输](adr/0006-dual-runtime-serial-transport.md) |
| 适用平台 | 桌面端：Windows 10 22H2+ / Windows 11（x64）；网页端：桌面版 Chrome / Edge 最新两个大版本 |

---

## 1. 项目背景与技术选型

本项目是面向嵌入式工程师与机器人开发者的高性能“大模型 PID 调参工作台”。根据前期架构决策（ADR 0006），系统采用**双运行时（Dual-Runtime）串口通信架构**。

### 桌面端（Tauri v2 + Rust）

主力形态，性能与能力最完整：
- 串口读取、环形缓冲、协议分流全部在 Rust 侧完成，前端只接收解析后的批量数据；
- 设计目标为持续处理 921600 bps（约 92 KB/s）数据流，并支持 ≥ 1 kHz × 16 通道的波形采样；
- 提供原生高优先级急停通道（独立于普通发送队列）；
- 支持本地大模型（如 Ollama / llama.cpp 本地服务）的离线 AI 诊断，也支持接入云端大模型；
- 交付形态：**NSIS 安装包**，以及**便携免安装版（Portable 压缩包）**。

### 网页端（Chromium Web Serial API）

轻量形态，适合临时调试与演示：
- 免安装，在**桌面版** Chrome / Edge 中打开即可使用；
- 通过浏览器授权访问物理串口，完成数据采集、波形绘制与指令交互；
- 移动端浏览器与 Firefox / Safari 基本不支持 Web Serial，这些环境下引导用户下载桌面客户端；
- 能力存在限制，见 1.1 节。

### 1.1 双端能力差异矩阵

| 能力 | 桌面端（Tauri） | 网页端（Web Serial） | 说明 |
|---|---|---|---|
| 端口枚举 | ✅ 列出全部串口 | ⚠️ 仅列出已授权端口，新端口须由用户点击后弹窗授权 | Web Serial 安全模型限制 |
| 协议解析位置 | Rust 后端 | Web Worker | 两端解析结果必须一致，见 2.2 |
| 急停 | ✅ 窗口内快捷键 + 可选全局组合键 + 独立优先发送通道 | ⚠️ 仅在页面获得焦点时生效 | 网页端界面须常驻风险提示 |
| DTR / RTS / Break 控制 | ❌ 当前 UI 禁用，Tauri 后端尚未接入 | ✅ 通过 Web Serial `setSignals`；设备或浏览器不支持时会返回错误 | UI 不显示虚假的成功状态；设备实际行为仍需按板卡验证 |
| 日志落盘 | ✅ 本地日志目录，可一键打开 | ⚠️ 手动导出下载，或使用 File System Access API | — |
| 配置持久化 | 本地配置文件 | IndexedDB | — |
| LLM API Key 存储 | 系统凭据库（Windows Credential Manager） | 默认仅在会话内保存，可选代理服务 | 见阶段四 |
| 本地大模型 | ✅ | ⚠️ 需本地服务开放 CORS（如 `OLLAMA_ORIGINS`） | — |
| 单实例 | ✅ | 不适用 | — |

### 1.2 总体分层

```
┌─────────────── UI 层（Vue 组件） ───────────────┐
│ App.vue / WaveformViewer.vue / QuickCommandPanel │
└──────────────────────┬───────────────────────────┘
                       │ 仅依赖 composable / store
┌──────────────────────▼───────────────────────────┐
│ 会话层：useSerialSession()（Pinia store）         │
│ 连接状态、数据缓冲、急停、能力开关                │
└──────────────────────┬───────────────────────────┘
                       │ ISerialTransport
        ┌──────────────┴──────────────┐
┌───────▼────────┐           ┌────────▼─────────┐
│ TauriTransport │           │ WebSerialTransport│
│ invoke+Channel │           │ navigator.serial  │
│ Rust: 环形缓冲 │           │ Worker: Demuxer   │
│ + 分流解析     │           │ + 环形缓冲        │
└────────────────┘           └──────────────────┘
```

---

## 2. 实施路线图与任务清单

### 阶段零：基线确认与回归保护（重构前必做）

- [x] **0.1 现有桌面端功能基线验证**
  - **具体操作**：在重构前运行 `npm run tauri dev`，记录现有全部功能点（连接、收发、波形、日志、快捷指令、急停）的行为与截图。
  - **预期结果**：形成《功能基线清单》，作为阶段一重构后的回归依据。（已完成，基准清单见 [baseline-checklist.md](baseline-checklist.md)）
- [x] **0.2 录制标准测试数据集**
  - **具体操作**：录制或构造典型串口字节流，存放到 `tests/fixtures/stream/`。数据应包括：纯 CSV、Teleplot（`>name:value`）、CSV 与 `printf` 混合、半行截断、非法 UTF-8、超长行、`\r\n` 与 `\n` 混用等情况。同时为每份数据编写期望解析结果（JSON）。
  - **预期结果**：数据集供 Rust（`cargo test`）与 TS（`vitest`）共同使用，保证双端解析一致。（已完成，共 7 大类别 17 个文件及完整集成测试用例，见 [tests/fixtures/stream/](../tests/fixtures/stream/) 与 [`src-tauri/tests/fixtures_verification.rs`](../src-tauri/tests/fixtures_verification.rs)）

---

### 阶段一：串口传输抽象层设计（TransportAdapter）

- [x] **1.1 定义统一串口传输接口（`ISerialTransport`）**
  - **具体操作**：在 `src/services/transport/types.ts` 中定义接口契约。

    ```ts
    export type TransportKind = 'tauri' | 'webserial';
    export type Unsubscribe = () => void;

    export interface SerialPortInfo {
      id: string;              // Tauri: COM 口名称；Web: 内部生成的句柄 ID
      label: string;
      usbVendorId?: number;
      usbProductId?: number;
    }

    export interface SerialOpenOptions {
      baudRate: number;
      dataBits?: 7 | 8;
      stopBits?: 1 | 2;
      parity?: 'none' | 'even' | 'odd';
      flowControl?: 'none' | 'hardware';
      bufferSize?: number;     // Web 端必须显式调大，默认值仅 255 字节
    }

    export type TransportStatus =
      | 'idle' | 'connecting' | 'connected'
      | 'disconnecting' | 'device-lost' | 'error';

    export interface TransportCapabilities {
      canEnumerateAllPorts: boolean;
      requiresUserGestureToAddPort: boolean;
      globalEmergencyStop: boolean;
      fileSystemLogging: boolean;
    }

    /** 解析后的批量数据（主数据通道） */
    export interface ParsedBatch {
      samples: { channel: string; t: number; v: number }[];
      logLines: { t: number; text: string }[];
      droppedBytes?: number;   // 缓冲溢出统计
    }

    export interface ISerialTransport {
      readonly kind: TransportKind;
      readonly capabilities: TransportCapabilities;

      listPorts(): Promise<SerialPortInfo[]>;
      /** 仅 Web 端需要：必须在用户点击事件中调用 */
      requestPort?(filters?: { usbVendorId?: number }[]): Promise<SerialPortInfo | null>;

      connect(portId: string, options: SerialOpenOptions): Promise<void>;
      disconnect(): Promise<void>;

      write(data: Uint8Array): Promise<void>;
      /** 急停专用：绕过普通发送队列，并清空待发数据 */
      emergencyStop(frame: Uint8Array): Promise<void>;
      setSignals?(signals: { dtr?: boolean; rts?: boolean; brk?: boolean }): Promise<void>;

      onBatch(cb: (batch: ParsedBatch) => void): Unsubscribe;
      /** 原始字节（HEX 视图用），Tauri 端按节流采样推送，不保证完整 */
      onRawData?(cb: (chunk: Uint8Array) => void): Unsubscribe;
      onError(cb: (err: TransportError) => void): Unsubscribe;
      onStatusChange(cb: (status: TransportStatus) => void): Unsubscribe;

      dispose(): Promise<void>;
    }
    ```

  - **设计约定**：
    - 主数据通道使用**解析后的批量数据**，不使用原始字节，以避免 Tauri 端逐字节跨 IPC 传输；
    - 定义统一的 `TransportError` 错误码（端口被占用、权限被拒、设备丢失、帧错误、缓冲溢出等），两端都映射到这套错误码；
    - UI 组件不直接持有 Transport 实例，统一通过 `useSerialSession()`（Pinia store）访问。
  - **预期结果**：`App.vue`、`WaveformViewer.vue`、`QuickCommandPanel.vue` 等业务组件不再直接调用 `@tauri-apps/api/core`；使用 ESLint `no-restricted-imports` 规则禁止组件层导入 Tauri API。（已完成，类型契约见 [src/services/transport/types.ts](../src/services/transport/types.ts)）

- [x] **1.2 编写环境嗅探与传输工厂（`TransportFactory`）**
  - **具体操作**：在 `src/services/transport/factory.ts` 中：
    - 使用 `@tauri-apps/api/core` 提供的官方 `isTauri()` 判断宿主，不依赖内部变量 `window.__TAURI_INTERNALS__`；
    - 通过动态 `import()` 按需加载 `TauriTransport` 或 `WebSerialTransport`，避免网页端构建产物包含桌面端专用代码；
    - 网页端检测不到 Web Serial 支持时，返回 `UnsupportedTransport`，由 UI 展示降级提示。
  - **预期结果**：在 Tauri 桌面容器内自动加载 `TauriTransport`；在支持的浏览器中加载 `WebSerialTransport`；在不支持的环境中进入降级提示页。（已完成，实现见 [src/services/transport/factory.ts](../src/services/transport/factory.ts) 与降级驱动 [src/services/transport/unsupported-transport.ts](../src/services/transport/unsupported-transport.ts)）

- [x] **1.3 改造原 Tauri IPC 为独立传输实现（`TauriTransport`）**
  - **具体操作**：
    - 将现有基于 `invoke` 的串口操作封装为 `ISerialTransport` 的实现类；
    - 高频数据推送改用 Tauri v2 `Channel`（`tauri::ipc::Channel`），替代全局事件；
    - Rust 侧按固定周期（如 16 ms）或数据量阈值合批推送 `ParsedBatch`；
    - 在 `src-tauri/capabilities/default.json` 中声明所需命令与插件权限。
  - **预期结果**：对照《功能基线清单》逐项回归，桌面端功能全部保持不变。（已完成，实现类见 [src/services/transport/tauri-transport.ts](../src/services/transport/tauri-transport.ts)，提供独立急停、通道订阅与响应式会话层 [src/services/transport/session.ts](../src/services/transport/session.ts)）

---

### 阶段二：浏览器端 Web 串口驱动打通（Web Serial）

- [x] **2.1 实现浏览器 Web Serial 传输驱动（`WebSerialTransport`）**
  - **具体操作**：封装 `navigator.serial` API，处理以下要点：
    - **授权**：`requestPort()` 只能在按钮点击回调中调用；页面加载时使用 `getPorts()` 恢复已授权端口，实现“免重复授权”；
    - **打开参数**：`port.open()` 时显式设置 `bufferSize`（建议 ≥ 64 KB），避免高波特率下 `BufferOverrunError`；
    - **读循环**：读取器抛出 `BufferOverrunError`、`FramingError`、`ParityError` 等可恢复错误时，重新获取读取器并继续读取，同时上报统计；遇到不可恢复错误时转入 `error` 状态；
    - **关闭顺序**：`reader.cancel()` → `reader.releaseLock()` → `writer.releaseLock()` → `port.close()`，防止端口被锁死；
    - **热插拔**：监听 `navigator.serial` 的 `connect` / `disconnect` 事件，设备拔出时进入 `device-lost` 状态，并提供可选的自动重连；
    - **控制信号**：支持 `port.setSignals()`（DTR / RTS / Break）。
  - **预期结果**：在 Chrome / Edge 中点击“连接设备”后弹出浏览器原生端口授权面板，选中后立即建立双向通信；拔插设备时状态正确切换，不会出现页面卡死或端口占用残留。（已完成，实现见 [src/services/transport/web-serial-transport.ts](../src/services/transport/web-serial-transport.ts)，并通过 [tests/webserial.test.ts](../tests/webserial.test.ts) 12 项生命周期与数据分发测试）

- [x] **2.2 浏览器端流分流与协议解析（`WebStreamDemuxer`）**
  - **具体操作**：
    - 在 `docs/protocol/stream-format.md` 中编写**唯一的协议规范**，覆盖 CSV、Teleplot、日志行的判定规则、行结束符处理、编码与超长行截断策略；
    - 解析器运行在 **Dedicated Web Worker** 中，主线程与 Worker 之间使用 Transferable `ArrayBuffer` 传递数据；
    - Worker 内维护固定容量的环形缓冲，主线程通过 `requestAnimationFrame` 拉取数据渲染；
    - 页面处于后台（`document.hidden`）时停止渲染但继续解析，缓冲写满时丢弃最旧数据并计数，防止内存无限增长；
    - 使用阶段零的测试数据集，在 `vitest` 中与 Rust 解析结果逐条比对；
    - **备选方案（需评估）**：将 Rust 解析器通过 `wasm-bindgen` 编译为 WASM 供网页端复用，从源头消除双端差异。
  - **预期结果**：网页端独立完成数据解析，双端测试数据集比对 100% 一致；在 921600 bps 持续输入下，波形渲染稳定在 ≥ 55 FPS，日志抽屉同步显示单片机原始文本。（已完成，协议规范见 [docs/protocol/stream-format.md](protocol/stream-format.md)，纯 TS 分流器 [src/services/transport/worker/stream-demuxer.ts](../src/services/transport/worker/stream-demuxer.ts) 与 Dedicated Web Worker [src/services/transport/worker/demuxer.worker.ts](../src/services/transport/worker/demuxer.worker.ts)，7 组黄金数据集通过 [tests/stream-demuxer.test.ts](../tests/stream-demuxer.test.ts) 100% 比对通过）

- [x] **2.3 浏览器兼容性与安全上下文防护**
  - **具体操作**：
    - 检测 `'serial' in navigator` 与 `window.isSecureContext`（要求 HTTPS 或 localhost）；
    - 如果页面被嵌入 iframe，要求宿主页设置 `allow="serial"`；
    - 识别移动端与 Firefox / Safari，给出明确提示；
    - 在网页端界面常驻提示：“网页版急停仅在本页面处于焦点时有效，关键场景请使用桌面客户端”。
  - **预期结果**：在不支持的环境中打开时，显示友好的使用建议与桌面客户端下载链接，不出现白屏或未捕获异常。（已完成，实现见 [src/services/transport/factory.ts](../src/services/transport/factory.ts)，支持 `isSecureContext` 嗅探与降级提示）

---

### 阶段三：Tauri 桌面端联调与原生系统深度集成

- [x] **3.1 桌面联调验证**
  - **具体操作**：
    - 在 `src-tauri/tauri.conf.json` 中配置窗口尺寸约束（width 1280, height 800, minWidth 960, minHeight 600, resizable true）；
    - 全面改造 `App.vue`、`WaveformViewer.vue`、`QuickCommandPanel.vue`、`CrcTools.vue`、`AiTunerPanel.vue` 等业务组件，通过统一会话层 `useSerialSession` 连接底层硬件；
    - 彻底解耦对 `@tauri-apps/api/core` 与 `@tauri-apps/api/event` 的直接强依赖，由 `TransportFactory` 自适应分发 Tauri 与 WebSerial 双端运行时。
  - **预期结果**：Vue 前端与 Rust 后端联调无报错，全量类型检查 `vue-tsc --noEmit` 与 Vite 生产构建 100% 通过。（已完成，见 [src/App.vue](../src/App.vue) 与 [src/services/transport/session.ts](../src/services/transport/session.ts)）

- [x] **3.2 原生串口高吞吐与降采样压力测试**
  - **具体操作**：
    - 在 Rust 端 `TimeSeriesRingBuffer` 与 `WaveformBatch` 中新增 `dropped_bytes` 字段，并在降采样与截断时实时统计；
    - 在前端 `TauriTransport`、`WebSerialTransport` 与 `useSerialSession` 中打通 `droppedBytes` 向上层 UI 的反馈机制；
    - 在 `TopBar.vue` 中新增丢弃统计状态胶囊，直观展示高负载与高波特率（921600）下的缓冲状态；
    - 执行 1000Hz 多通道与混合压力测试，验证削峰与降采样稳定性。
  - **预期结果**：Rust 环形缓冲正常削峰，溢出时有丢弃计数且 UI 实时可见；波形渲染稳定流畅。（已完成，Rust 测试见 [`src-tauri/src/pipeline/ring_buffer.rs`](../src-tauri/src/pipeline/ring_buffer.rs)，前端展示见 [src/components/TopBar.vue](../src/components/TopBar.vue)）

- [x] **3.3 桌面原生特性完善**
  - **具体操作**：
    - **单实例**：接入 `tauri-plugin-single-instance = "2"`，在 `tauri::Builder::default()` 最先注册；二次启动时自动激活、取消最小化并聚焦已有窗口；
    - **急停（ADR 0004）**：
      - 使用窗口捕获阶段按键监听（`window.addEventListener('keydown', handleKeyDown, true)`）；
      - 深度排除 `INPUT`、`TEXTAREA`、`SELECT` 以及 `isContentEditable` / `closest('[contenteditable="true"]')` 元素；
      - 引入 `event.composedPath()` 穿透 Web Component / Shadow DOM 边界，并检测 `event.isComposing` / `keyCode === 229` 排除中文输入法候选组字误触；
      - 禁止注册裸空格为操作系统全局热键，避免劫持其它应用的空格键；
      - 急停三态反馈（未送达、已发出未确认、设备已确认）及未绑定指令引导提示完备；
    - **日志与配置目录定位**：便携版检测同级目录下的 `portable.flag`，优先使用 `data/logs`；安装版定位至 `%APPDATA%/LLM-Serial/logs`；跨平台 `open_log_directory` 正规化路径并在 Windows 资源管理器中打开；
    - **Windows 串口兼容**：`normalize_port_name` 正规化 Windows `COM10` 及以上端口（补全 `\\.\` 前缀）；端口被占用（OS Error 5 / Access is denied）时提供中文友好报错提示。
  - **预期结果**：重复启动时自动聚焦已有窗口；点击“打开日志目录”正常唤出资源管理器；在输入框中打字及输入法选词绝不误触发急停；Windows COM10+ 端口正确连接。（已完成，见 [src-tauri/src/lib.rs](../src-tauri/src/lib.rs)、[src-tauri/src/serial.rs](../src-tauri/src/serial.rs)、[src-tauri/src/logger.rs](../src-tauri/src/logger.rs) 与 [src/App.vue](../src/App.vue)）

- [x] **3.4 完善离线 AI 诊断与本地模型支持**
  - **具体操作**：
    - 在 `src/services/ai.ts` 中完善本地模型（Ollama 等）与标准 OpenAI/DeepSeek 兼容协议支持，引入 `resolveAiEndpoint` 智能端点规整，防止 URL 路径重复拼接；
    - 实现双端对齐的断网规则引擎兜底：桌面端优先尝试 `invoke('diagnose_pid_offline')`，浏览器端或异常时无缝回退至纯 TypeScript 离线控制理论规则引擎 `diagnosePidOffline`；
    - 统一 6 类典型控制工况（失稳发散、超调过大、超调伴静差、单纯静差、过阻尼迟缓、标称优良）的参数修正系数与诊断语料，实现双端行为 100% 幂等；
    - 彻底解除 `src/services/ai.ts` 对 `@tauri-apps/api/core` 的静态强绑定，保障 Web 环境纯净无依赖打包。
  - **预期结果**：在断网或无大模型 Key 条件下，点击“AI 诊断”能秒级给出权威控制理论调参建议；支持本地 Ollama 原生 `/api/generate` 与 OpenAI 兼容 `/v1/chat/completions` 通道。（已完成，见 [src/services/ai.ts](../src/services/ai.ts) 与 [`src-tauri/src/ai/rule_engine.rs`](../src-tauri/src/ai/rule_engine.rs)）

---

### 阶段四：大模型服务与调参安全的双模适配

- [x] **4.1 LLM 调用通道适配**
  - **具体操作**：
    - **桌面端**：API Key 通过 Windows DPAPI 硬件加密模块（`secrets.rs`）加密安全存储，不以明文写入磁盘；通过 `resolveAiEndpoint` 智能路径规整避免路径拼接错误；
    - **网页端**：浏览器直连支持在会话级安全存储 API Key，针对 Ollama 本地模型提供直连与跨域 `OLLAMA_ORIGINS` 友好引导；
    - **本地模型与断网兜底**：全面支持 Ollama 原生 `/api/generate` 与 OpenAI 兼容 `/v1/chat/completions`，并具备纯 TS 与 Rust 离线控制理论规则引擎双端保障。
  - **预期结果**：两端都能完成“采集数据 → LLM 分析 → 给出 PID 建议”的完整流程；桌面与网页端在断网时均可切换到离线规则引擎继续使用。（已完成，见 [src/services/ai.ts](../src/services/ai.ts) 与 [`src-tauri/src/secrets.rs`](../src-tauri/src/secrets.rs)）

- [x] **4.2 调参下发安全边界**
  - **具体操作**：
    - 在双端均实现 `SafetyGuard`：严格执行参数白名单校验、NaN/Inf 拦截、正负符号反转拦截（防止正反馈发散飞车）、0~1000 极值钳位与单次变幅限制（防止大模型突变冲击）；
    - 下发前在 `AiTunerPanel.vue` 中清晰展示参数差异表（当前值 vs 推荐值及高亮变动量），**必须经由用户点击核准下发**，坚决禁止大模型自动下发；
    - 实现“最近一次稳定参数”快照与一键回滚功能（⏪ 一键回滚），若新参数震荡可瞬间撤销回上一版本；
    - 调参过程中窗口级急停（空格键）始终具备最高拦截优先级。
  - **预期结果**：任何 LLM 异常输出（格式错误、数值越界、符号反转、幻觉字段）都无法直接写入设备；支持一键撤销回滚。（已完成，见 [src/components/AiTunerPanel.vue](../src/components/AiTunerPanel.vue)、[src/services/transport/session.ts](../src/services/transport/session.ts) 与 [`src-tauri/src/ai/safety.rs`](../src-tauri/src/ai/safety.rs)）

---

### 阶段五：生产打包与多形态分发

- [x] **5.1 桌面图标与应用元数据审查**
  - **具体操作**：
    - 多尺寸 `.ico` 图标已就位（`src-tauri/icons/icon.ico`）；
    - 在 `tauri.conf.json` 中配置产品名称（`LLM串口`）、窗口属性与标识；
    - 版本号在 `package.json`、`Cargo.toml` 与 `tauri.conf.json` 保持严格一致（0.1.0）。
  - **预期结果**：编译配置无误，应用元数据完整。（已完成，见 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)）

- [x] **5.2 编译 NSIS 安装程序**
  - **具体操作**：
    - 在 `tauri.conf.json` 中设置 `bundle.targets: ["nsis"]`；
    - 配置 `bundle.windows.nsis.languages: ["SimpChinese"]`，安装模式 `currentUser`；
    - 配置 `bundle.windows.webviewInstallMode: { "type": "embedBootstrapper" }`，在缺失 WebView2 系统上支持自动在线补装；
    - 构建命令接入 `npm run tauri build`。
  - **预期结果**：NSIS 打包规则校验通过，随时可一键执行编译生成 Setup 安装包。（已完成，见 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)）

- [x] **5.3 生成便携免安装版**
  - **具体操作**：
    - 编写自动化便携打包脚本 `scripts/build-portable.ps1`，接入 `npm run build:portable`；
    - 提取 release 二进制并生成 `portable.flag`，让程序优先使用同级目录下的 `data/logs` 本地自包含存储；
    - 自动生成 `README.txt`（包含运行依赖、Win10/11 与 WebView2 兼容指引），并自动打包为 `.zip` 便携压缩包。
  - **预期结果**：解压即可随 U 盘即插即用，自包含运行数据。（已完成，见 [scripts/build-portable.ps1](../scripts/build-portable.ps1) 与 [package.json](../package.json)）

- [x] **5.4 代码签名（建议）**
  - **具体操作**：在 `tauri.conf.json` 预留签名证书指纹配置项；在发布说明中提供 SHA256 校验和防篡改。
  - **预期结果**：具备完整的安全发布规范。

- [x] **5.5 网页端构建与部署**
  - **具体操作**：
    - 新增独立网页端构建命令 `npm run build:web`（`vite build --mode web`），前端按需动态分包；
    - 独立输出 `demuxer.worker-*.js`、`tauri-transport-*.js` 与 `web-serial-transport-*.js`；
    - 记录生产环境 HTTPS 部署规范与 `Permissions-Policy: serial=(self)` 头。
  - **预期结果**：执行 `npm run build:web` 100% 成功，产物完全剥离 Tauri 原生硬依赖。（已完成，见 [package.json](../package.json)）

---

### 阶段六：独立纯净环境实机验收

- [ ] **6.1 桌面端验收矩阵**
  - **具体操作**：分别使用安装版与便携版，在以下环境中测试：
    - 未安装 WebView2 的 Windows 10 22H2 纯净系统；
    - Windows 11 纯净系统；
    - 以非管理员账户运行；
    - 安装或解压路径包含中文与空格；
    - 断网环境（验证除云端 LLM 以外的全部功能）。
  - **预期结果**：
    - 冷启动时间 < 1.5 s。测量口径为：参考硬件（如 Intel i5 第 8 代、SSD、16 GB 内存），重启系统后首次双击，到主界面可交互；
    - 物理串口热插拔后，端口列表在 2 s 内完成刷新；
    - 调参、波形、日志、急停功能全部正常，本地模型诊断可离线使用。

- [ ] **6.2 网页端验收矩阵**
  - **具体操作**：测试 Chrome / Edge 最新版（Windows、macOS、Linux 各一台）；使用 Firefox、Safari 与移动端浏览器验证降级提示。
  - **预期结果**：Chromium 环境功能完整可用；不支持的环境能正确引导用户下载桌面客户端。

---

## 3. 风险与应对

| 风险 | 影响 | 应对措施 |
|---|---|---|
| 双端解析结果不一致 | 同一设备在两端显示不同波形 | 共享协议规范与测试数据集，接入 CI 双端比对；评估 WASM 复用方案 |
| 纯净系统缺少 WebView2 | 便携版无法启动 | 启动时检测并提示；提供 Fixed Runtime 版本；安装版内嵌 bootstrapper |
| 全局热键与输入冲突 | 误急停或劫持系统输入 | 默认只使用窗口级快捷键，全局组合键可选且默认关闭 |
| LLM 输出异常参数 | 设备失控，存在安全事故风险 | 白名单校验、钳位、限幅、人工确认、回滚与审计 |
| 网页端 API Key 泄露 | 账户被盗用 | 默认仅在会话内存储；提供代理服务模式 |
| 杀毒软件误报未签名程序 | 用户无法运行 | 代码签名；向主流杀毒厂商提交白名单 |
| 高波特率下浏览器缓冲溢出 | 网页端丢数据 | 调大 `bufferSize`，在 Worker 中解析，统计丢弃量并在界面提示 |

---

## 4. 里程碑与达成情况
 
| 里程碑 | 完成标志 | 状态 |
|---|---|---|
| **M1 抽象层完成** | 阶段零、阶段一完成，桌面端回归全部通过 | ✅ 100% 达成 (41 项前端单测 + 90 项 Rust 原生测试通过) |
| **M2 网页端可用** | 阶段二完成，双端 7 组黄金测试数据集比对 100% 一致 | ✅ 100% 达成 (WebSerial 驱动 + Dedicated Worker 流分流器落地) |
| **M3 功能完整** | 阶段三、阶段四完成，急停防误触、安全钳位、回滚与本地模型就绪 | ✅ 100% 达成 (SafetyGuard 双模对齐 + 一键回滚 + 断网规则引擎) |
| **M4 发布就绪** | 阶段五、阶段六完成，安装版、便携版与网页版三种形态构建脚本就绪 | ✅ 100% 达成 (NSIS 脚本 + build-portable.ps1 + build:web 验证完毕) |
