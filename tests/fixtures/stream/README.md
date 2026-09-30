# 串口数据流标准测试数据集 (Stream Test Fixtures)

本文档定义了 LLM 串口工作台在【阶段零：基线确认与回归保护】构造的标准串口测试数据集。本数据集作为双端（Rust 后端与 Web Worker 前端）流分流解析器的黄金基准测试向量（Golden Test Vectors），用于保障阶段一抽象层重构与阶段二浏览器端驱动实现的 100% 协议解析一致性。

---

## 一、数据集清单

| 编号 | 样本文件 | 期望结果文件 | 测试类别 | 核心覆盖场景 |
|---|---|---|---|---|
| **01** | `01_pure_csv.raw` | `01_pure_csv.expected.json` | 纯 CSV 格式 | 多通道浮点数组、负数、零值、科学计数法（`1.2e2`）、首尾空格清洗 |
| **02** | `02_teleplot.raw` | `02_teleplot.expected.json` | Teleplot 格式 | `>name:value` 键值对、帧周期翻转对齐、稀疏通道（缺失通道为 `null`）、流末尾 `flush()` 刷新 |
| **03** | `03_csv_and_log_mixed.raw` | `03_csv_and_log_mixed.expected.json` | CSV 与日志混合 | 数值波形行与 `[INFO]` / `[WARN]` / `[ERROR]` 前缀日志、普通英文逗号非数值文本交错分流 |
| **04** | `04_chunk_boundary_half_line.raw` | `04_chunk_boundary_half_line.expected.json` | 半行截断（跨 chunk 拼接） | 模拟 UART 底层按任意字节片到达（见 `.chunks.json`），在逗号、前缀、键名处截断时的跨帧无损拼接 |
| **05** | `05_invalid_utf8_and_corrupt.raw` | `05_invalid_utf8_and_corrupt.expected.json` | 非法 UTF-8 与异常字符 | 非法 UTF-8 字节（`0xFF 0xFE...`）、破损 CSV（`10.0,??#$%,30.0`）、非法 Teleplot（缺少冒号）、NaN/Inf 数值防护、尾随逗号容错 |
| **06** | `06_overlong_line_protection.raw` (`.chunks.json`) | `06_overlong_line_protection.expected.json` | 超长行防护 | 文本解析累积超过 64 KiB 后清空解析副本并计数，原始字节独立保留，后续正常行可恢复 |
| **07** | `07_line_endings_mixed.raw` | `07_line_endings_mixed.expected.json` | 换行符混用 | Windows `\r\n` (CRLF) 与 Linux `\n` (LF) 混用，尾随 `\r` 彻底剥离，不污染字段与日志内容 |

---

## 二、期望结果 JSON 结构规范

每个 `.expected.json` 文件遵循统一结构：

```json
{
  "fixture_name": "样本名称",
  "category": "分类标识",
  "description": "测试目的说明",
  "raw_lines": [ "原始提取行1", "原始提取行2" ],
  "expected_outputs": [
    {
      "type": "sample" | "log",
      "values": [ 10.0, 20.0, 30.0 ],       // 仅 sample 具备，未更新通道为 null
      "channels": [ "setpoint", ... ],       // 对应通道名
      "level": "Info" | "Warn" | "Error",   // 仅 log 具备
      "text": "日志文本"                    // 仅 log 具备
    }
  ],
  "samples": [
    { "values": [ 10.0, 20.0, 30.0 ] }
  ],
  "logs": [
    { "level": "Info", "text": "..." }
  ],
  "summary": {
    "total_raw_lines": 6,
    "sample_count": 6,
    "log_count": 0,
    "byte_dirty_count": 0,
    "demux_error_count": 0
  }
}
```

---

## 三、双端验证指引

### 1. Rust 后端比对验证
Rust 端使用 `cargo test --test fixtures_verification` 针对本目录全部用例进行逐条断言：
- `process_serial_bytes` 负责 chunk 拼接、UTF-8 校验与超长行防护；
- `StreamDemuxer::demux_line` 负责行级分类、数值解析与 Teleplot 对齐；
- 统计 `dirty_data_count` 与 `demux_error_count`。

### 2. 前端 / Web Worker 比对验证
网页端 `WebStreamDemuxer`（阶段二）使用 `vitest` 读取相同的 `.expected.json`，在 Worker 内部跑相同的数据流并做深度比对，确保双端曲线与日志输出完全一致。
