use std::collections::VecDeque;
use serde::{Deserialize, Serialize};

/// 日志方向 (Rx 接收 / Tx 发送)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogDirection {
    Rx,
    Tx,
}

/// 日志等级 (Info / Warn / Error)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// 格式化日志行数据结构 (PRD 2.4.1 LogLine)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogLine {
    pub timestamp_us: u64,
    pub direction: LogDirection,
    pub level: LogLevel,
    pub text: String,
}

/// 统一时序采样点数据模型 (PRD 2.4.1 SamplePoint)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplePoint {
    pub timestamp_us: u64,
    pub values: Vec<f64>,
}

/// 60Hz IPC 聚合分发给前端的波形批次数据结构
/// 采用列式存储 (Columnar)，前端 uPlot 可零转置直接消费
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaveformBatch {
    pub timestamps: Vec<f64>,
    pub series: Vec<Vec<f64>>,
    pub channel_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<SamplePoint>,
}

/// 固定容量文本日志环形缓冲 (PRD 2.2 / 2.4 / 4.1 & engineering-decisions 2.2)
/// 固定容量 2000 行，满载后自动淘汰最旧日志行，禁止动态无上限扩容
pub struct LogRingBuffer {
    capacity: usize,
    buffer: VecDeque<LogLine>,
    total_pushed: u64,
}

impl LogRingBuffer {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            buffer: VecDeque::with_capacity(capacity),
            total_pushed: 0,
        }
    }

    /// 压入一条新日志。若满载，自动淘汰最旧行
    pub fn push(&mut self, line: LogLine) {
        if self.buffer.len() >= self.capacity {
            self.buffer.pop_front();
        }
        self.buffer.push_back(line);
        self.total_pushed += 1;
    }

    /// 自上次游标读取新增的日志行 (用于 10Hz IPC 批量分发)
    pub fn read_since(&self, since_seq: u64) -> (Vec<LogLine>, u64) {
        let effective_since = if since_seq > self.total_pushed {
            0
        } else {
            since_seq
        };

        if self.total_pushed <= effective_since || self.buffer.is_empty() {
            return (Vec::new(), self.total_pushed);
        }

        let delta = self.total_pushed - effective_since;
        let count = (delta as usize).min(self.buffer.len());
        let start = self.buffer.len() - count;

        let lines = self.buffer.range(start..).cloned().collect();
        (lines, self.total_pushed)
    }

    /// 获取最近的 n 条日志
    pub fn get_recent(&self, n: usize) -> Vec<LogLine> {
        let count = n.min(self.buffer.len());
        let start = self.buffer.len() - count;
        self.buffer.range(start..).cloned().collect()
    }

    /// 清空日志环形缓冲
    pub fn clear(&mut self) {
        self.buffer.clear();
        self.total_pushed = 0;
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn total_pushed(&self) -> u64 {
        self.total_pushed
    }
}

impl Default for LogRingBuffer {
    fn default() -> Self {
        Self::new(2000)
    }
}

/// 固定容量多通道时序环形缓冲 (PRD 4.1 TimeSeriesRingBuffer & engineering-decisions 2.2)
/// 固定存储最近 60 秒原始数据 (按 1kHz 计算约为 60,000 点)，禁止动态无限扩容
pub struct TimeSeriesRingBuffer {
    capacity: usize,
    num_channels: usize,
    channel_names: Vec<String>,
    timestamps: Vec<f64>,
    series: Vec<Vec<f64>>,
    head: usize,
    len: usize,
    total_pushed: u64,
}

impl TimeSeriesRingBuffer {
    pub fn new(capacity: usize, channel_names: Vec<String>) -> Self {
        let capacity = capacity.max(1);
        let num_channels = channel_names.len().max(1);
        let mut series = Vec::with_capacity(num_channels);
        for _ in 0..num_channels {
            series.push(vec![0.0; capacity]);
        }

        Self {
            capacity,
            num_channels,
            channel_names,
            timestamps: vec![0.0; capacity],
            series,
            head: 0,
            len: 0,
            total_pushed: 0,
        }
    }

