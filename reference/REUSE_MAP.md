# 旧源码复用索引

本索引用于从归档的 LLM串口工程查找可参考的 AI 逻辑、数学计算、字节编码和验证材料。**当前暂不实施 VOFA 插件或伴随服务。** 历史文档中的计划、下一步和未完成项不代表当前任务授权。迁移时仍需核对目标 VOFA 版本、官方接口和实际数据来源，不能从旧源码存在推定插件可用。

以下链接相对于本文件，旧工程固定保存在 `legacy-llm-serial/`。保留原有源码、脚本、测试与锁文件的内部路径，方便以后有明确任务时恢复或抽取。测试记录、合成服务、原生程序与真实硬件验收分别理解。

## AI 证据与建议

| 入口 | 可以参考什么 | 宿主耦合与测试 |
| --- | --- | --- |
| [debugAssistant.ts](legacy-llm-serial/src/core/assistant/debugAssistant.ts) | 通道摘要、结构化回复解析、动作白名单与命令草稿校验 | 依赖旧协议类型和命令编码器；控件/协议建议需要新宿主实现。测试：[debug-assistant](legacy-llm-serial/tests/debug-assistant.test.ts)。 |
| [evidenceSelection.ts](legacy-llm-serial/src/core/assistant/evidenceSelection.ts) | 冻结选区、统计与限量原始点、数据来源/时基声明、用户主动上传、取消后结果失效 | 快照输入与元数据需由新宿主提供；旧会话 ID、epoch、generation 要重新映射。测试：[assistant-evidence-selection](legacy-llm-serial/tests/assistant-evidence-selection.test.ts)。 |
| [DebugAssistantPanel.vue](legacy-llm-serial/src/components/DebugAssistantPanel.vue) | 任务 → 证据预览 → 分析 → 审阅建议的交互流程 | Vue 界面依赖 ChannelStore、选区 store、widget store；可参考流程，不能直接当作 VOFA 控件。应用回调见 [App.vue](legacy-llm-serial/src/App.vue)。 |

日志脱敏和限量证据位于下节 `ai.ts` 的 `prepareLogEvidence`。选区语义与合成验证说明见 [波形证据与回放分析](legacy-llm-serial/docs/WAVEFORM_EVIDENCE_2026-10-01.md)。

## 模型请求与配置

| 入口 | 可以参考什么 | 宿主耦合与测试 |
| --- | --- | --- |
| [ai.ts](legacy-llm-serial/src/services/ai.ts) | 统一模型请求、端点处理、Ollama/兼容服务、超时取消、错误脱敏、模型发现 | 桌面路径依赖 Tauri invoke；网页路径直接 fetch。新宿主需独立处理密钥与网络。测试：[ai-models](legacy-llm-serial/tests/ai-models.test.ts)。 |
| [tuningAgent.ts](legacy-llm-serial/src/services/tuningAgent.ts) | 反馈候选请求、输入证据检查、待审核传递函数草稿、响应校验 | 依赖旧 TuningPlan、场景、配置签名和数学边界；AI 不获得设备执行权。测试：[tuning-agent-config](legacy-llm-serial/tests/tuning-agent-config.test.ts)、[tuning-feedback-evidence](legacy-llm-serial/tests/tuning-feedback-evidence.test.ts)。 |
| [Rust AI client](legacy-llm-serial/src-tauri/src/ai/client.rs) / [secrets.rs](legacy-llm-serial/src-tauri/src/secrets.rs) / [config.rs](legacy-llm-serial/src-tauri/src/config.rs) | 旧原生请求、密钥保护与配置持久化 | Windows/Tauri 与旧数据目录耦合；新工程不能直接沿用旧配置、密钥或应用身份。 |

## 调参数学与数据分析

优先抽取纯计算函数，再决定是否保留旧 UI、场景和持久化。名义模型、仿真预测和设备实测必须区分。

