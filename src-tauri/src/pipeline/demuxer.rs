use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::parser::{TeleplotAligner, TextParser};
use super::ring_buffer::{LogDirection, LogLine, SamplePoint};

/// 智能分流输出事件 (ADR 0002 & PRD 4.1 StreamDemuxer)
#[derive(Debug, Clone, PartialEq)]
pub enum DemuxOutput {
    /// 完整对齐或解析出的多通道采样点 (路由至 TimeSeriesRingBuffer)
    Sample(SamplePoint),
    /// 文本调试或系统日志行 (路由至 LogRingBuffer)
    Log(LogLine),
    /// 静默丢弃或正在暂存 (空行、部分 Teleplot 变量正在累积中、或解析错误已统计)
    None,
}

/// 智能分流器 (StreamDemuxer)
///
/// 核心职责：
/// 1. 逐行扫描单片机上行流：
///    - 以 `>` 开头：路由至 Teleplot 解析，并经 `TeleplotAligner` 进行微秒时间对齐；
///    - 包含 `,` (且非日志前缀)：路由至 CSV 解析；
///    - 其余非数值文本 (如 `[INFO]...`, `Booting...`)：路由至 `LogRingBuffer`；
/// 2. 脏数据与解析异常容错：严禁 Panic，统一累计错误计数后静默丢弃；
/// 3. 通道动态注册与对齐。
pub struct StreamDemuxer {
    teleplot_aligner: TeleplotAligner,
    error_count: Arc<AtomicU64>,
    channel_names: Vec<String>,
}

impl StreamDemuxer {
    pub fn new() -> Self {
        Self {
            teleplot_aligner: TeleplotAligner::new(),
            error_count: Arc::new(AtomicU64::new(0)),
            channel_names: vec![
                "setpoint".to_string(),
                "actual".to_string(),
                "output".to_string(),
            ],
        }
    }

    pub fn with_channels(channels: Vec<String>) -> Self {
        Self {
            teleplot_aligner: TeleplotAligner::new(),
            error_count: Arc::new(AtomicU64::new(0)),
            channel_names: channels,
        }
    }

    pub fn with_error_counter(counter: Arc<AtomicU64>) -> Self {
        Self {
            teleplot_aligner: TeleplotAligner::new(),
            error_count: counter,
            channel_names: vec![
                "setpoint".to_string(),
                "actual".to_string(),
                "output".to_string(),
            ],
        }
    }

