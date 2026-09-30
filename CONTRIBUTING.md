# 贡献指南

先阅读 PRODUCT.md、DESIGN.md 和 docs/PRODUCT_REVIEW_2026-09-30.md。功能增加要说明它改善的具体用户任务、如何处理错误、如何退出和如何验证；不要仅增加一个入口。

## 本地开发与检查

使用锁文件安装依赖，运行 `npm run dev`。前端检查 `npm test` 和 `npm run build`；完整检查 `npm run check:release`。Windows 独立 Beta 包使用 `npm run build:beta`，输出到 output，不能覆盖已有 release/data。设置独立 CARGO_TARGET_DIR 和测试数据目录，保留脏工作区与旧包。

## 扩展入口

- 协议：src/core/protocol 的 IProtocolParser 接受原始 Uint8Array；Rust 协议模块保持同义。增加 tests/fixtures 黄金样本，测试单字节、随机分块、坏校验、残帧、非有限值和最大帧，先保证跨运行时一致。
- 显示控件：src/core/widget/registry.ts 注册定义，src/types/widget.ts 定义配置，再接入组件工厂。默认没有设备写入权限；未绑定显示空状态；卸载释放调度器、观察器与监听。
- 控制控件：所有发送走 SendGate 与会话写入边界。必须保留编码、范围、租约、停止与结果语义，不能从 Vue 直接调用底层串口。
- AI 动作：src/core/assistant/debugAssistant.ts 仅定义提案。新增动作先明确白名单、验证、预览、会话过期、错误和恢复；模型内容不产生执行权限。
- 工作区模板：使用版本化 WorkspaceDocument；不包含 Key、当前连接权限、自动发送授权或真实设备记录。样例必须标注适用固件协议和未知信息。

扩展需要可重复验证真实行为的测试；不要用搜索源码字符串代替点击后的结果。与本次改动无关的旧文件不要批量清理。报告区分源码、单元测试、模拟服务、浏览器、原生、硬件和长期验收。

## 当前发布边界

运行时任意代码插件与插件商城未开放。开源许可证尚待所有者确认，提交贡献前应与维护者明确许可；本文不构成贡献许可或第三方资产授权。真实设备日志/Key/用户 data 不提交，也不加入发行包。
