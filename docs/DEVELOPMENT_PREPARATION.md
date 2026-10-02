# VOFA AI 开发准备

记录日期：2026-10-02。状态：公开资料与旧源码已查看，实际 VOFA 插件尚未编写或运行。

下一步构建 VOFA AI 插件，旧独立 AI 串口助手仅作为参考；本文用于插件开发时查阅接口与待验证事项。

## 已查到的接入基础

| 能力 | 官方公开资料中的依据 | 使用边界 |
| --- | --- | --- |
| 增加 AI 交互入口 | plugins/widgets 下的 QML 控件，ResizableRectangle 和状态保存函数 | 应验证实际宿主版本、模块和控件加载 |
| 绑定通道 | ChMenu.bind_obj 提供 name/value 及显示元信息 | 当前值不等于完整采样历史 |
| 连接状态与刷新 | sys_manager.connected、sending、need_update | 刷新信号不代表逐采样、无损投递 |
| 命令发送 | sys_manager.send_string/send_hex/send_command | 最终字节、换行、设备契约和用户授权仍由我们的流程定义 |
| 原始接收解析 | DataEngineInterface.ProcessingDatas(char *data,int count) | 缓冲区含未解析数据；桥接需处理重复、半包和采样顺序 |
| 文件操作 | sys_manager.file_reader | 宿主能力不等于可以任意改写其配置 |
| 异步服务请求 | Qt QML 的 XMLHttpRequest | Qt 文档说明技术能力；尚未验证用户 VOFA 二进制的运行表现 |

内置终端选中文字、内置波形完整历史与选区、任意全局配置写入，本次资料中尚未找到明确通用接口。相关体验可考虑自行维护证据缓存与分析选区。可行性结论是具备接入基础，不是所有行为已经实测。

## 官方资料

- [VOFA 官网](https://www.vofa.plus/)
- [VOFA 介绍](https://www.vofa.plus/docs/learning/)
- [控件开发与 sys_manager API](https://www.vofa.plus/docs/learning/widgets/development/)
- [协议引擎开发](https://www.vofa.plus/docs/learning/dataengines/development/)
- [波形与采样间隔](https://www.vofa.plus/docs/learning/widgets/wave/)
- [官方链接的 GitHub 插件仓库](https://github.com/je00/Vodka)
- [QML 示例](https://github.com/je00/Vodka/blob/master/widgets/example/example.qml)
- [FireWater 示例](https://github.com/je00/Vodka/blob/master/dataengines/firewater/firewater.cpp)
- [下载页](https://www.vofa.plus/downloads/)与[更新日志](https://www.vofa.plus/docs/function/release_note/)
- [Qt QML 异步请求说明](https://doc.qt.io/archives/qt-5.15/qtqml-javascript-qmlglobalobject.html)

GitHub README 说明主体未开源，插件库单独开源。不能把插件库的许可证视为 VOFA 主体的许可证。没有下载或改写官方仓库代码。

## 实施前首先验证

1. 确认用户实际安装的 VOFA 版本、架构与插件目录；验证最小自定义控件能加载。
2. 验证通道读取与刷新行为，明确时基、采样粒度和断连后的状态变化。
3. 验证插件与本地服务的异步交互，覆盖取消、超时和离线，观察对 VOFA 收发与显示的影响。
4. 如需要协议桥接，确认工具链与宿主二进制兼容、数据完整性和缓冲语义。
5. 如需要发送，先在模拟/回环环境核对最终字节与编码，再进入具体设备验证。

官网开发说明主要围绕 Qt 5.14.2，协议页面还包含不同版本的历史说明。本次读取的下载页与更新日志标注也不同（1.3.10 与 1.4.5）。工具链和支持范围应以实际安装版本及加载结果确定。

## 尚待实施任务决定

AI 服务运行时、插件与服务的通信契约、启动和更新方式、流式输出、证据缓存格式、设备配置模型、首版范围，以及何时恢复完整自动调参。目前只记录方向，不提前选定或实现。

## TypeSafe/Jev 使用记录

可行性研究使用 Jev 对 7 项接入能力做分类，协议桥接被标记需复核；本次目录整理又对 8 类材料做用途筛选，网页输出、运行数据/发行物和依赖被标记需复核。Codex 依据文件内容、源码和保留清单作最终判断。Jev 不负责删除授权、兼容性保证、设备写入授权或开放技术论证。
