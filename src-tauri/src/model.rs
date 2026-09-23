use serde::{Deserialize, Serialize};
use crate::config::ChannelMapping;

/// 串口连接配置 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
}

/// 统一时序采样点数据模型 (PRD 2.4.2 PR-001)
/// 支持 Teleplot 稀疏通道异步更新 (values 包含 Option<f64>)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SamplePoint {
    pub timestamp_us: u64,
    pub values: Vec<Option<f64>>,
}

/// 60Hz IPC 聚合分发给前端的波形批次数据结构 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WaveformBatch {
    pub session_id: String,
    pub channel_epoch: u64,
    pub channel_names: Vec<String>,
    pub points: Vec<SamplePoint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timestamps: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub series: Vec<Vec<f64>>,
}

/// 日志方向 (Rx 接收 / Tx 发送)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogDirection {
    Rx,
    Tx,
}

/// 日志等级 (Info / Warn / Error / Data) (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Data,
}

/// 格式化日志行数据结构 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogLine {
    pub timestamp_us: u64,
    pub direction: LogDirection,
    pub level: LogLevel,
    pub text: String,
    pub raw_hex: Option<String>,
}

/// 阶跃性能四大工程指标 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct StepMetrics {
    pub overshoot_percent: Option<f64>,
    pub settling_time_s: Option<f64>,
    pub rise_time_s: Option<f64>,
    pub steady_state_error: Option<f64>,
    // 兼容性与辅助字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overshoot_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y0: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_target: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_ss: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_stable: Option<bool>,
}

/// 阶跃分析状态 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepAnalysisStatus {
    Completed,
    Interrupted,
    InsufficientData,
}

/// ECharts 五维品质雷达图各项得分 (0 ~ 100 分)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct QualityScores {
    pub overshoot_score: f64,
    pub speed_score: f64,
    pub steady_score: f64,
    pub damping_score: f64,
    pub robust_score: f64,
}

/// 独立的阶跃响应切片快照 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepSnapshot {
    pub id: String,
    pub session_id: String,
    pub timestamp_us: u64,
    pub target_before: f64,
    pub target_after: f64,
    pub channel_binding: ChannelMapping,
    pub status: StepAnalysisStatus,
    pub metrics: StepMetrics,
    pub quality_scores: QualityScores,
    pub offline_advice: Option<String>,
    pub samples: Vec<SamplePoint>,
    // 兼容字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_amplitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_channel: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relative_times: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_series: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actual_series: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_series: Vec<f64>,
}

/// PID 参数组 (PRD 2.4.2 PR-001)
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PidParams {
    pub kp: f64,
    pub ki: f64,
    pub kd: f64,
}

impl Default for PidParams {
    fn default() -> Self {
        Self {
            kp: 1.80,
            ki: 0.60,
            kd: 0.25,
        }
    }
}

/// 校验和计算结果 (PR-001 calculate_checksums)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChecksumResult {
    pub crc16_modbus: u16,
    pub crc16_modbus_hex_le: String,
    pub crc16_modbus_hex_be: String,
    pub crc32: u32,
    pub crc32_hex: String,
    pub sum8: u8,
    pub sum8_hex: String,
    pub xor8: u8,
    pub xor8_hex: String,
}

impl ChecksumResult {
    pub fn from_bytes(data: &[u8]) -> Self {
        // 1. Modbus CRC16 (poly 0xA001, init 0xFFFF, low byte first)
        let mut crc16: u16 = 0xFFFF;
        for &byte in data {
            crc16 ^= byte as u16;
            for _ in 0..8 {
                if (crc16 & 0x0001) != 0 {
                    crc16 = (crc16 >> 1) ^ 0xA001;
                } else {
                    crc16 >>= 1;
                }
            }
        }
        let low = (crc16 & 0xFF) as u8;
        let high = ((crc16 >> 8) & 0xFF) as u8;
        let crc16_modbus_hex_le = format!("{:02X} {:02X}", low, high);
        let crc16_modbus_hex_be = format!("{:02X} {:02X}", high, low);

        // 2. IEEE 802.3 CRC32
        let mut crc32: u32 = 0xFFFFFFFF;
        for &byte in data {
            crc32 ^= byte as u32;
            for _ in 0..8 {
                if (crc32 & 1) != 0 {
                    crc32 = (crc32 >> 1) ^ 0xEDB88320;
                } else {
                    crc32 >>= 1;
                }
            }
        }
        crc32 ^= 0xFFFFFFFF;
        let crc32_hex = format!("{:08X}", crc32);

        // 3. Sum8
        let sum8: u8 = data.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
        let sum8_hex = format!("{:02X}", sum8);

        // 4. XOR8
        let xor8: u8 = data.iter().fold(0u8, |acc, &b| acc ^ b);
        let xor8_hex = format!("{:02X}", xor8);

        Self {
            crc16_modbus: crc16,
            crc16_modbus_hex_le,
            crc16_modbus_hex_be,
            crc32,
            crc32_hex,
            sum8,
            sum8_hex,
            xor8,
            xor8_hex,
        }
    }
}

