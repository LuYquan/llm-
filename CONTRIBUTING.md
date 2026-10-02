# 后续开发协作入口

更新：2026-10-02。**后续开发目标是 VOFA AI 插件，不再继续开发独立 AI 串口助手。** 当前仅完成目录整理与文档准备，插件尚未实施。

## 阅读顺序

1. [README](README.md)与[交接说明](docs/HANDOFF.md)。
2. [开发准备](docs/DEVELOPMENT_PREPARATION.md)与[职责设计](DESIGN.md)。
3. 按任务查看 [复用索引](reference/REUSE_MAP.md)和相关旧测试。

## 工作位置

旧工程整体保存在 reference/legacy-llm-serial，作为参考材料。后续实施获授权后再建立新的插件/服务代码入口与工具链；本轮没有创建新的 package.json、Cargo 项目、插件骨架或默认服务。

根目录原启动脚本、构建命令和 GitHub 工作流已归档。旧工程的 npm/Cargo 命令只属于旧应用的恢复与复核流程，不能作为新插件的构建说明。

## 验证与记录

每项迁移区分源码核对、单元测试、宿主加载、通信验证、实际模型服务和真实设备验收。新的测试应检验迁移后的接口契约与行为，不把旧报告直接算作新宿主验证。

分类、筛选、路由与简单语义判断优先按 typesafe-ai 技能使用 Jev，并记录使用步骤；复杂推理、架构取舍和关键结论由 Codex/推理模型核实，精确计算和执行授权由代码处理。

## 本机材料

当前保留 reference/legacy-llm-serial/release/data、历史输出和整理清单；这些可能包含个人配置、凭据或设备数据。源码共享应单独检查范围，不直接发布整个 reference 或 maintenance 目录。