| 入口 | 内容 | 对应测试 |
| --- | --- | --- |
| [solvePid.ts](legacy-llm-serial/src/core/control/solvePid.ts) / [transferFunction.ts](legacy-llm-serial/src/core/control/transferFunction.ts) / [computeBode.ts](legacy-llm-serial/src/core/control/computeBode.ts) | 模型校验、本地 PID 候选与频域计算 | [bode-precision](legacy-llm-serial/tests/bode-precision.test.ts)、[tuning-engine](legacy-llm-serial/tests/tuning-engine.test.ts) |
| [cascadeModel.ts](legacy-llm-serial/src/core/control/cascadeModel.ts) / [loopBandwidth.ts](legacy-llm-serial/src/core/control/loopBandwidth.ts) / [bandwidthChecker.ts](legacy-llm-serial/src/core/control/bandwidthChecker.ts) | 串级模型与带宽经验检查；不能证明整机稳定 | [cascade-model](legacy-llm-serial/tests/cascade-model.test.ts)、[scenario-cascade-model](legacy-llm-serial/tests/scenario-cascade-model.test.ts)、[bandwidth-policy](legacy-llm-serial/tests/bandwidth-policy.test.ts) |
| [identifyPlant.ts](legacy-llm-serial/src/core/control/identifyPlant.ts) / [simulateClosedLoop.ts](legacy-llm-serial/src/core/control/simulateClosedLoop.ts) / [simulationComparison.ts](legacy-llm-serial/src/core/control/simulationComparison.ts) | 对象辨识、闭环预测与对照证据 | [simulation-comparison](legacy-llm-serial/tests/simulation-comparison.test.ts)、[step-features](legacy-llm-serial/tests/step-features.test.ts) |
| [alignTelemetry.ts](legacy-llm-serial/src/core/tuning/alignTelemetry.ts) / [stepResponse.ts](legacy-llm-serial/src/core/tuning/stepResponse.ts) / [feedbackEvidence.ts](legacy-llm-serial/src/core/tuning/feedbackEvidence.ts) | 遥测同步、单次阶跃条件、当前参数对应的观察窗口 | [tuning-alignment](legacy-llm-serial/tests/tuning-alignment.test.ts)、[tuning-step-response](legacy-llm-serial/tests/tuning-step-response.test.ts)、[tuning-feedback-evidence](legacy-llm-serial/tests/tuning-feedback-evidence.test.ts) |
| [analysis-worker-client.ts](legacy-llm-serial/src/services/analysis/analysis-worker-client.ts) / [analysis-worker-protocol.ts](legacy-llm-serial/src/services/analysis/analysis-worker-protocol.ts) | 分析任务、取消与来源边界 | [analysis-worker](legacy-llm-serial/tests/analysis-worker.test.ts)、[analysis-history](legacy-llm-serial/tests/analysis-history.test.ts) |

场景和候选管理见 [scenarios.ts](legacy-llm-serial/src/core/tuning/scenarios.ts)、[engine.ts](legacy-llm-serial/src/core/tuning/engine.ts)。新数据接口必须重新核对单位、时基、采样质量和工作点。

## 协议与命令

| 入口 | 可以参考什么 | 对应测试/资料 |
| --- | --- | --- |
| [command-encoder.ts](legacy-llm-serial/src/services/transport/command-encoder.ts) / [commandContract.ts](legacy-llm-serial/src/core/tuning/commandContract.ts) | 文本/HEX 编码、转义、行尾、最终字节预览和载荷校验 | [command-encoder](legacy-llm-serial/tests/command-encoder.test.ts)、[tuning-command-contract](legacy-llm-serial/tests/tuning-command-contract.test.ts) |
| [ProtocolEngine.ts](legacy-llm-serial/src/core/protocol/ProtocolEngine.ts) / [协议类型](legacy-llm-serial/src/core/protocol/types.ts) / [Rust protocol.rs](legacy-llm-serial/src-tauri/src/protocol.rs) | 旧解析器、分块与错误处理；新宿主已有解析时避免重复维护 | [protocol-engine](legacy-llm-serial/tests/protocol-engine.test.ts)、[黄金样本](legacy-llm-serial/tests/fixtures/binary-protocol.json) |
| [protocolCapabilities.ts](legacy-llm-serial/src/core/tuning/protocolCapabilities.ts) | 调参确认与协议能力检查 | [tuning-protocol-capabilities](legacy-llm-serial/tests/tuning-protocol-capabilities.test.ts)、[固件接入指南](legacy-llm-serial/docs/firmware-integration.md) |

