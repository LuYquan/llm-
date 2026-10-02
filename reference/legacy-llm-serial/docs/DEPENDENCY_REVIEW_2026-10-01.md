# 依赖许可事实清单与发布审阅缺口

记录日期：2026-10-01。此轮新增本地依赖证据工具，不改变产品运行代码、锁文件、既有发布脚本或产品许可证。旧构建 `20260930T234201255Z-159020-32804e0e` 的原始验收与源码身份保持封存；这些新增工具属于下一阶段，不能倒签成旧 EXE 已完成许可审核。

**事实清单可生成，严格许可检查未通过。** 软件测试、漏洞公告审计、许可声明、文本证据、权属授权和正式分发是不同层级。SPDX 声明和公开可读源码均不代表完整授权；本项目产品许可证继续 `pending-owner-decision`，没有替所有者选择或创建 LICENSE。

## 本地复现

需要已有 Node.js，以及已安装/缓存的锁定依赖。工具不运行 npm 包脚本，不安装依赖，不调用外部 API，不联网获取许可文件，不读取用户配置/API Key/`release/data`。默认 Cargo 文本读取范围为当前用户 `.cargo/registry/src` 下与锁文件和保存的 metadata 匹配的依赖源码；收集器不枚举或收集 Cargo 配置和凭据内容。

首次收集可明确要求一次离线 Cargo metadata：

```powershell
node scripts/dependency-inventory.mjs --capture-cargo --output output/dependency-inventory-20261001
```

该选项只运行 `cargo metadata --locked --offline --format-version 1 --filter-platform x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml`，同时设置 `CARGO_NET_OFFLINE=true`。完整 stdout、stderr 和实际退出状态分别保存为 `cargo-metadata.json`、`cargo-metadata.stderr.log`、`cargo-metadata.result.json`。记录绑定 Cargo.lock SHA256 并检查命令前后锁文件未变；失败也保留事实，不据此推断具体缺包或依赖不安全。

本次该命令已执行一次并成功。后续复核复用保存的证据，避免重复执行：

```powershell
node scripts/dependency-inventory.mjs --metadata output/dependency-inventory-20261001/cargo-metadata.json --metadata-result output/dependency-inventory-20261001/cargo-metadata.result.json
node scripts/dependency-inventory.mjs --metadata output/dependency-inventory-20261001/cargo-metadata.json --metadata-result output/dependency-inventory-20261001/cargo-metadata.result.json --strict
node --test tests/dependency-inventory.test.mjs
```

普通模式生成事实清单，退出 0 不代表许可获准。`--strict` 对未知、证据异常和任何待人审项目返回 2；命令参数/输出路径等运行错误返回 1。当前所有声明均保留原表达式、`spdxParsed=false`、`authorized=false`，没有允许清单或自动法律批准器，因此严格模式预期不能变绿。

可使用 `--root` 指定独立源码目录，`--output` 和两个 metadata 参数必须使用该根下 `output/` 的相对路径；`--cargo-registry-root` 可明确指定授权的公共依赖源码缓存。`--target`、`--platform`、`--arch` 指定收集目标。输出路径和证据路径拒绝 `..`、绝对路径及越界 symlink/junction。

## 当前事实与缺口

本轮实际离线 metadata 退出 0，stdout 1,497,342 字节，无 stderr；包含 303 个包和 303 个 resolve node，其中 302 个 registry 依赖有许可声明，本项目没有。根 features 为 `[]`。这是指定目标和当前默认 feature 的 metadata 图，不是逐字证明当前 EXE 实际包含哪些依赖；正式分发还需与真实构建 feature 和产物内容核对。

| 项目 | 本次结果 | 审阅边界 |
| --- | --- | --- |
| npm 锁定集合 | 116 条目；56 个实际安装，版本/声明与锁一致 | 60 个未安装条目均 dev+optional 且 OS/CPU 不适用当前 Windows x64，不记为安装损坏 |
| npm 声明 | MIT 98、Apache-2.0 OR MIT 13、ISC 2、BSD-2-Clause 1、BSD-3-Clause 1、Apache-2.0 1 | 原文保留，全部待人审；不按包含 MIT 自动批准 |
| npm 文本证据 | 50 个已安装包具有顶层 LICENSE/COPYING/NOTICE 类文件 | 另 6 个开发包没有该范围文本，不任意继承父包许可 |
| Cargo 锁定集合 | 473 个包：472 registry + 本项目；registry checksum 完整 | 锁文件不含许可字段，metadata 未覆盖的 170 个锁定条目记为 not-collected，不自动视为无需审核 |
| Cargo 文本证据 | 302 个目标图依赖中 291 个采集到许可/通知文本 | 11 个没有在采集范围发现文本；不递归猜测所有源注释或 README 中的法律条件 |
| Cargo 缓存完整性 | 当前 302 个依赖源码目录均没有 `.cargo-checksum.json` | 文本仍采集并计算 SHA256；缓存与 registry 发布包的完整性关联保持待补，不宣称已验证 |
| 资源权属 | 头像与 14 个图标共 15 文件，全部 pending-owner-evidence | `avatar.png` 与 `icon.png` 内容相同不构成权属证明；后续需来源、作者、授权和衍生关系记录 |
| 许可通知候选 | 569 个原始文件副本 | 只是可审阅候选，不是已完成的发行通知文件或第三方授权结论 |

npm 缺文本的六个包是 `@esbuild/win32-x64`、`@rollup/rollup-win32-x64-gnu`、`@rollup/rollup-win32-x64-msvc`、`@tauri-apps/cli-win32-x64-msvc`、`@vue/compiler-vue2`、`de-indent`。它们均为开发条目，但本工具不因此删除审阅需求。