    /// 压入一个新时序采样点 (时间单位: 秒)
    pub fn push(&mut self, timestamp: f64, values: &[f64]) {
        // 若输入通道数超过当前缓冲容量，动态补充 series 通道以防止越界
        if values.len() > self.num_channels {
            for i in self.num_channels..values.len() {
                self.series.push(vec![0.0; self.capacity]);
                self.channel_names.push(format!("ch{}", i));
            }
            self.num_channels = values.len();
        }

        self.timestamps[self.head] = timestamp;
        for (ch_idx, s) in self.series.iter_mut().enumerate() {
            s[self.head] = *values.get(ch_idx).unwrap_or(&0.0);
        }

        self.head = (self.head + 1) % self.capacity;
        if self.len < self.capacity {
            self.len += 1;
        }
        self.total_pushed += 1;
    }

    /// 压入 SamplePoint (内部微秒自动转为秒)
    pub fn push_sample(&mut self, sample: &SamplePoint) {
        self.push(sample.timestamp_us as f64 / 1_000_000.0, &sample.values);
    }

    /// 更新通道名称
    pub fn set_channel_names(&mut self, names: Vec<String>) {
        if names.len() > self.num_channels {
            for _ in self.num_channels..names.len() {
                self.series.push(vec![0.0; self.capacity]);
            }
            self.num_channels = names.len();
        }
        self.channel_names = names;
    }

    pub fn channel_names(&self) -> &[String] {
        &self.channel_names
    }

    /// 自上次游标读取新增的时序数据点
    /// 返回 (Option<WaveformBatch>, 当前最新游标)
    pub fn read_since(&self, since_seq: u64) -> (Option<WaveformBatch>, u64) {
        let effective_since = if since_seq > self.total_pushed {
            0
        } else {
            since_seq
        };

        if self.total_pushed <= effective_since || self.len == 0 {
            return (None, self.total_pushed);
        }

        let delta = self.total_pushed - effective_since;
        let count = (delta as usize).min(self.len);

        let mut timestamps = Vec::with_capacity(count);
        let mut series = vec![Vec::with_capacity(count); self.num_channels];

        let start_offset = if self.head >= count {
            self.head - count
        } else {
            self.capacity + self.head - count
        };

        for i in 0..count {
            let idx = (start_offset + i) % self.capacity;
            timestamps.push(self.timestamps[idx]);
            for ch in 0..self.num_channels {
                series[ch].push(self.series[ch][idx]);
            }
        }

        let batch = WaveformBatch {
            timestamps,
            series,
            channel_names: self.channel_names.clone(),
            points: Vec::new(),
        };

        (Some(batch), self.total_pushed)
    }

    /// 获取最近的 n 个时序点
    pub fn get_recent(&self, n: usize) -> WaveformBatch {
        let count = n.min(self.len);
        let mut timestamps = Vec::with_capacity(count);
        let mut series = vec![Vec::with_capacity(count); self.num_channels];

        let start_offset = if self.head >= count {
            self.head - count
        } else {
            self.capacity + self.head - count
        };

        for i in 0..count {
            let idx = (start_offset + i) % self.capacity;
            timestamps.push(self.timestamps[idx]);
            for ch in 0..self.num_channels {
                series[ch].push(self.series[ch][idx]);
            }
        }

        WaveformBatch {
            timestamps,
            series,
            channel_names: self.channel_names.clone(),
            points: Vec::new(),
        }
    }

