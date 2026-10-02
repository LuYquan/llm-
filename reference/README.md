# 旧工程与参考资料

整理日期：2026-10-02。这里保存旧独立串口工作台的当前文件与历史材料，供后续 VOFA AI 开发查阅。

**下一步开发的是 VOFA AI 插件。这里的旧串口助手仅供参考，不继续按其历史计划开发。**

## 快速查找

| 要查什么 | 入口 |
| --- | --- |
| 哪些逻辑能用于新方向 | [REUSE_MAP.md](REUSE_MAP.md) |
| 旧工程最后的交接描述 | [原交接说明](legacy-llm-serial/MODEL_HANDOFF_2026-09-28.md)，文件名沿用历史，正文实际更新到 2026-10-02 |
| 当前归档源码 | [src](legacy-llm-serial/src/)、[src-tauri](legacy-llm-serial/src-tauri/) |
| 测试与协议夹具 | [tests](legacy-llm-serial/tests/)、[Rust 测试](legacy-llm-serial/src-tauri/tests/) |
| 历史设计与验收说明 | [旧 docs](legacy-llm-serial/docs/) |
| 旧发布和启动方式 | [旧 README](legacy-llm-serial/README.md)、[旧 scripts](legacy-llm-serial/scripts/) |
| 既有本机程序和数据 | [release](legacy-llm-serial/release/)，原 EXE、flag、说明与 data 一起保存 |
| 历史报告、截图、构建身份及源码快照 | [output](legacy-llm-serial/output/) |
| 旧阶段检查点 | [implementation-checkpoint](legacy-llm-serial/implementation-checkpoint-2026-09-28-stage-a/) |
| 缓存中另存的 EXE、便携包与暂存日志 | [retained-build-artifacts](retained-build-artifacts/) |
| 本次移动与内容校验 | [整理报告](../maintenance/2026-10-02-vofa-transition/REPORT.md) |

## 历史文档如何使用

本目录所有需求、路线图、贡献步骤和未完成项均为历史记录，不代表当前任务授权；根 README 描述当前状态。

- 原 PRD 的全能独立工作台、vofa-full-recreation-plan 的全面复刻，以及旧双运行时发布路线不再作为当前目标。
- vofa-migration-guide 的无缝迁移、完全兼容和工业级表述应按历史设计意图理解，不作为当前已验证结论。
- 原 CONTEXT 包含规划术语，不能作为已实现能力清单。
- 多份用户手册与进度记录对应不同阶段；先读原交接说明，再核对源码和对应构建身份。
- 旧 ADR、协议文档、ACK/时序与安全资料仍有参考价值，按 REUSE_MAP 定位。

## 保留与恢复

旧工程内部相对目录关系保留，没有拆散源码、脚本与测试；原根文档完整保存。已删除的是经过盘点的可重建依赖和构建缓存，旧发行物、证据、运行数据和检查点保留。

需要复核旧应用时，先进入 legacy-llm-serial，按原锁文件重新安装依赖；之后按原 README 执行相关验证。旧构建和启动脚本可能联网、编译或启动程序，整理任务未运行这些入口。旧输出中的绝对路径属于当时证据，迁移后不应据此认定原路径仍存在。

旧 release/data 内的个人配置、加密凭据与设备记录保持原内容。整个参考区不是可直接上传的公开源码包。

公开提交仅包含筛选后的参考源码和文档；本机发行物、运行数据、输出与整理清单不上传。参考测试中未经明确标注的密钥形状字面量在提交版本中替换为测试占位值，本机归档原文仍保留。

## Git 与工具

仓库 .git 留在工作区根目录，所以历史提交仍可查阅。目录整理将旧工程移入参考区，具体提交与推送状态以 Git 记录为准。归档内 .github 工作流作为文本保留，不是根层活动 CI。
