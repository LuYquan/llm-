# LLM 串口项目交接与公开使用说明

> 更新日期：2026-10-02（Asia/Shanghai）。
> 本文沿用原文件名，替代 2026-09-28 的过时盘点；原记录已在本机独立证据目录保留。
> 本轮范围：更新交接说明并 commit/push。没有继续功能迭代、部署公网网站、上传发行包或执行硬件验收。

## 当前交付状态

这不是只能在开发者电脑上使用的网站。产品采用 Vue / TypeScript / Vite / uPlot 前端、Tauri 2 桌面壳和 Rust 原生后端，同一界面具有桌面与浏览器两条运行路径。

| 形态 | 当前实现与交付 | 别人如何使用 |
| --- | --- | --- |
| 本机开发预览 | Vite 默认监听 127.0.0.1:5173；localhost 是开发入口 | 这个地址只指向访问者自己的电脑，不能直接发给别人作为公网地址 |
| Windows 桌面软件 | 已独立编译并封存 Windows x64 未签名 Beta，界面资源打包进程序 | 将不含个人数据的便携 ZIP 提供给试用者，在其电脑解压并运行 EXE；不需要你的电脑、Vite、Node.js 或 Rust 持续运行 |
| 浏览器串口版 | 已有 Web Serial、真实解析 Worker、浏览器记录/回放及 AI 请求代码 | 将前端静态产物部署到 HTTPS 站点，用户在支持的桌面浏览器上授权并连接自己的串口 |
| GitHub 仓库 | 源码、测试、构建脚本和产品/验收文档已提交 | 开发者可获取源码；源码上传本身不会自动发布下载包或公网应用 |

2026-10-02 的 GitHub Releases API 复核返回公开发行列表为空。当前没有已交付并验收的公网应用地址记录。不要把本机预览、源码提交、已有打包能力或本地构建成功称为公网部署完成。

推荐顺序：先提供 Windows Beta 下载与明确的试用说明，再部署网页演示和浏览器串口入口。对外首批支持范围写为“Windows x64 桌面版”和“桌面 Chrome / Edge 网页版”；不要承诺所有浏览器、手机、操作系统或串口设备都兼容。

## 产品行为与 AI 工作方式

默认工作区收敛为连接与协议、原始收发、变量与波形、记录和只读回放。控件按需添加，模型、频域和仿真按需打开。AI 是同一工作区内的辅助侧栏，场景调参与日志解读共用当前会话、协议和变量，不是独立通用工作台。

用户先选平衡车、飞控或自定义场景，再选控制拓扑、当前环和控制器，最后选两条路线之一：

- 遥测反馈：人工逐轮执行或一次授权范围内的有界自动调参。套组提示词与声明式技能随请求发送；本地执行器掌握候选校验、参数/轮数边界、会话与执行归属、写入回执、设备确认、评价和停止。
- 模型计算：填写场景物理数据、输入 s 域传递函数，或由 AI 根据描述生成待审核模型、物理字段和假设；填写并确认后由本机解算候选。离线计算不要求虚构设备连接或生效参数。

自定义支持最多四个按内到外排列的 P / PI / PD / PID 环节，各环配置和记录分开保存。串级外环依赖前置内环的配置及当前连接证据；来源变化使旧候选失效。逐环支持不表示整组联合寻优或无人机空中联调已经实现/验收。

质量、半径等少量数据不能唯一确定 PID。还需对象模型、输入输出单位、方向、采样周期、延迟、工作点和性能目标。AI 草稿、本机预测、驱动写入、设备参数确认和真实闭环效果分别记录。软件 STOP 不等于设备物理停机。

详细方案见 [PRODUCT](PRODUCT.md)、[DESIGN](DESIGN.md)、[场景 AI 实施计划](docs/SCENARIO_AI_IMPLEMENTATION_2026-09-30.md)、[双路线流程](docs/SCENARIO_FLOW_2026-10-01.md)、[串级依赖](docs/SCENARIO_CASCADE_2026-10-01.md)。

## 路线 A：让其他人下载 Windows 软件

