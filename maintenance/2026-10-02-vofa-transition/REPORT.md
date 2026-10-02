# VOFA AI 开发准备：目录整理记录

日期：2026-10-02（Asia/Shanghai）。范围：目录整理、历史工程保留、当前说明更新、可重建缓存清理。未实施插件或 AI 服务。

## 整理结果

- 旧独立串口工作台整体移到 [reference/legacy-llm-serial](../../reference/legacy-llm-serial/)，源码、脚本、测试、锁文件和旧文档保持内部相对关系。
- 根 README、PRODUCT、DESIGN、CONTEXT、CONTRIBUTING、GEMINI 已更新为当前方向；新 docs 提供开发准备和交接说明。
- 建立 [旧代码复用索引](../../reference/REUSE_MAP.md)，按 AI 证据、模型请求、控制计算、协议命令、执行安全与测试分类。
- 旧 .github 工作流与启动/构建 BAT 一起归档。根目录没有活动旧 CI、旧 npm/Cargo 工程或新的插件工程。
- 原文件 25,062 个逐文件 SHA256 校验通过，其中包括 108 个根 tests 文件、37 个 release/data 文件和 34 个删除前另存的构建材料。计数包含历史输出与审计工具材料，不代表 25,062 个业务源码文件。
- 清理后再次校验全部保留文件，12 份当前文档中的 151 个本地链接有效；Git HEAD 保持原值，空白检查与本机材料忽略规则检查通过。没有运行旧应用测试，因为业务源码没有修改，本轮验证针对目录与内容保留。

## 删除范围

以下 7 个目录均先检查内容、Git 跟踪状态和目录链接，再删除并确认不存在。路径按整理前的位置列出。

| 原路径 | 文件数 | 文件大小合计（十进制 GB） |
| --- | ---: | ---: |
| dist | 22 | 0.0017 |
| dist-staging | 16 | 0.0227 |
| node_modules | 1,473 | 0.0870 |
| src-tauri/target | 13,879 | 12.8322 |
| src-tauri/dist-staging | 84,884 | 74.4468 |
| src-tauri/src-tauri | 3,643 | 1.7149 |
| output/cargo-target-beta-20260930 | 8,331 | 7.3340 |
| 合计 | 112,248 | 96.4394 |

合计 96,439,361,097 字节，约 96.44 GB / 89.82 GiB。这里是文件逻辑大小，不等于实测释放的磁盘空间；部分原目录使用了压缩属性。

dist-staging 中的 releases、暂存日志，以及 Cargo 缓存中的应用 EXE/相关标识材料在删除前保存到 [retained-build-artifacts](../../reference/retained-build-artifacts/)并逐文件校验。这里只保存原构建物，不新增其运行、打包完整性或硬件验收承诺。

## 保存范围

旧根文档原文、48 个历史 docs 文件、源码、测试、协议夹具、脚本、锁文件、原发布目录、阶段检查点和 output 内非 Cargo 缓存材料已保留。output 中的报告、截图、源码快照、已有发布包与审计工具均属于本机参考。

release 内两份原 EXE、portable.flag、README 和 data 同目录保存。个人配置、加密凭据、日志、归档与录制文件内容未修改；新项目不自动导入这些材料。不要直接将整个参考区公开上传。

.git 与 .agents 保持原位置。整理阶段没有 reset/clean、暂存、提交或推送；后续交接变更的提交与推送状态以 Git 记录为准。CodeGraph 的两个现存进程引用工作区，.codegraph 保留；源码移动后索引可能使用旧路径，后续查询前须确认索引状态。

## 分类与权限记录

使用 typesafe-ai 技能与 Jev 对 8 类材料辅助分类。5 类分类结果明确，网页输出、运行数据/发行物、node_modules 三类被标记需复核。Codex 核对当前内容、Git 跟踪情况、进程与保留副本后确定处理：发行物和用户数据保存，可重建网页输出和依赖清理。Jev 没有提供删除或设备执行授权。

只读进程检查确认未发现 Vite、Cargo/rustc 或旧应用进程；没有终止进程。普通权限在移动历史输出受保护材料时遇到访问错误，随后在授权审查允许的权限下续接移动，再核对全部原始哈希。根仓库和活跃工具状态没有参与移动。

## 记录文件

以下 JSON 在本机保留并被根 .gitignore 排除，报告与脚本可查阅；清单只记录路径、大小、哈希和状态，不复制密钥正文。

- [git-before.json](git-before.json)：整理前 HEAD 与未提交文件状态。
- [moves.json](moves.json)：26 个根入口的移动映射。
- [preserved-files.json](preserved-files.json)：原路径、新路径、字节数、SHA256。
- [archive-verification.json](archive-verification.json)：移动后哈希验证。
- [cache-plan.json](cache-plan.json)：删除前缓存盘点。
- [deleted-caches.json](deleted-caches.json)：实际删除路径及不存在性验证。
- [cleanup-verification.json](cleanup-verification.json)：7 项清理完成记录。
- [final-verification.json](final-verification.json)：最终内容、导航、入口与忽略规则检查。

[organize.ps1](organize.ps1)保留为本次操作记录。它使用固定工作区与明确清单，不是日常开发命令；完成后重复执行会拒绝已归档/不存在的目标，不要将它用于其他目录。

[verify-layout.mjs](verify-layout.mjs)可重新检查文件保留、删除状态、当前导航与 Git 边界。它只读取项目材料并刷新本目录 final-verification.json；需要 Node.js，不需要重新安装旧项目依赖。

## 恢复与后续使用

通常直接在归档目录查阅即可。如需运行旧应用，在归档工程内按照原锁文件重新安装依赖并按原 README 操作；Rust/Vite 缓存需要重新生成。原始历史 EXE 和便携包保留，但本轮未运行它们。

如需恢复原布局，先保存新根文档与当前 docs，再根据 moves.json 将归档入口反向移回；同名文件需比较，不能覆盖新文档。原 .gitignore/.gitattributes 副本在归档根目录。被删除缓存只能按锁文件/工具链重建，不承诺逐字节恢复缓存。

后续开发先读 [当前 README](../../README.md)、[交接说明](../../docs/HANDOFF.md)和[开发准备](../../docs/DEVELOPMENT_PREPARATION.md)。旧文档的未完成计划保持历史状态，本轮不继续执行。
