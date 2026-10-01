# 场景协议执行与写入关联

核对日期：2026-10-01。本文记录当前源码中的执行契约、可复现的软件验证步骤和待验收边界。具体测试结果、冻结源码身份、构建编号、产物哈希及 CI 状态由各轮独立回执记录；本文不表示本轮已通过全部测试或已完成正式发行。

固件配置步骤、CSV / Teleplot / JustFloat 字节示例和变量单位核对见[下位机接入与场景反馈指南](firmware-integration.md)。场景依赖与观察窗口见[串级依赖及反馈窗口](SCENARIO_CASCADE_2026-10-01.md)。

## 冻结最终发送字节

场景参数命令由用户提供，没有通用默认 PID 写命令。模板支持 `{id}`、`{order}`、`{kp}`、`{ki}`、`{kd}`、`{request_id}`；控件的 `{val}` / `{value}` 属于另一套模板。候选生成时先展开命令，再冻结以下契约：

| 契约字段 | 用途 |
| --- | --- |
| `sourceText` | 当前候选的完整展开命令，不裁剪协议空白 |
| `format.escapeText` | 是否把支持的文本转义转换为实际字符 |
| `format.lineEnding` | `none` / `lf` / `cr` / `crlf` |
| `visibleText` | 最终 UTF-8 字节解码后的可见转义文本，包括控制和格式字符 |
| `hex`、`byteLength` | 最终发送字节的 HEX 与字节数 |

格式由用户在场景设置中选择；未显式设置的既有计划默认使用“解析转义 + CRLF”。命令已经以 CR 或 LF 结尾时不再次追加行尾。候选页与逐轮人工授权显示最终可见文本、HEX、字节数和格式；有界自动实验在授权范围内逐轮生成并校验同一契约。

执行前重新核对命令、格式、HEX、长度与预览是否一致，并产生独立的 `Uint8Array`。`App` 把这份已审核字节传入 `session.write`，不再对文本进行第二次转义或追加行尾。软件验证通过只说明发送内容与审核契约一致，不说明固件接受、应用或控制效果安全。

历史候选缺少有效 `commandPayload` 时，保留历史参考但禁止发送；不能仅凭历史命令字符串补出发送权限。修改计划或切换通道 generation 后，旧候选也需重新生成和审核。

实现依据：[字节契约](../src/core/tuning/commandContract.ts)、[共享编码器](../src/services/transport/command-encoder.ts)、[候选与授权界面](../src/components/TuningWorkbench.vue)、[App 发送入口](../src/App.vue)、[历史会话存储](../src/core/tuning/sessionStore.ts)。

## 协议能力与真实通道绑定

文本 ACK 只适用于 FireWater 实时文本路径。JustFloat、数值 RawData 和 CustomFrame 需要使用独立参数数值通道回读，或逐轮人工核对；二进制数值流中不能直接混入 ASCII ACK。RawData 原始显示模式不产生数值遥测，不能直接用于反馈调参。有界自动实验要求可关联的自动确认方式。

目标、实际反馈、控制输出以及当前确认或基线模式使用的活动参数通道，必须绑定当前连接中出现的精确原始 ID。显示别名、未出现的 ID 或重复指向同一真实变量的绑定被拒绝。每个使用中的角色必须有独立原始 ID；只有改显示名称不能建立独立数据来源。这项检查授予不了设备授权，也替代不了单位、方向、数值范围和遥测新鲜度核对。

离线模型计算仍可以在没有设备、通道和 AI 服务时完成；它生成未下发、未实机验证的候选。执行能力限制在设备反馈和写入阶段复核。

实现依据：[协议与通道能力检查](../src/core/tuning/protocolCapabilities.ts)、[ChannelStore](../src/core/channel/ChannelStore.ts)、[场景工作台](../src/components/TuningWorkbench.vue)。

## 派发、驱动回执与设备确认分别关联

单轮命令至少包含两种不同身份：命令里的 `protocolRequestId` 用于固件应答关联，驱动的 `writeRequestId` 用于写入回执关联。它们不能互相代替。连接的 session / epoch 以及通道 generation 同样参与当前状态核对。

