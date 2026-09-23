use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use super::ring_buffer::{LogDirection, LogLine, LogLevel, SamplePoint};

/// 文本行类型识别 (ADR 0002 智能分流基础)
#[derive(Debug, PartialEq, Clone)]
pub enum LineType {
    /// 数值波形行 (CSV 逗号分隔浮点数组)
    CsvWaveform(Vec<f64>),
    /// Teleplot 键值对波形行 (>变量名:数值)
    Teleplot(String, f64),
    /// 调试或系统文本日志行 (如 [INFO]、[WARN] 或非数值文本)
    Log(String),
    /// 空行
    Empty,
}

/// Teleplot 时间对齐器 (PRD 4.1 & engineering-decisions 2.1)
///
/// Teleplot 协议按单行独立发送变量 (如 `>sp:10\n>act:9.2\n>out:30\n`)。
/// 本对齐器维护 `HashMap<String, f64>` 最新值缓存，
/// 当检测到新一轮变量 (变量名在当前帧重复出现) 或时间窗口超限 (默认 2000us) 时，
/// 将整组变量对齐打包为单个统一时间戳的 `SamplePoint`，彻底杜绝时间轴锯齿与错位。
pub struct TeleplotAligner {
    cache: HashMap<String, f64>,
    current_frame_vars: HashSet<String>,
    current_frame_timestamp_us: Option<u64>,
    last_var_timestamp_us: Option<u64>,
    channel_order: Vec<String>,
    time_window_us: u64,
}

impl TeleplotAligner {
    pub fn new() -> Self {
        Self::with_time_window(10_000) // 默认 10ms (10000us) 窗口，兼容标准 115200 波特率单帧多行传输
    }

    pub fn with_time_window(time_window_us: u64) -> Self {
        Self {
            cache: HashMap::new(),
            current_frame_vars: HashSet::new(),
            current_frame_timestamp_us: None,
            last_var_timestamp_us: None,
            channel_order: Vec::new(),
            time_window_us,
        }
    }

    /// 预设通道顺序 (若已知 channel 映射)
    pub fn with_channels(channels: Vec<String>) -> Self {
        let mut aligner = Self::new();
        aligner.channel_order = channels;
        aligner
    }

    /// 输入一个 Teleplot 键值变量
    /// 若触发帧翻转，返回上一个完整周期的对齐 `SamplePoint`
    pub fn feed(&mut self, key: &str, val: f64, timestamp_us: u64) -> Option<SamplePoint> {
        let mut completed_point = None;

        // 判断是否触发新一轮帧周期翻转：
        // 1. 该变量在当前帧中已经出现过 (新的一轮控制循环已开始)
        // 2. 与当前帧内上一个变量的时间间隔超过了 time_window_us (空闲超时断帧)
        let is_var_repeat = self.current_frame_vars.contains(key);
        let is_idle_timeout = self
            .last_var_timestamp_us
            .map_or(false, |last_t| timestamp_us.saturating_sub(last_t) > self.time_window_us);

        let is_rollover = is_var_repeat || is_idle_timeout;

        if is_rollover && !self.current_frame_vars.is_empty() {
            // 打包当前缓存为上一个周期的 SamplePoint (PR-001 稀疏通道：当前帧更新的为 Some，未更新的为 None)
            let ts = self.current_frame_timestamp_us.unwrap_or(timestamp_us);
            let values: Vec<Option<f64>> = self
                .channel_order
                .iter()
                .map(|ch| {
                    if self.current_frame_vars.contains(ch) {
                        self.cache.get(ch).copied()
                    } else {
                        None
                    }
                })
                .collect();

            completed_point = Some(SamplePoint {
                timestamp_us: ts,
                values,
            });

            // 开启新一帧
            self.current_frame_vars.clear();
            self.current_frame_timestamp_us = Some(timestamp_us);
        } else if self.current_frame_timestamp_us.is_none() {
            self.current_frame_timestamp_us = Some(timestamp_us);
        }

        self.last_var_timestamp_us = Some(timestamp_us);

        // 注册新通道 (如果第一次见)
        if !self.channel_order.iter().any(|c| c == key) {
            self.channel_order.push(key.to_string());
        }

        // 更新最新值缓存与当前帧标记
        self.cache.insert(key.to_string(), val);
        self.current_frame_vars.insert(key.to_string());

        completed_point
    }