/// 串口状态事件负载 (PRD 2.4.4 serial://status)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SerialStatusEvent {
    pub is_connected: bool,
    pub port: Option<String>,
    pub session_id: String,
    pub channel_epoch: u64,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reappeared: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sample_point_sparse_serialization() {
        let sp = SamplePoint {
            timestamp_us: 1000,
            values: vec![Some(10.0), None, Some(30.1)],
        };
        let json = serde_json::to_string(&sp).unwrap();
        assert!(json.contains("null"));
        let deserialized: SamplePoint = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, sp);
        assert_eq!(deserialized.values[1], None);
    }

    #[test]
    fn test_waveform_batch_serialization() {
        let wb = WaveformBatch {
            session_id: "sess_123".to_string(),
            channel_epoch: 1,
            channel_names: vec!["sp".to_string(), "act".to_string()],
            points: vec![SamplePoint {
                timestamp_us: 1000,
                values: vec![Some(1.0), Some(2.0)],
            }],
            timestamps: vec![],
            series: vec![],
        };
        let json = serde_json::to_string(&wb).unwrap();
        assert!(json.contains("sess_123"));
        assert!(json.contains("channel_epoch"));
        assert!(json.contains("points"));
        let deserialized: WaveformBatch = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.session_id, "sess_123");
        assert_eq!(deserialized.channel_epoch, 1);
        assert_eq!(deserialized.points.len(), 1);
    }

    #[test]
    fn test_log_line_with_raw_hex() {
        let ll = LogLine {
            timestamp_us: 2000,
            direction: LogDirection::Rx,
            level: LogLevel::Data,
            text: "10.0,9.2,30.1".to_string(),
            raw_hex: Some("31 30 2E 30".to_string()),
        };
        let json = serde_json::to_string(&ll).unwrap();
        assert!(json.contains("Data"));
        assert!(json.contains("31 30 2E 30"));
        let deserialized: LogLine = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, ll);
    }

    #[test]
    fn test_step_snapshot_serialization() {
        let snap = StepSnapshot {
            id: "step_100".to_string(),
            session_id: "sess_456".to_string(),
            timestamp_us: 500_000,
            target_before: 0.0,
            target_after: 10.0,
            channel_binding: ChannelMapping::default(),
            status: StepAnalysisStatus::Completed,
            metrics: StepMetrics {
                overshoot_percent: Some(15.2),
                settling_time_s: Some(1.2),
                rise_time_s: Some(0.35),
                steady_state_error: Some(0.01),
                ..Default::default()
            },
            quality_scores: QualityScores {
                overshoot_score: 85.0,
                speed_score: 90.0,
                steady_score: 98.0,
                damping_score: 80.0,
                robust_score: 85.0,
            },
            offline_advice: Some("超调偏高，建议调小 Kp".to_string()),
            samples: vec![SamplePoint {
                timestamp_us: 500_000,
                values: vec![Some(0.0), Some(0.0), Some(0.0)],
            }],
            step_amplitude: Some(10.0),
            target_channel: None,
            actual_channel: None,
            relative_times: vec![],
            target_series: vec![],
            actual_series: vec![],
            output_series: vec![],
        };

        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("Completed"));
        assert!(json.contains("overshoot_percent"));
        assert!(json.contains("quality_scores"));
        let deserialized: StepSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "step_100");
        assert_eq!(deserialized.status, StepAnalysisStatus::Completed);
        assert_eq!(deserialized.metrics.overshoot_percent, Some(15.2));
    }

    #[test]
    fn test_checksum_calculation() {
        // 标准测试向量: ASCII "123456789" (0x31..0x39)
        let data = b"123456789";
        let res = ChecksumResult::from_bytes(data);
        assert_eq!(res.crc16_modbus, 0x4B37);
        assert_eq!(res.crc16_modbus_hex_le, "37 4B");
        assert_eq!(res.crc16_modbus_hex_be, "4B 37");
        assert_eq!(res.crc32, 0xCBF43926);
        assert_eq!(res.crc32_hex, "CBF43926");
        assert_eq!(res.sum8, 0xDD);
        assert_eq!(res.sum8_hex, "DD");
        assert_eq!(res.xor8, 0x31);
        assert_eq!(res.xor8_hex, "31");

        // Modbus RTU 常用帧: 01 03 00 00 00 02 => CRC16: 0x0BC4 => LE: "C4 0B", BE: "0B C4"
        let modbus_frame = [0x01, 0x03, 0x00, 0x00, 0x00, 0x02];
        let res2 = ChecksumResult::from_bytes(&modbus_frame);
        assert_eq!(res2.crc16_modbus, 0x0BC4);
        assert_eq!(res2.crc16_modbus_hex_le, "C4 0B");
        assert_eq!(res2.crc16_modbus_hex_be, "0B C4");
    }
}