    /// 逐行分流与解析
    pub fn demux_line(
        &mut self,
        line: &str,
        timestamp_us: u64,
        direction: LogDirection,
    ) -> DemuxOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return DemuxOutput::None;
        }

        // 1. Teleplot 路由：以 `>` 开头
        if trimmed.starts_with('>') {
            if let Some((name, val)) = TextParser::parse_teleplot_line(trimmed) {
                if let Some(sample) = self.teleplot_aligner.feed(&name, val, timestamp_us) {
                    return DemuxOutput::Sample(sample);
                } else {
                    return DemuxOutput::None;
                }
            } else {
                // 格式非法的 Teleplot 键值对行，累加脏数据计数并静默丢弃 (绝不 Panic)
                self.error_count.fetch_add(1, Ordering::Relaxed);
                return DemuxOutput::None;
            }
        }

        // 2. 明确的日志前缀过滤 (即使包含逗号，如 `[INFO] System ready, 3 sensors found`)
        let upper = trimmed.to_ascii_uppercase();
        if trimmed.starts_with('[')
            || trimmed.starts_with('#')
            || trimmed.starts_with("//")
            || upper.starts_with("INFO:")
            || upper.starts_with("WARN:")
            || upper.starts_with("ERROR:")
            || upper.starts_with("DEBUG:")
        {
            let log = TextParser::parse_log_line(trimmed, timestamp_us, direction);
            return DemuxOutput::Log(log);
        }

        // 3. CSV 路由：包含英文逗号 `,`
        if trimmed.contains(',') {
            if let Some(values) =
                TextParser::parse_csv_line_with_metrics(trimmed, None)
            {
                // 自动补齐通道名
                if self.channel_names.len() < values.len() {
                    for i in self.channel_names.len()..values.len() {
                        self.channel_names.push(format!("ch{}", i));
                    }
                }
                return DemuxOutput::Sample(SamplePoint {
                    timestamp_us,
                    values: values.into_iter().map(Some).collect(),
                });
            } else {
                // 包含逗号但不满足纯数值 CSV。
                // 检查：如果第一个字段可解析为浮点数（例如 "10.0,??#$%,30.0"），则判定为损坏的 CSV 行，统计错误并静默丢弃；
                // 否则（例如 "System booted, ready for command"），判定为含逗号的普通文本日志，路由至日志缓冲。
                let first_part = trimmed.split(',').next().unwrap_or("").trim();
                let starts_with_number = first_part.parse::<f64>().is_ok();

                if starts_with_number {
                    self.error_count.fetch_add(1, Ordering::Relaxed);
                    return DemuxOutput::None;
                } else {
                    let log = TextParser::parse_log_line(trimmed, timestamp_us, direction);
                    return DemuxOutput::Log(log);
                }
            }
        }

        // 4. 其余所有非数值文本，路由至日志缓冲
        let log = TextParser::parse_log_line(trimmed, timestamp_us, direction);
        DemuxOutput::Log(log)
    }

    /// 强制刷新 Teleplot 对齐器中尚未打包的采样点
    pub fn flush(&mut self) -> Option<SamplePoint> {
        self.teleplot_aligner.flush()
    }

    /// 获取累计解析与格式错误计数
    pub fn error_count(&self) -> u64 {
        self.error_count.load(Ordering::Relaxed)
    }

    /// 获取当前通道名称列表
    pub fn channel_names(&self) -> &[String] {
        if !self.teleplot_aligner.channel_order().is_empty() {
            self.teleplot_aligner.channel_order()
        } else {
            &self.channel_names
        }
    }

    /// 重置分流器内部状态与错误计数
    pub fn reset(&mut self) {
        self.teleplot_aligner.reset();
        self.error_count.store(0, Ordering::Relaxed);
        self.channel_names = vec![
            "setpoint".to_string(),
            "actual".to_string(),
            "output".to_string(),
        ];
    }
}

