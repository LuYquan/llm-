# VOFA AI 插件项目

更新：2026-10-02（Asia/Shanghai）。

**接下来要做的是构建 VOFA AI 插件，不再继续开发独立 AI 串口助手软件。** 用户使用现有 VOFA 连接设备、收发数据和查看波形；本项目通过插件加入 AI 调试与调参辅助，并按需配套 AI 服务。

旧独立串口工作台已整理到 `reference/legacy-llm-serial/`，仅用于查阅和复用。接手后应围绕 VOFA 插件开展新开发，不按旧工程的路线图继续开发、修复或发布独立串口助手。目前已完成目录整理和交接文档准备，插件代码尚未开始。

## 从这里开始

1. [项目范围](PRODUCT.md)：当前目标与职责。
2. [开发准备与接口依据](docs/DEVELOPMENT_PREPARATION.md)：已找到的接口、接入前待验证项和官方资料。
3. [旧代码复用索引](reference/REUSE_MAP.md)：按功能查找源码、测试与设计依据。
4. [交接说明](docs/HANDOFF.md)：后续开发者应先知道的状态与边界。
5. [整理记录](maintenance/2026-10-02-vofa-transition/REPORT.md)：移动、删除、保留及校验结果。

## 目录

```text
README.md / PRODUCT.md / DESIGN.md / CONTEXT.md / CONTRIBUTING.md
  当前方向、术语、职责及协作入口
docs/
  当前 VOFA AI 开发准备与交接说明
reference/
  README.md                 旧工程与历史资料导航
  REUSE_MAP.md               按能力检索旧代码
  legacy-llm-serial/         旧 Vue/Tauri 工程、测试、历史文档、发行与证据
  retained-build-artifacts/  删除缓存前保存的旧 EXE、便携包及暂存日志
maintenance/2026-10-02-vofa-transition/
  本次整理清单、哈希校验和操作记录
.git/ .agents/ .codegraph/
  保留的仓库与代理工具状态
```

## 当前状态

- VOFA 的公开控件和协议接口为 AI 辅助提供了接入基础；实际安装版本的兼容性、通信和采集性能尚未验证。
- 新插件与独立 AI 服务均未实施，根目录没有新的 npm/Cargo 工程或插件构建入口。
- [旧工程](reference/legacy-llm-serial/)保留当前文件内容，包含整理前未提交的修改；没有用 Git HEAD 替代它们。
- 旧应用的源码、历史构建和测试报告各自保留原有状态，不能据此宣称新插件已完成或实机调参已验收。
- 旧工程中的需求、路线图、发布步骤和“下一步”全部属于历史资料，后续工作以当前根文档和用户的新指令为准。

阅读旧资料优先使用 [reference/README.md](reference/README.md)。恢复旧应用时，在归档工程目录内按其原文档操作；根目录原有启动、构建脚本和 CI 已随旧工程归档。

旧运行数据位于 [reference/legacy-llm-serial/release/data/](reference/legacy-llm-serial/release/data/)，包含个人配置和凭据材料，仅作本机保留。它不属于未来插件的默认数据来源，也不应随参考源码发布。

本机 CodeGraph 状态保留在原位置。源码移动后，旧索引可能使用原路径；后续如使用 CodeGraph，应先确认索引范围和路径，不将旧索引结果视为当前目录事实。