1. 复用已封存的独立 Beta 包，或按 [README](README.md) 和构建脚本生成新的独立测试包。不要使用旧 release/LLM串口.exe 冒充当前源码构建。
2. 包内保留 EXE、portable.flag、README.txt、build-manifest.json；不带开发机的配置、密钥、日志或记录。
3. 先在另一台干净 Windows 电脑核对启动/关闭、WebView2、可写数据目录、演示、真实串口收发与记录回放，记录系统、驱动、设备及结果。AI 和硬件调参另行验收。
4. 形成固定版本号、已知限制、支持范围与 SHA256；将 ZIP 或验收过的安装包作为 GitHub Releases 附件，并标记为预发布 Beta。主页 README 链接到下载页。
5. 如需安装向导，当前 tauri.conf.json 已配置 NSIS 和 embedBootstrapper；配置存在不等于安装包已生成/验收。安装器可处理 WebView2，但嵌入引导程序通常仍需联网下载运行时；离线安装要单独配置和验证。见 [Tauri Windows 安装说明](https://v2.tauri.app/distribute/windows-installer/)。
6. 正式发行前处理依赖公告、许可证/资源权属、兼容性与签名。签名是另一个交付步骤，不能靠构建成功代替。

用户只需运行发行包、具备所需 WebView2/串口驱动，并连接自己的设备。基础串口工作不需要你提供在线服务器；使用在线 AI 时才需要其所选模型服务。

上传源码与发布可下载软件是不同操作。本轮用户只要求文档 commit/push，不创建 Releases、不上传二进制、不配置安装器或签名。

## 路线 B：让其他人打开网址使用

浏览器中的串口读写仍发生在访问者自己的电脑，服务器提供页面资源。用户授权的是自己接入的串口，不会自动访问开发者电脑上的 COM 口。Web Serial 要求安全上下文与用户授权，且浏览器支持有限；首批针对桌面 Chrome / Edge 验证。见 [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial) 与 [MDN Serial](https://developer.mozilla.org/en-US/docs/Web/API/Serial)。

可执行步骤：

1. 在独立 checkout / 构建输出目录执行 npm ci、类型检查与前端构建；现有 npm run build:web 只执行 Vite，不能把它当作完整测试。可先执行 npx vue-tsc --noEmit，再运行 npm run build:web。
2. 将生成的 dist 静态文件部署到启用 HTTPS 的托管服务。例如 GitHub Pages 支持从仓库或 Actions 发布静态站点；项目默认网址形式为 https://<owner>.github.io/<repository>。见 [Pages 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) 与 [创建站点](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。
3. 若采用当前仓库，预计项目路径为 LuYquan.github.io/llm-/；这是待配置后的地址形式，不是本文宣称已经部署的站点。当前 vite.config.ts 使用相对 base；实际部署后仍需检查子路径、Worker、静态资源和刷新是否正常。
4. 添加专门的 Pages 部署工作流和仓库 Pages 设置。现有 .github/workflows/checks.yml 只执行软件检查和生产前端，不部署网站。
5. 用实际公网地址测试演示、串口授权/拒绝、收发、协议、记录回放、刷新恢复、浏览器不支持提示和 AI 失败路径。网站可访问不等于真实串口或自动调参已验收。
6. 基础静态串口版无需先建设账户系统或串口云服务器。若后续需要共享项目、账号或由运营者提供 AI，再独立设计相应后端。

HTTPS 不能消除浏览器对后台运行、设备权限与平台支持的限制。当前 rAF/计时器分发与原始遥测读取已经做过软件和合成 App 检查，实际隐藏/最小化、长时采集和硬件保护仍待分别验收。

## 面向公众的 AI 配置选择

| 方式 | 当前能力 / 需要补充 | 适用安排 |
| --- | --- | --- |
| 用户自行配置模型服务和自己的 Key | 当前桌面/网页已有配置与请求入口；真实服务成功、故障和模型质量仍待验收 | 首批 Beta 可先采用，用户承担所选服务的费用 |
| 用户自己的本地模型服务 | 当前有本地服务路径；浏览器访问还须核对服务 CORS、来源授权和本地网络限制 | 离线/本机路线，不能保证部署到公网后自动连通 |
| 运营者统一提供 AI | 当前没有公共账户、额度、计费或共享 Key 后端 | 另建服务端保管 Key、用户认证、限流、预算与隐私规则；设备写入仍由用户本机本地门禁管理 |

当前网页 AI 使用浏览器 fetch 直接请求配置的服务，能否连通取决于服务 CORS 和浏览器限制；纯静态托管不会自动解决。不要把运营者的共享模型密钥写进前端产物。无需为了发布基础串口工具先开发多用户 AI 后端。

## 当前软件证据与明确未验项

应用源码基线：[79b922fe1443486d224c2e98144990ab6e7ede4f](https://github.com/LuYquan/llm-/commit/79b922fe1443486d224c2e98144990ab6e7ede4f)，对应 [Windows CI](https://github.com/LuYquan/llm-/actions/runs/36890195067) 已 completed / success。本轮后续提交仅更新交接文档和 README；不要把旧构建绑定为新文档提交的重新构建。

独立构建：20261001T160736474Z-161588-32804e0e；379 个输入摘要为 60EC0CE32B02D68DA0FD2BAB05DD10C6D6401B2AD15D47B953E79B3064C1673F。EXE SHA256：A17B4C455D849CFF2B740C535E7CE1B0B7252CD10561F4974A66610D09F79225。

本地便携包：output/releases/llm-serial-v0.1.1-beta.1-20261001T160736474Z-161588-32804e0e-windows-x64-portable.zip；ZIP SHA256：B455EECBB6D4ED85A43A586C45741A488E0ACC9741535246496374C7DECA3307。本地路径不会随 GitHub 源码提交成为公开下载链接。

| 层级 | 已有证据 | 不能据此宣称 |
| --- | --- | --- |
| 源码和自动检查 | 八组软件检查通过、Rust 132 个用例、ChannelStore 12 个确定性场景、类型/生产前端/独立 Windows 编译通过 | 所有设备、浏览器、操作系统均兼容 |
| 浏览器 App | 实际 Web Serial/session/Worker + 合成端口/本机固定 HTTP，覆盖参数回读、35 点评价、断流和保护分支 | 原生桌面交互、物理串口、在线 AI 质量或硬件闭环通过 |
| 历史交互 | 场景、动态模型字段、主题/尺寸等保留其各自源码身份 | 本次提交已全部重新执行 |
| 公网与下载发布 | 源码已公开；当前记录未有已验收公网部署，复核时 Releases 列表为空 | 网页应用或发行包已经对外上线 |
| 正式发行门槛 | 严格 Rust 公告 exit 2、保留 7 条告警未豁免；许可证/依赖/资源审查待完成 | 已完成正式开源授权或稳定发行 |

当前 EXE 原生交互、实际隐藏/最小化、真实串口/固件、长期采集、硬件停机与调参效果、真实 AI 服务、干净 Windows、签名和完整 DPI/控件状态矩阵仍待验收。

本机完整证据在 output/background-delivery-20261001/ 下，包括 product-delivery-report.md、objective-completion-audit.json/md、acceptance-report.json/md 和 goal-completion-result.json。此前保留的软件设计/实现/源码交付目标已完成；这些本机报告不随源码提交，未来设备与正式发行结果不得从该状态推定。

## 下一位开发者的入口与工作边界

- 先读本文、[README](README.md)、[产品定位](PRODUCT.md)、[界面规范](DESIGN.md)与[路线图](docs/ROADMAP.md)。旧 PRD/早期计划只作历史背景。
- 主体入口 src/App.vue；传输选择 src/services/transport/factory.ts；会话 src/services/transport/session.ts；原生与 Web 驱动分别为 tauri-transport.ts / web-serial-transport.ts。
- 场景 UI src/components/TuningWorkbench.vue；场景/模型/依赖/执行 src/core/tuning/；AI 请求 src/services/ai.ts 和 tuningAgent.ts；仿真 src/components/SimulationCompareView.vue。
- 协议与设备确认步骤见 [固件指南](docs/firmware-integration.md)，贡献步骤见 [CONTRIBUTING](CONTRIBUTING.md)。npm test、npm run check:release 和 npm run build:beta 均已存在；npm run release 的严格许可/公告门槛当前未通过。
- 原工作目录保持原 master / HEAD 32804e0 的 dirty 用户工作；源码推送使用 output/ 下隔离 checkout，远端为 LuYquan/llm-。不要修改原工作目录分支、远端、index 或清理用户改动。
- 保留旧 release/LLM串口.exe 及所有既有构建/证据。禁止读取、枚举、复制或上传 data/ 与 release/data/；发布仅使用显式源码/包清单。
- 用户已要求不要无休止迭代。后续按新任务的明确范围推进；本轮完成文档 commit/push 后结束，不自行重新开启持续产品目标。

TypeSafe 技能用于语义判断与确定性执行的分工。本次文档更新的 Jev 调用为 0：运行形态、文件身份和发布状态均由源码、已有证据与官方文档核对，不需语义分类。

