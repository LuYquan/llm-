# 串口通信流协议格式规范 (Stream Format Specification)

- **版本**: v1.0
- **适用组件**: 桌面端 Rust 后端 (`StreamDemuxer`) 与 网页端 Web Worker (`WebStreamDemuxer`)
- **关联设计**: [ADR 0002 统一流分流架构](../adr/0002-unified-stream-demuxing-architecture.md)、[ADR 0006 双运行时串口传输](../adr/0006-dual-runtime-serial-transport.md)

---

## 1. 概述与核心原则

嵌入式控制系统与机器人开发中，单片机通常通过单一物理串口输出高频采样数据（如 PID 期望值、测量值、控制器输出）并穿插系统运行调试日志。
为了同时满足单片机“一行 `printf` 极简接入”和高频解析零卡顿的目标，双端分流器采用统一的流解析状态机：

1. **零配置自适应**：自动识别纯 CSV 浮点数、Teleplot 键值对以及非数值调试日志；
2. **严禁 Panic / 异常抛出**：脏数据、损坏字符、溢出字节静默丢弃并累加错误计数，单行破损不扩散至后续数据；
3. **双端完全等价**：Web Worker 前端解析逻辑必须与 Rust 后端解析逻辑在 7 组黄金数据集上 100% 输出对齐。

---

## 2. 字节流提取与分包（Chunk & Line Extraction）

从串口底层读取的原始字节流为任意大小的切片（Chunk）。分流器首先执行字节级行切分：

1. **行分隔符**：以换行符 `\n` (`0x0A`) 作为行结束标志；
2. **换行符剥离**：行切分后，必须剥离末尾的 `\r` (`0x0D`) 与 `\n` (`0x0A`)，确保不同操作系统（Windows CRLF、Linux LF）下得到的行文本内容一致；
3. **空行处理**：剥离换行符后为空的行（长度为 0）静默忽略，不计入错误计数，不派发至上层；
4. **非法 UTF-8 容错**：若某行字节无法被正确解码为有效 UTF-8 字符序列，该行立即丢弃，`byte_dirty_count` 累加 1；
5. **超长行解析防护**：文本解析副本最多累积 **65,536 字节 (64 KiB)**；超限后丢弃该解析行并累计 `byte_dirty_count`，保留后续行的重同步能力。此处理不得改写或删除独立持有的原始接收字节。

---

## 3. 行协议类型识别与分流规则

对提取出的每行非空文本（去除首尾空白后记为 `trimmed`），按以下顺序严格判定：

### 3.1 规则一：Teleplot 键值对行 (`>name:value`)
- **判定条件**：`trimmed.startsWith('>')`
- **解析格式**：`>变量名:数值`
  - 提取去掉 `>` 后的内容，以首个英文冒号 `:` 分割为 `name` 与 `valStr`；
  - `name` 不能为空字符串；
  - `valStr` 必须能解析为有效有限浮点数（支持整数、小数、负数与科学计数法，严禁 `NaN` 与 `Infinity`）；
- **容错处理**：若缺少冒号、变量名为空、或数值非法（如 `>broken`、`>sp:NaN`），判定为格式破损，`demux_error_count` 累加 1，静默丢弃；
- **微秒时间对齐 (TeleplotAligner)**：
  - Teleplot 是异步单变量推送，控制周期内的多个变量（如 `>sp`、`>act`、`>out`）通过时间窗口（默认 10,000µs / 10ms）进行聚合；
  - 当在当前帧中再次遇到已出现的变量名（周期翻转）或时间间隔超过时间窗口时，触发前一周期的 `SamplePoint` 输出；
  - 稀疏通道：周期内未更新的通道记为 `null`；
  - 流终止或显式刷新时调用 `flush()` 派发暂存中的最后一帧。

### 3.2 规则二：明确日志前缀行
- **判定条件**：
  - `trimmed.startsWith('[')`
  - `trimmed.startsWith('#')`
  - `trimmed.startsWith('//')`
  - `trimmed.toUpperCase()` 以 `INFO:`、`WARN:`、`ERROR:` 或 `DEBUG:` 开头
- **处理方式**：即使行中包含英文逗号（如 `[INFO] System ready, 3 sensors found`），亦直接归类为调试日志，进入 `LogLine` 缓冲，不触发 CSV 解析与错误统计。
- **日志级别映射**：
  - 包含 `[ERR`、`[ERROR]`、`ERROR:` -> `LogLevel::Error`
  - 包含 `[WARN`、`[WARNING]`、`WARN:` -> `LogLevel::Warn`
  - 其余 -> `LogLevel::Info`

### 3.3 规则三：CSV 逗号分隔数值行
- **判定条件**：`trimmed.includes(',')`
- **解析格式**：`val0, val1, val2, ...`
  - 按 `,` 分割为若干字段，每个字段去除首尾空白；
  - 每个字段必须为非空且可解析为有限浮点数（支持正负号、浮点数与科学计数法 `1.2e2`、`-5.6e-1`）；
  - 严禁包含 `NaN`、`Infinity` 或空字段（如尾随逗号 `1.0,2.0,`）；
- **容错与回退判定**：
  - 若所有字段均为合法有限浮点数：输出 `SamplePoint`，按需自动拓展 `ch0`, `ch1`... 通道名；
  - 若字段不满足纯数值 CSV：
    - 检查第一个逗号前的子串：若该子串可被解析为有效浮点数（如 `10.0,??#$%,30.0`），则判定为**损坏的 CSV 行**，`demux_error_count` 累加 1 并静默丢弃；
    - 若首个子串不是数值（如 `System booted, ready for command`），则判定为**包含逗号的普通调试日志**，路由至 `LogLine`。

### 3.4 规则四：其余普通非数值文本
- **判定条件**：不以 `>` 开头、不包含逗号、且非明确日志前缀的文本（如 `Motor initialized successfully`）；
- **处理方式**：直接路由至 `LogLine`，日志等级为 `Info`。

---

## 4. 批量投递与有界缓冲 (ParsedBatch)

为了防止高频小包冲击主线程渲染，Web Worker 采用与 Rust `Channel` 对齐的有界缓冲与批量推送：

```ts
export interface ParsedBatch {
  samples: { channel: string; t: number; v: number }[];
  logLines: { t: number; text: string }[];
  droppedBytes?: number;
}
```

- **节流周期**：默认以 16ms (约 60Hz) 定时或积攒达批次阈值时 postMessage 投递；
- **有界容量**：Worker 内部波形采样队列上限 20,000 个点，日志上限 5,000 行。若前端处于后台标签页或消费缓慢，写满时丢弃最旧数据并递增 `droppedBytes`。