| 阶段 | 冻结或验证的证据 | 不能据此断言的事情 |
| --- | --- | --- |
| 派发起点 | 主机 `startedAt`、RX 日志 ID 水位、各参数通道 ingestion revision 水位、通道 generation | 设备已收到或应用 |
| 驱动回执 | 当前请求、相同 session / epoch、独立完成时间及 `written` 状态；排队路径还需最终完整字节回执 | 参数已在固件生效 |
| 设备确认 | 本轮新 ACK 或新参数回读，结合有效 `written` 和当前身份 | 物理响应达标 |
| 观察评价 | 当前已确认参数对应的完整、新鲜遥测窗口 | 模型预测等于实机结果 |

FireWater 的 ACK 必须是派发日志水位之后的新 RX 行；该行去除首尾空白后，要与成功应答模板展开后的**完整文本相等**，模板须包含本轮协议请求 ID。例如预期 `PID_APPLIED <本轮ID>` 时，旧 ID、通用 `OK`、额外前后文本、`NOT PID_APPLIED <本轮ID>` 或较长的相似 ID 都不能自动确认。可用的主机接收时间还需不早于派发起点。

参数回读要求各活动参数的 ingestion revision 严格大于派发水位、属于本轮 generation、接收时间不早于派发起点，并按配置容差比较候选值。旧值的订阅回调即使延迟到达，也不会仅凭“回调刚到”成为本轮回读。

ACK 或一次性参数回读可以先进入前端，随后才收到驱动 `written` 回执。只要接收证据确实越过派发水位、身份相符，并最终得到有效 `written`，无需固件重复发送才能完成确认。派发时间、接收时间和回执完成时间各自记录；两次前端回调的主机时间戳和顺序不证明设备因果顺序，不能强制用“回读发生在回执回调之后”代替上述关联。

实现依据：[写入关联谓词](../src/core/tuning/write-correlation.ts)、[通道 ingestion revision](../src/core/channel/ChannelStore.ts)、[工作台确认状态机](../src/components/TuningWorkbench.vue)、[App 回执处理](../src/App.vue)。

## 实验锁等待驱动队列结束

普通命令的 JavaScript 调用返回 `queued`，仅证明驱动接收了排队请求。当前 session 的写入跟踪器在调用驱动前登记尝试，随后核对回执请求、session / epoch 和字节数；排队项必须收到相同身份的最终 `written`，且 requested / written 字节数完整一致，才退出待完成状态。最终事件早于 `queued` 返回时，跟踪器暂存并关联事件，不把这种回调顺序误判为未写完。

`App` 开始场景执行时，先取得普通发送门的实验锁，再等待 `session.waitForWriteQuiescence(5000)`。仅跟踪器确认当前连接无待完成项、无未知错误且软件停止未锁定，才开放本轮参数写入权。失败、部分写入、缺失身份、超时或等待期间连接 / 解析会话变化，会产生可见错误并阻止取得写入权。写入队列排空仍只证明驱动完成，不证明固件参数或执行器状态。

普通终端、快捷指令、控件等设备命令提交会递增普通写入 revision，同步撤销当前参数确认、保守稳定基线确认和旧观察窗口，作废待发送候选。需要等待驱动队列明确结束，再重新核对基线并收集窗口；已有历史不能恢复当前设备证据。

排队、未知状态或软件停止锁定时，基线确认、AI 反馈候选和反馈执行入口受阻。离线模型计算仍可使用。未知或失败写入会保留错误状态；仅点击恢复发送或切换解析协议不能替代重新连接及设备核对。

实现依据：[写入跟踪器](../src/services/transport/write-quiescence.ts)、[session 接线](../src/services/transport/session.ts)、[普通发送门](../src/core/widget/sendGate.ts)、[App 锁交接](../src/App.vue)、[基线与普通写入 revision](../src/components/TuningWorkbench.vue)。

## 未确认写入后停止

如果命令已经派发而设备确认尚未完成，停止意味着设备状态可能已经改变。当前参数确认、稳定基线确认和本次设备评价依据被撤销；历史参数与窗口仅作参考。迟到的 ACK、回读或回执不能自动恢复当前态、继续下发或把已停止实验标成完成。