Cargo 缺文本的十一个包是 `alloc-stdlib@0.2.4`、`defmt-parser@1.0.0`、`selectors@0.36.1`、`unic-char-property@0.9.0`、`unic-char-range@0.9.0`、`unic-common@0.9.0`、`unic-ucd-ident@0.9.0`、`unic-ucd-version@0.9.0`、`webview2-com-macros@0.8.1`、`webview2-com-sys@0.38.2`、`webview2-com@0.38.2`。这是本地文本证据缺口，不是违法结论。

目标图声明包含 MPL-2.0（6 条）、Unicode-3.0（18 条）、AND 条件、OR 选项和 `MIT/Apache-2.0` 等旧式表达式。需逐项结合代码/资产和实际分发方式人审；工具不将 OR 两侧同时解释为必需义务，也不擅自选取分支。Rollup 的 LICENSE 另列内置组件 MIT/ISC/0BSD，TypeScript 有独立 ThirdPartyNoticeText；包级声明不足以代替这些文本。Tauri README 分别声明代码与 Logo 的许可，也不能用包级 MIT 条件直接批准所有资产。本轮没有证据说本项目头像来自 Tauri。

当前清单含 0 个结构/版本/路径验证错误，924 个待审诊断项：418 个声明待人审、1 个项目声明缺失、17 个依赖文本缺口、170 个 Cargo 声明未采集、302 个 Cargo 缓存 checksum 证据缺口、15 个资源权属待提供、1 个产品许可证待决定。一个依赖可能有多项诊断，因此 924 不是依赖数量。

## 输出与身份

初始冻结阶段目录 `output/dependency-inventory-20261001/` 包含事实清单 `dependency-inventory.json`、清单身份摘要 `dependency-inventory.sha256`、离线 Cargo 原始记录和 `notice-candidates/`。后续接线改为未指定输出时生成每轮独立目录，避免默认命令覆盖旧记录；复用证据时应明确传两个 metadata 文件，并为严格复核选择新输出目录，具体命令见 README。通知候选按依赖 ID 的摘要隔离，只复制已授权依赖目录内的许可/通知类原始文件，不执行其内容。JSON 的候选文件清单是本轮权威范围；显式选择复用输出时不清理旧文件，未列入清单的遗留文件不能自动用于发行。

清单身份摘要覆盖稳定排序的规范 JSON，包括锁文件/项目 manifest 哈希、依赖原声明、目标图和 features、实际 manifest/许可文本哈希、资产哈希、候选文件清单及待审诊断。Cargo metadata 中的本机绝对 package ID 被映射为稳定名称/版本/来源 ID。本机 raw metadata/result 字节摘要、Node 版本和收集器 SHA256 放在独立 evidence 中，不进入清单身份摘要；原始 metadata 含本机路径，应留在本地证据目录。

当前清单 SHA256：`93237A6BBA6F8AEEE4603CE86B9B76CC81FA082D00F56EAEBD87BDBC26E6C5E0`。本次锁文件身份：

```text
package-lock.json
CBC65102AC83A8D08B0A4BC5C3FB58C019F310686F6D25BE38F8C670C16C5228

src-tauri/Cargo.lock
C84715DC6C2B4D9FFD24A2E6F596CF340BE08852C520985C006BC766E51AF4DA
```

本次 metadata 原始捕获早于收集器完成，记录中的锁摘要随后与捕获前已读取的冻结锁摘要和捕获后的摘要核对一致，并在 output 明记关联方式；没有重复运行 Cargo。今后使用 `--capture-cargo` 会直接记录命令前后锁摘要。

## 软件检查与发布门槛

测试覆盖文本证据缺失、实际版本/锁格式不符、锁路径穿越、依赖和输出 junction 越界、Rust manifest/声明文本越界、文本修改影响清单摘要及缓存校验、缓存 checksum map 缺失时继续采集、稳定排序/跨根身份、离线失败保存状态、metadata 与锁摘要不符、原文副本哈希和 pending 严格失败。夹具不请求网络、安装依赖或调用真实 Cargo。

本次实际运行结果：14/14 测试通过，测试命令退出 0；普通生成退出 0，严格模式退出 2，两次清单摘要相同。569 个候选副本共 2,738,473 字节，逐文件 SHA256 全部与清单相符；输入锁文件/manifest 和收集器摘要仍匹配。证据为本地 [测试结果](../output/dependency-inventory-20261001/inventory-tests.result.json)、[测试日志](../output/dependency-inventory-20261001/inventory-tests.log)、[生成与严格运行结果](../output/dependency-inventory-20261001/inventory-runs.result.json)、[副本校验](../output/dependency-inventory-20261001/copy-verification.json) 和 [事实清单](../output/dependency-inventory-20261001/dependency-inventory.json)。

本工具测试和普通清单生成属于软件工具验证。`--strict` 当前非零属于真实审阅未完成，不能为通过检查而填入假批准。上述摘要和记录属于收集器最初冻结阶段。随后父任务添加 npm 入口、证据工具测试与正式发行门槛；新的 package.json 输入会产生独立清单身份，不把原清单倒签为新输入。接线与后续严格状态见[控制与依赖补强](CONTROL_AND_DEPENDENCY_HARDENING_2026-10-01.md)，最新构建绑定以本轮 output 验收报告为准。

后续需要所有者决定产品许可证和提供资产权属证据；维护者按版本/checksum 绑定依赖审阅决定，补全缺失文本与内置组件/NOTICE，核对目标 feature 和真实分发范围，形成正式 THIRD_PARTY_NOTICES。漏洞审计由独立工作承担，其成功不替代许可审核。只有这些证据完成后，才可设计受控的许可批准状态及正式发行门槛；公开源码现状不自动完成此项。