    /// 清空环形缓冲并重置计数器
    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
        self.total_pushed = 0;
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn total_pushed(&self) -> u64 {
        self.total_pushed
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ring_buffer_push_and_read_since() {
        let mut rb = TimeSeriesRingBuffer::new(5, vec!["ch0".into(), "ch1".into()]);
        assert_eq!(rb.len(), 0);

        // 压入 3 个点
        rb.push(0.01, &[1.0, 2.0]);
        rb.push(0.02, &[1.1, 2.1]);
        rb.push(0.03, &[1.2, 2.2]);
        assert_eq!(rb.len(), 3);
        assert_eq!(rb.total_pushed(), 3);

        // 从游标 0 读取
        let (batch, seq) = rb.read_since(0);
        assert_eq!(seq, 3);
        let b = batch.unwrap();
        assert_eq!(b.timestamps, vec![0.01, 0.02, 0.03]);
        assert_eq!(b.series[0], vec![1.0, 1.1, 1.2]);
        assert_eq!(b.series[1], vec![2.0, 2.1, 2.2]);

        // 再次从游标 3 读取，应该无新数据
        let (batch2, seq2) = rb.read_since(3);
        assert_eq!(seq2, 3);
        assert!(batch2.is_none());
    }

    #[test]
    fn test_ring_buffer_overflow() {
        let mut rb = TimeSeriesRingBuffer::new(3, vec!["ch0".into()]);
        // 压入 4 个点，发生环回覆盖
        rb.push(0.1, &[10.0]);
        rb.push(0.2, &[20.0]);
        rb.push(0.3, &[30.0]);
        rb.push(0.4, &[40.0]);

        assert_eq!(rb.len(), 3);
        assert_eq!(rb.total_pushed(), 4);

        let (batch, seq) = rb.read_since(0);
        assert_eq!(seq, 4);
        let b = batch.unwrap();
        // 最旧的 0.1 被覆盖，保留 0.2, 0.3, 0.4
        assert_eq!(b.timestamps, vec![0.2, 0.3, 0.4]);
        assert_eq!(b.series[0], vec![20.0, 30.0, 40.0]);
    }

    #[test]
    fn test_ring_buffer_reset_recovery() {
        let mut rb = TimeSeriesRingBuffer::new(5, vec!["ch0".into()]);
        rb.push(0.1, &[10.0]);
        rb.push(0.2, &[20.0]);
        rb.push(0.3, &[30.0]);
        let (_, seq) = rb.read_since(0);
        assert_eq!(seq, 3);

        rb.clear();
        assert_eq!(rb.len(), 0);
        assert_eq!(rb.total_pushed(), 0);

        let (empty_batch, new_seq) = rb.read_since(3);
        assert!(empty_batch.is_none());
        assert_eq!(new_seq, 0);

        rb.push(1.0, &[100.0]);
        let (batch, new_seq2) = rb.read_since(3);
        assert_eq!(new_seq2, 1);
        let b = batch.unwrap();
        assert_eq!(b.timestamps, vec![1.0]);
        assert_eq!(b.series[0], vec![100.0]);
    }

    #[test]
    fn test_ring_buffer_get_recent() {
        let mut rb = TimeSeriesRingBuffer::new(4, vec!["ch0".into()]);
        for i in 1..=5 {
            rb.push(i as f64, &[(i * 10) as f64]);
        }
        let recent2 = rb.get_recent(2);
        assert_eq!(recent2.timestamps, vec![4.0, 5.0]);
        assert_eq!(recent2.series[0], vec![40.0, 50.0]);

        let recent10 = rb.get_recent(10);
        assert_eq!(recent10.timestamps, vec![2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn test_log_ring_buffer_capacity_and_eviction() {
        let mut lrb = LogRingBuffer::new(3);
        assert_eq!(lrb.len(), 0);
        assert_eq!(lrb.capacity(), 3);

        lrb.push(LogLine {
            timestamp_us: 1000,
            direction: LogDirection::Rx,
            level: LogLevel::Info,
            text: "Line 1".to_string(),
        });
        lrb.push(LogLine {
            timestamp_us: 2000,
            direction: LogDirection::Rx,
            level: LogLevel::Warn,
            text: "Line 2".to_string(),
        });
        lrb.push(LogLine {
            timestamp_us: 3000,
            direction: LogDirection::Tx,
            level: LogLevel::Info,
            text: "Line 3".to_string(),
        });

        assert_eq!(lrb.len(), 3);
        assert_eq!(lrb.total_pushed(), 3);

        // 压入第 4 条，第 1 条被淘汰
        lrb.push(LogLine {
            timestamp_us: 4000,
            direction: LogDirection::Rx,
            level: LogLevel::Error,
            text: "Line 4".to_string(),
        });

        assert_eq!(lrb.len(), 3);
        assert_eq!(lrb.total_pushed(), 4);

        let (all_since_0, seq) = lrb.read_since(0);
        assert_eq!(seq, 4);
        assert_eq!(all_since_0.len(), 3);
        assert_eq!(all_since_0[0].text, "Line 2");
        assert_eq!(all_since_0[1].text, "Line 3");
        assert_eq!(all_since_0[2].text, "Line 4");

        // 从游标 3 读取，应只有 Line 4
        let (delta, seq2) = lrb.read_since(3);
        assert_eq!(seq2, 4);
        assert_eq!(delta.len(), 1);
        assert_eq!(delta[0].text, "Line 4");

        // get_recent
        let recent2 = lrb.get_recent(2);
        assert_eq!(recent2.len(), 2);
        assert_eq!(recent2[0].text, "Line 3");
        assert_eq!(recent2[1].text, "Line 4");

        // clear
        lrb.clear();
        assert_eq!(lrb.len(), 0);
        assert_eq!(lrb.total_pushed(), 0);
    }
}