    /// 强制刷新当前暂存帧 (在流结束或清空时调用)
    pub fn flush(&mut self) -> Option<SamplePoint> {
        if self.current_frame_vars.is_empty() {
            return None;
        }

        let ts = self.current_frame_timestamp_us.unwrap_or(0);
        let values: Vec<Option<f64>> = self
            .channel_order
            .iter()
            .map(|ch| {
                if self.current_frame_vars.contains(ch) {
                    self.cache.get(ch).copied()
                } else {
                    None
                }
            })
            .collect();

        self.current_frame_vars.clear();
        self.current_frame_timestamp_us = None;
        self.last_var_timestamp_us = None;

        Some(SamplePoint {
            timestamp_us: ts,
            values,
        })
    }

    /// 重置对齐器状态
    pub fn reset(&mut self) {
        self.cache.clear();
        self.current_frame_vars.clear();
        self.current_frame_timestamp_us = None;
        self.last_var_timestamp_us = None;
        self.channel_order.clear();
    }

    pub fn channel_order(&self) -> &[String] {
        &self.channel_order
    }

    pub fn cache(&self) -> &HashMap<String, f64> {
        &self.cache
    }
}

impl Default for TeleplotAligner {
    fn default() -> Self {
        Self::new()
    }
}

/// 纯文本协议解析器 (PRD 4.1 TextParser)
pub struct TextParser;

impl TextParser {
    /// 解析 CSV 逗号分隔的浮点数数值行
    /// 输入示例: "10.00,9.23,30.15\r\n" -> Some(vec![10.0, 9.23, 30.15])
    /// 非数值或格式错误返回 None
    pub fn parse_csv_line(line: &str) -> Option<Vec<f64>> {
        Self::parse_csv_line_with_metrics(line, None)
    }

    /// 解析 CSV 逗号分隔数值行，带脏数据容错与错误计数 (Step 2.4)
    pub fn parse_csv_line_with_metrics(
        line: &str,
        error_counter: Option<&AtomicU64>,
    ) -> Option<Vec<f64>> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        // 快速前缀过滤：若以 '['、'#'、'/'、'>' 开头，显然不是标准 CSV 数值行
        if trimmed.starts_with('[')
            || trimmed.starts_with('#')
            || trimmed.starts_with("//")
            || trimmed.starts_with('>')
        {
            return None;
        }