恢复发送还需匹配当前软件停止版本：恢复请求等待期间发生新的停止时，旧恢复回执不能解除新锁。此时驱动可能已经恢复，本机仍保持锁定并报告需要重新核对，不能据此声称原生屏障仍锁住或设备已停机。

调用软件停止入口即同步锁定本机新增发送。后续编码、传输初始化或驱动停止屏障失败时，保留本机锁并显示失败；只有驱动停止操作成功后，才能按实际返回状态说明待发项清理或已配置停止字节的提交。原生锁状态刷新返回 `false` 不会解除本机锁，只有显式 `resumeWrites` 成功才解锁。本机锁不证明既有驱动项已经撤回、停止命令已经送达或执行器已经停机；这些状态和恢复策略仍需实机核对及设备独立保护。

实现依据：[场景停止与证据清理](../src/components/TuningWorkbench.vue)、[软件停止屏障](../src/services/transport/session.ts)。

## 可执行的软件验证步骤

在已安装锁文件依赖的源码目录启动独立夹具服务：

```powershell
node tests/browser/tuning-harness.vite.mjs
```

打开 `http://127.0.0.1:5191/tests/browser/tuning-harness.html`，使用“准备所选用例”检查组件与授权弹窗，或点击“运行全部合成交互”。端口固定为 5191；夹具只允许自己的独立来源，使用合成设置和合成会话，服务结束用 Ctrl+C。页面显示冻结字节、协议事件及机器可读结果。

当前夹具列出以下 11 项，作为冻结后应重新执行并保存回执的预期矩阵；这里不预先填写通过结果。

| 用例 ID | 可执行预期 |
| --- | --- |
| `ack-two-rounds` | 两轮新 ACK 与各自窗口驱动评价，第二轮不复用基线窗口 |
| `ack-before-receipt` | 精确本轮 ACK 先到、有效 written 后到可以确认 |
| `readback-before-receipt` | 本轮一次性参数回读先到、有效 written 后到可以确认 |
| `old-ack` | 旧协议请求 ID 不确认当前写入 |
| `old-readback` | 派发前 ingestion revision 不确认当前候选 |
| `failed-write` | 驱动失败，即使精确 ACK 到达也不能确认 |
| `stop-last-window` | 最后观察窗口等待时停止，不变成 completed |
| `stop-unconfirmed` | 下一次命令已派发未确认时停止，旧设备确认与基线失效 |
| `binary-ack-gate` | JustFloat 配置文本 ACK 时，执行入口阻止写入 |
| `ordinary-ready-gate` | 普通写入未明确结束时，不能确认基线、请求反馈 AI 或启动实验 |
| `ordinary-revision-invalidation` | 普通命令提交使已有基线、稳定保护确认及观察窗口失效 |

夹具挂载真实 Vue `TuningWorkbench`，使用共享 `ProtocolEngine` / `ChannelStore`、调参服务和本地 HTTP 模型响应；驱动、遥测、设备应答及授权点击均为合成。夹具的通道布局不能当作实时 demuxer 的 CSV 通道规范。它不直接验证 `App` 到原生驱动的完整接线，也不是 native UI、真实串口、硬件闭环或在线 AI 验收。

字节契约、ACK 完整行拒绝、canonical 绑定与写入队列顺序还应结合软件测试复核：

```powershell
npm run test:widget
npm run test:tuning
npm run test:write-queue
npm run test:transport
```

软件测试入口及夹具源码：[调参引擎测试](../tests/tuning-engine.test.ts)、[最终字节测试](../tests/tuning-command-contract.test.ts)、[写入关联测试](../tests/tuning-write-correlation.test.ts)、[协议能力测试](../tests/tuning-protocol-capabilities.test.ts)、[队列测试](../tests/write-quiescence.test.ts)、[Vue 夹具](../tests/browser/tuning-harness.ts)、[夹具服务](../tests/browser/tuning-harness.vite.mjs)。构建门槛和命令范围见 [README](../README.md)。

本轮需在运行时源码冻结后重跑适用的软件检查和这 11 项交互，并把结果与同次源码身份绑定到独立回执。后续仍需实机核对原始字节、固件成功 / 失败应答、一次性回读、排队 / 断连 / 部分写入、软件停止及真实执行器保护；在线 AI、原生交互和正式发行状态分别记录。
