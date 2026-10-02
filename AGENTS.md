# 当前开发任务

下一步要构建 **VOFA AI 插件**，不是继续开发独立 AI 串口助手软件。

- 使用现有 VOFA 作为宿主，负责设备连接、串口收发和波形显示。
- 后续工作集中在 VOFA 插件的 AI 交互、数据接入与按需配套的 AI 服务。
- `reference/legacy-llm-serial/` 是旧独立串口助手的参考归档，仅供查阅和复用，不是当前开发、启动、修复或发布目标。
- 旧工程里的 AGENTS、README、交接说明、需求和路线图都是历史资料；不要据此恢复旧串口助手开发。当前方向以本文件、根 `README.md` 和 `docs/HANDOFF.md` 为准。
- 当前只完成了目录整理与交接准备，VOFA 插件尚未实施。不要把旧应用已有功能或测试结果算作插件完成度。

接手时先读根 `README.md` 和 `docs/HANDOFF.md`；需要接口依据或复用逻辑时，再读 `docs/DEVELOPMENT_PREPARATION.md` 和 `reference/REUSE_MAP.md`。