impl Default for StreamDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_demux_csv_line() {
        let mut demuxer = StreamDemuxer::new();
        let out = demuxer.demux_line("10.0,9.2,30.1\n", 1000, LogDirection::Rx);
        match out {
            DemuxOutput::Sample(s) => {
                assert_eq!(s.timestamp_us, 1000);
                assert_eq!(s.values, vec![Some(10.0), Some(9.2), Some(30.1)]);
            }
            _ => panic!("Expected DemuxOutput::Sample"),
        }
    }

    #[test]
    fn test_demux_teleplot_alignment() {
        let mut demuxer = StreamDemuxer::new();

        // 周期 1
        assert_eq!(
            demuxer.demux_line(">sp:10.0\n", 1000, LogDirection::Rx),
            DemuxOutput::None
        );
        assert_eq!(
            demuxer.demux_line(">act:9.2\n", 1010, LogDirection::Rx),
            DemuxOutput::None
        );
        assert_eq!(
            demuxer.demux_line(">out:30.1\n", 1020, LogDirection::Rx),
            DemuxOutput::None
        );

        // 周期 2: 重复出现 >sp，触发周期 1 的 SamplePoint 派发
        let out = demuxer.demux_line(">sp:10.0\n", 11000, LogDirection::Rx);
        match out {
            DemuxOutput::Sample(s) => {
                assert_eq!(s.timestamp_us, 1000);
                assert_eq!(s.values, vec![Some(10.0), Some(9.2), Some(30.1)]);
            }
            _ => panic!("Expected DemuxOutput::Sample on cycle rollover"),
        }
    }

    #[test]
    fn test_demux_log_line() {
        let mut demuxer = StreamDemuxer::new();

        // 带括号的日志
        let out = demuxer.demux_line("[INFO] System Boot OK\n", 500, LogDirection::Rx);
        match out {
            DemuxOutput::Log(l) => {
                assert_eq!(l.timestamp_us, 500);
                assert_eq!(l.text, "[INFO] System Boot OK");
            }
            _ => panic!("Expected DemuxOutput::Log"),
        }

        // 普通文本日志 (无逗号无前缀)
        let out2 = demuxer.demux_line("Motor initialized successfully\n", 600, LogDirection::Rx);
        match out2 {
            DemuxOutput::Log(l) => {
                assert_eq!(l.timestamp_us, 600);
                assert_eq!(l.text, "Motor initialized successfully");
            }
            _ => panic!("Expected DemuxOutput::Log"),
        }

        // 带逗号的日志行 (有 `[` 前缀)
        let out3 = demuxer.demux_line("[WARN] Voltage dropped, check supply\n", 700, LogDirection::Rx);
        match out3 {
            DemuxOutput::Log(l) => {
                assert_eq!(l.timestamp_us, 700);
                assert_eq!(l.text, "[WARN] Voltage dropped, check supply");
            }
            _ => panic!("Expected DemuxOutput::Log for log with comma"),
        }

        // 带逗号的日志行 (无任何特殊前缀，非数值开头)
        let out4 = demuxer.demux_line("System booted successfully, ready for commands\n", 800, LogDirection::Rx);
        match out4 {
            DemuxOutput::Log(l) => {
                assert_eq!(l.timestamp_us, 800);
                assert_eq!(l.text, "System booted successfully, ready for commands");
            }
            _ => panic!("Expected DemuxOutput::Log for non-numeric comma text"),
        }
        assert_eq!(demuxer.error_count(), 0);
    }

    #[test]
    fn test_demux_dirty_data_silent_drop_and_no_panic() {
        let mut demuxer = StreamDemuxer::new();

        // 1. 非法 Teleplot 行
        assert_eq!(
            demuxer.demux_line(">invalid_teleplot\n", 100, LogDirection::Rx),
            DemuxOutput::None
        );
        assert_eq!(
            demuxer.demux_line(">key:NaN\n", 200, LogDirection::Rx),
            DemuxOutput::None
        );
        assert_eq!(demuxer.error_count(), 2);

        // 2. 格式破损的 CSV 行
        assert_eq!(
            demuxer.demux_line("10.0,??#$%,30.0\n", 300, LogDirection::Rx),
            DemuxOutput::None
        );
        assert_eq!(demuxer.error_count(), 3);

        // 3. 空行
        assert_eq!(
            demuxer.demux_line("   \r\n", 400, LogDirection::Rx),
            DemuxOutput::None
        );
        assert_eq!(demuxer.error_count(), 3); // 空行不算错误

        // 4. 紧接着的正常 CSV 应正常通过
        let out = demuxer.demux_line("10.0,20.0,30.0\n", 500, LogDirection::Rx);
        match out {
            DemuxOutput::Sample(s) => {
                assert_eq!(s.values, vec![Some(10.0), Some(20.0), Some(30.0)]);
            }
            _ => panic!("Expected DemuxOutput::Sample"),
        }
        assert_eq!(demuxer.error_count(), 3);
    }

    #[test]
    fn test_demux_mixed_stream() {
        let mut demuxer = StreamDemuxer::new();

        // 混合流模拟：单片机同时输出波形与偶发日志
        let l1 = demuxer.demux_line("[INFO] Booting system\n", 1000, LogDirection::Rx);
        assert!(matches!(l1, DemuxOutput::Log(_)));

        let c1 = demuxer.demux_line("10.0,9.1,30.0\n", 2000, LogDirection::Rx);
        assert!(matches!(c1, DemuxOutput::Sample(_)));

        let l2 = demuxer.demux_line("[WARN] Over-temperature warning\n", 3000, LogDirection::Rx);
        assert!(matches!(l2, DemuxOutput::Log(_)));

        let c2 = demuxer.demux_line("10.0,9.3,29.5\n", 4000, LogDirection::Rx);
        assert!(matches!(c2, DemuxOutput::Sample(_)));
    }
}