## 执行安全

首版只读 AI 助手可不搬设备执行。若以后恢复自动调参，以下边界必须重新设计并验证；宿主能画波形不代表提供设备参数确认或硬件停机。

| 入口 | 保护边界 | 对应测试/资料 |
| --- | --- | --- |
| [execution-lease.ts](legacy-llm-serial/src/core/tuning/execution-lease.ts) / [flow.ts](legacy-llm-serial/src/core/tuning/flow.ts) | 执行归属、候选/授权/确认状态与停止条件 | [tuning-execution-lease](legacy-llm-serial/tests/tuning-execution-lease.test.ts)、[tuning-confirmed-context](legacy-llm-serial/tests/tuning-confirmed-context.test.ts)、[执行归属说明](legacy-llm-serial/docs/EXECUTION_OWNERSHIP_2026-10-01.md) |
| [write-correlation.ts](legacy-llm-serial/src/core/tuning/write-correlation.ts) / [write-quiescence.ts](legacy-llm-serial/src/services/transport/write-quiescence.ts) | 写入回执、ACK/参数回读关联与队列排空 | [tuning-write-correlation](legacy-llm-serial/tests/tuning-write-correlation.test.ts)、[write-quiescence](legacy-llm-serial/tests/write-quiescence.test.ts)、[ACK 接收顺序](legacy-llm-serial/docs/ACK_RECEIVE_ORDER_2026-10-01.md) |
| [cascadeDependencies.ts](legacy-llm-serial/src/core/tuning/cascadeDependencies.ts) / [sendGate.ts](legacy-llm-serial/src/core/widget/sendGate.ts) / [safetyGuard.ts](legacy-llm-serial/src/core/widget/safetyGuard.ts) | 内环依赖、发送门禁、数值限制 | [cascade-dependencies](legacy-llm-serial/tests/cascade-dependencies.test.ts)、[send-gate](legacy-llm-serial/tests/send-gate.test.ts) |

[TuningWorkbench.vue](legacy-llm-serial/src/components/TuningWorkbench.vue) 和 [transport/session.ts](legacy-llm-serial/src/services/transport/session.ts) 展示旧端到端集成，但强依赖 ChannelStore、传输会话、普通写入状态及 UI。适合查调用关系，不建议整块移植。软件 STOP 不等于设备物理停机。

## 测试与恢复入口

- [tests/](legacy-llm-serial/tests/)：单元测试、浏览器合成 harness 与协议夹具；保留 [register-ts-loader.mjs](legacy-llm-serial/tests/register-ts-loader.mjs) 和 [ts-resolver.mjs](legacy-llm-serial/tests/ts-resolver.mjs)。
- [Rust tests/](legacy-llm-serial/src-tauri/tests/)：原生协议夹具；Rust 模块内另有单元测试。
- [mock-assistant-service.mjs](legacy-llm-serial/scripts/mock-assistant-service.mjs) / [mock-scenario-service.mjs](legacy-llm-serial/scripts/mock-scenario-service.mjs)：固定合成 AI 响应，不代表实际服务质量。
- [run-checks.mjs](legacy-llm-serial/scripts/run-checks.mjs) / [test-widget-core.mjs](legacy-llm-serial/scripts/test-widget-core.mjs)：旧检查聚合入口；运行会生成证据目录，完整检查还包含依赖审计。
- [package.json](legacy-llm-serial/package.json) / [旧 README](legacy-llm-serial/README.md)：仅在明确恢复旧应用时，从归档工程目录执行旧 npm 命令。旧 dev/build/tauri 入口不是 VOFA 插件启动或构建入口。
- [build-portable.mjs](legacy-llm-serial/scripts/build-portable.mjs) / [tauri.conf.json](legacy-llm-serial/src-tauri/tauri.conf.json)：旧 LLM串口桌面包构建参考；归档整理不需要运行。
- [旧交接说明](legacy-llm-serial/MODEL_HANDOFF_2026-09-28.md)：阅读历史状态时优先参考；文件名不是正文更新日期，也不代表当前验收。

需要重新运行旧测试时，先明确目标范围并恢复对应依赖。目录链接存在、源码检查通过、合成测试通过和实机验收完成是不同结论。