        let parts: Vec<&str> = trimmed.split(',').map(|s| s.trim()).collect();
        let mut values = Vec::with_capacity(parts.len());
        for part in parts {
            if part.is_empty() {
                if let Some(counter) = error_counter {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                return None;
            }
            match part.parse::<f64>() {
                Ok(val) => {
                    if val.is_finite() {
                        values.push(val);
                    } else {
                        // 过滤 NaN / Infinity (PRD 4.1 SafetyGuard 理念)
                        if let Some(counter) = error_counter {
                            counter.fetch_add(1, Ordering::Relaxed);
                        }
                        return None;
                    }
                }
                Err(_) => {
                    if let Some(counter) = error_counter {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    return None;
                }
            }
        }

        Some(values)
    }

    /// 从原始字节流解析单行 (Step 2.4 脏数据容错)
    /// 若包含非 UTF-8 字符或乱码，静默丢弃并累计错误计数，不影响后续数据
    pub fn parse_raw_line(bytes: &[u8], error_counter: Option<&AtomicU64>) -> Option<Vec<f64>> {
        match std::str::from_utf8(bytes) {
            Ok(valid_str) => Self::parse_csv_line_with_metrics(valid_str, error_counter),
            Err(_) => {
                if let Some(counter) = error_counter {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                None
            }
        }
    }

    /// 解析 Teleplot 键值对行 (PRD 3.1 格式 B: >变量名:数值)
    /// 输入示例: ">setpoint:10.00\r\n" -> Some(("setpoint".to_string(), 10.0))
    pub fn parse_teleplot_line(line: &str) -> Option<(String, f64)> {
        let trimmed = line.trim();
        if !trimmed.starts_with('>') {
            return None;
        }
        let content = &trimmed[1..];
        let (name, val_str) = content.split_once(':')?;
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let val = val_str.trim().parse::<f64>().ok()?;
        if val.is_finite() {
            Some((name.to_string(), val))
        } else {
            None
        }
    }

    /// 从日志行文本推断日志级别并生成 LogLine
    pub fn parse_log_line(text: &str, timestamp_us: u64, direction: LogDirection) -> LogLine {
        let upper = text.to_ascii_uppercase();
        let level = if upper.contains("[ERR") || upper.contains("[ERROR]") || upper.contains("ERROR:") {
            LogLevel::Error
        } else if upper.contains("[WARN") || upper.contains("[WARNING]") || upper.contains("WARN:") {
            LogLevel::Warn
        } else {
            LogLevel::Info
        };

        LogLine {
            timestamp_us,
            direction,
            level,
            text: text.trim().to_string(),
            raw_hex: None,
        }
    }

    /// 分类并解析单行流数据 (用于 StreamDemuxer 智能分流)
    pub fn classify_and_parse(line: &str) -> LineType {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return LineType::Empty;
        }

        if trimmed.starts_with('>') {
            if let Some((name, val)) = Self::parse_teleplot_line(trimmed) {
                return LineType::Teleplot(name, val);
            }
        }

        if let Some(values) = Self::parse_csv_line(trimmed) {
            LineType::CsvWaveform(values)
        } else {
            LineType::Log(trimmed.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_csv() {
        let line = "10.00,9.23,30.15\r\n";
        let parsed = TextParser::parse_csv_line(line);
        assert_eq!(parsed, Some(vec![10.0, 9.23, 30.15]));

        let spaced = "  1.25 , -3.40 , 0.0  ";
        let parsed_spaced = TextParser::parse_csv_line(spaced);
        assert_eq!(parsed_spaced, Some(vec![1.25, -3.4, 0.0]));

        // 科学计数法支持
        let sci = "1e-2, 2.5e3, -1.2e-1";
        assert_eq!(TextParser::parse_csv_line(sci), Some(vec![0.01, 2500.0, -0.12]));
    }

    #[test]
    fn test_parse_invalid_csv() {
        // 非数值
        assert_eq!(TextParser::parse_csv_line("10.0,abc,30.0"), None);
        // 日志行
        assert_eq!(TextParser::parse_csv_line("[INFO] Boot OK\n"), None);
        // Teleplot 键值行
        assert_eq!(TextParser::parse_csv_line(">setpoint:10.0\n"), None);
        // 空行
        assert_eq!(TextParser::parse_csv_line("   \r\n"), None);
        // NaN / Infinity
        assert_eq!(TextParser::parse_csv_line("1.0,NaN,3.0"), None);
        assert_eq!(TextParser::parse_csv_line("1.0,inf,3.0"), None);
        // 尾随空字段
        assert_eq!(TextParser::parse_csv_line("1.0,2.0,"), None);
    }

    #[test]
    fn test_classify_and_parse() {
        assert_eq!(
            TextParser::classify_and_parse("1.0,2.0,3.0\n"),
            LineType::CsvWaveform(vec![1.0, 2.0, 3.0])
        );
        assert_eq!(
            TextParser::classify_and_parse(">pitch:15.5\r\n"),
            LineType::Teleplot("pitch".to_string(), 15.5)
        );
        assert_eq!(
            TextParser::classify_and_parse("[INFO] System ready"),
            LineType::Log("[INFO] System ready".to_string())
        );
        assert_eq!(TextParser::classify_and_parse("   "), LineType::Empty);
    }

    #[test]
    fn test_parse_teleplot() {
        assert_eq!(
            TextParser::parse_teleplot_line(">setpoint:10.0\r\n"),
            Some(("setpoint".to_string(), 10.0))
        );
        assert_eq!(
            TextParser::parse_teleplot_line(">actual:-2.35\n"),
            Some(("actual".to_string(), -2.35))
        );
        // 无冒号或无效数值
        assert_eq!(TextParser::parse_teleplot_line(">not_a_key_val"), None);
        assert_eq!(TextParser::parse_teleplot_line(">key:invalid"), None);
        // NaN / Infinity
        assert_eq!(TextParser::parse_teleplot_line(">key:NaN"), None);
        assert_eq!(TextParser::parse_teleplot_line(">key:Infinity"), None);
    }

    #[test]
    fn test_parse_log_line_levels() {
        let l1 = TextParser::parse_log_line("[INFO] System ready", 1000, LogDirection::Rx);
        assert_eq!(l1.level, LogLevel::Info);
        assert_eq!(l1.direction, LogDirection::Rx);
        assert_eq!(l1.text, "[INFO] System ready");

        let l2 = TextParser::parse_log_line("[WARN] Voltage drop detected", 2000, LogDirection::Rx);
        assert_eq!(l2.level, LogLevel::Warn);

        let l3 = TextParser::parse_log_line("[ERROR] I2C Timeout!", 3000, LogDirection::Tx);
        assert_eq!(l3.level, LogLevel::Error);
        assert_eq!(l3.direction, LogDirection::Tx);
    }

    #[test]
    fn test_teleplot_aligner_multivariable_packing() {
        let mut aligner = TeleplotAligner::new();

        // 周期 1 (1000us ~ 1020us): 输入 >sp:10, >act:9.2, >out:30.1
        assert_eq!(aligner.feed("sp", 10.0, 1000), None);
        assert_eq!(aligner.feed("act", 9.2, 1010), None);
        assert_eq!(aligner.feed("out", 30.1, 1020), None);

        // 周期 2 (11000us): 收到下一个周期的 >sp:10.0
        // 应该触发上一个周期的 SamplePoint 打包！
        let p1 = aligner.feed("sp", 10.0, 11000);
        assert!(p1.is_some());
        let p1 = p1.unwrap();
        assert_eq!(p1.timestamp_us, 1000); // 对齐至第一变量时间戳
        assert_eq!(p1.values, vec![Some(10.0), Some(9.2), Some(30.1)]); // 完整打包三个变量

        // 周期 2 继续输入
        assert_eq!(aligner.feed("act", 9.5, 11010), None);
        assert_eq!(aligner.feed("out", 28.4, 11020), None);

        // 手动 flush 周期 2
        let p2 = aligner.flush();
        assert!(p2.is_some());
        let p2 = p2.unwrap();
        assert_eq!(p2.timestamp_us, 11000);
        assert_eq!(p2.values, vec![Some(10.0), Some(9.5), Some(28.4)]);
    }

    #[test]
    fn test_teleplot_aligner_time_window_rollover() {
        // 设置时间窗口为 1000us (1ms)
        let mut aligner = TeleplotAligner::with_time_window(1000);

        // t = 100us
        assert_eq!(aligner.feed("ch0", 1.0, 100), None);
        // t = 500us (未超时)
        assert_eq!(aligner.feed("ch1", 2.0, 500), None);

        // t = 2000us (时间差 1900us > 1000us，即使变量名不同也触发超时翻转)
        let p1 = aligner.feed("ch2", 3.0, 2000);
        assert!(p1.is_some());
        let p1 = p1.unwrap();
        assert_eq!(p1.timestamp_us, 100);
        assert_eq!(p1.values, vec![Some(1.0), Some(2.0)]);
    }

    #[test]
    fn test_dirty_data_tolerance_and_error_counter() {
        let err_count = AtomicU64::new(0);

        // 1. 非 UTF-8 乱码字节
        let dirty_bytes = b"10.0,\xFF\xFE\xFD,30.0\n";
        let res = TextParser::parse_raw_line(dirty_bytes, Some(&err_count));
        assert_eq!(res, None);
        assert_eq!(err_count.load(Ordering::Relaxed), 1);

        // 2. 格式破损的 CSV (含非数值脏字符)
        let malformed = "10.0,??#$%,30.0\n";
        let res2 = TextParser::parse_csv_line_with_metrics(malformed, Some(&err_count));
        assert_eq!(res2, None);
        assert_eq!(err_count.load(Ordering::Relaxed), 2);

        // 3. 紧接着的正常行应 100% 成功解析，不受此前错误影响
        let clean = "10.0,20.0,30.0\n";
        let res3 = TextParser::parse_csv_line_with_metrics(clean, Some(&err_count));
        assert_eq!(res3, Some(vec![10.0, 20.0, 30.0]));
        assert_eq!(err_count.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn test_teleplot_aligner_115200_baud_multiline_timing() {
        // 模拟真实 115200 波特率下单行 15~17 字节耗时 ~1.4ms (1400us)
        // 3 行变量总耗时 ~2.8ms ~ 4.2ms
        let mut aligner = TeleplotAligner::new(); // 默认 10ms 窗口

        // 周期 1
        assert_eq!(aligner.feed("sp", 10.0, 0), None);
        assert_eq!(aligner.feed("act", 9.2, 1400), None);
        assert_eq!(aligner.feed("out", 30.1, 2800), None);

        // 周期 2 在 10ms (10000us) 后到达
        let p1 = aligner.feed("sp", 10.0, 10000);
        assert!(p1.is_some(), "Repeat of 'sp' should trigger cycle rollover");
        let p1 = p1.unwrap();
        assert_eq!(p1.timestamp_us, 0);
        assert_eq!(p1.values, vec![Some(10.0), Some(9.2), Some(30.1)]);

        // 周期 2 继续到达
        assert_eq!(aligner.feed("act", 9.5, 11400), None);
        assert_eq!(aligner.feed("out", 28.0, 12800), None);

        // 手动 flush
        let p2 = aligner.flush().unwrap();
        assert_eq!(p2.timestamp_us, 10000);
        assert_eq!(p2.values, vec![Some(10.0), Some(9.5), Some(28.0)]);
    }

    #[test]
    fn test_teleplot_aligner_dynamic_channels() {
        let mut aligner = TeleplotAligner::new();
        aligner.feed("voltage", 3.3, 1000);
        aligner.feed("current", 0.45, 1050);

        assert_eq!(aligner.channel_order(), &["voltage", "current"]);
        let p = aligner.flush().unwrap();
        assert_eq!(p.values, vec![Some(3.3), Some(0.45)]);
    }

    #[test]
    fn test_teleplot_aligner_sparse_channels() {
        let mut aligner = TeleplotAligner::new();
        // 周期 1: 3 个通道
        aligner.feed("ch0", 1.0, 1000);
        aligner.feed("ch1", 2.0, 1010);
        aligner.feed("ch2", 3.0, 1020);

        // 周期 2: 仅更新 ch0 和 ch2 (ch1 未更新)
        let p1 = aligner.feed("ch0", 1.5, 11000).unwrap();
        assert_eq!(p1.values, vec![Some(1.0), Some(2.0), Some(3.0)]);

        aligner.feed("ch2", 3.5, 11020);
        // 周期 3
        let p2 = aligner.feed("ch0", 2.0, 21000).unwrap();
        // 周期 2 中 ch1 没有更新，因此应为 None！
        assert_eq!(p2.values, vec![Some(1.5), None, Some(3.5)]);
    }
}


