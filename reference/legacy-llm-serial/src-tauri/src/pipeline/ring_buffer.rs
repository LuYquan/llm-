use std::collections::VecDeque;

pub use crate::model::{LogDirection, LogLevel, LogLine, SamplePoint, WaveformBatch};

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
/// 固定存储最近 60 秒原始数据 (按 1kHz 计算约为 60,000 点)，支持稀疏通道存储与查询
pub struct TimeSeriesRingBuffer {
    capacity: usize,
    num_channels: usize,
    channel_names: Vec<String>,
    session_id: String,
    channel_epoch: u64,
    points: VecDeque<SamplePoint>,
    timestamps: Vec<f64>,
    series: Vec<Vec<f64>>,
    head: usize,
    len: usize,
    total_pushed: u64,
    dropped_bytes: u64,
}

impl TimeSeriesRingBuffer {
    pub fn new(capacity: usize, mut channel_names: Vec<String>) -> Self {
        let capacity = capacity.max(1);
        if channel_names.is_empty() {
            channel_names.push("ch0".to_string());
        }
        let num_channels = channel_names.len();
        let mut series = Vec::with_capacity(num_channels);
        for _ in 0..num_channels {
            series.push(vec![0.0; capacity]);
        }

        Self {
            capacity,
            num_channels,
            channel_names,
            session_id: "default_session".to_string(),
            channel_epoch: 0,
            points: VecDeque::with_capacity(capacity),
            timestamps: vec![0.0; capacity],
            series,
            head: 0,
            len: 0,
            total_pushed: 0,
            dropped_bytes: 0,
        }
    }

    pub fn set_session_info(&mut self, session_id: String, channel_epoch: u64) {
        self.session_id = session_id;
        self.channel_epoch = channel_epoch;
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn channel_epoch(&self) -> u64 {
        self.channel_epoch
    }

    /// 压入一个新时序采样点 (时间单位: 秒, 全量通道数组)
    pub fn push(&mut self, timestamp: f64, values: &[f64]) {
        let sample = SamplePoint {
            timestamp_us: (timestamp * 1_000_000.0) as u64,
            values: values.iter().map(|&v| Some(v)).collect(),
        };
        self.push_sample(&sample);
    }

    /// 压入 SamplePoint (支持稀疏通道 Option<f64>)
    pub fn push_sample(&mut self, sample: &SamplePoint) {
        if self.points.len() >= self.capacity {
            self.points.pop_front();
            self.dropped_bytes += (self.num_channels * 8 + 8) as u64;
        }
        self.points.push_back(sample.clone());

        let t_sec = sample.timestamp_us as f64 / 1_000_000.0;
        let num_ch = sample.values.len();
        if num_ch > self.num_channels {
            for i in self.num_channels..num_ch {
                self.series.push(vec![0.0; self.capacity]);
                self.channel_names.push(format!("ch{}", i));
            }
            self.num_channels = num_ch;
        }

        self.timestamps[self.head] = t_sec;
        for (ch_idx, s) in self.series.iter_mut().enumerate() {
            let val = match sample.values.get(ch_idx).copied().flatten() {
                Some(v) => v,
                None => {
                    // 前值保持 (PRD §2.4.2 & engineering-decisions 6)
                    if self.len > 0 {
                        let prev_idx = if self.head == 0 {
                            self.capacity - 1
                        } else {
                            self.head - 1
                        };
                        s[prev_idx]
                    } else {
                        0.0
                    }
                }
            };
            s[self.head] = val;
        }

        self.head = (self.head + 1) % self.capacity;
        if self.len < self.capacity {
            self.len += 1;
        }
        self.total_pushed += 1;
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

    /// Replace the active display channels at a session/protocol boundary.
    /// Old samples and backing series must not leak into the new channel schema.
    pub fn reset_channels(&mut self, mut names: Vec<String>) {
        if names.is_empty() {
            names.push("ch0".to_string());
        }
        self.clear();
        self.num_channels = names.len();
        self.channel_names = names;
        self.series = (0..self.num_channels)
            .map(|_| vec![0.0; self.capacity])
            .collect();
    }

    pub fn channel_names(&self) -> &[String] {
        &self.channel_names
    }

    pub fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }

    pub fn add_dropped_bytes(&mut self, bytes: u64) {
        self.dropped_bytes += bytes;
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

        // 提取 new points
        let points_start = self.points.len().saturating_sub(count);
        let points: Vec<SamplePoint> = self.points.range(points_start..).cloned().collect();

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
            session_id: self.session_id.clone(),
            channel_epoch: self.channel_epoch,
            channel_names: self.channel_names.clone(),
            points,
            timestamps,
            series,
            dropped_bytes: self.dropped_bytes,
        };

        (Some(batch), self.total_pushed)
    }

    /// 按时间段获取 Rust 环形缓冲降采样历史数据 (PR-001 get_waveform_window)
    pub fn get_window(
        &self,
        start_us: u64,
        end_us: u64,
        max_points: usize,
    ) -> Option<WaveformBatch> {
        if start_us > end_us || self.points.is_empty() {
            return None;
        }

        let in_range: Vec<SamplePoint> = self
            .points
            .iter()
            .filter(|p| p.timestamp_us >= start_us && p.timestamp_us <= end_us)
            .cloned()
            .collect();

        if in_range.is_empty() {
            return None;
        }

        let points = if max_points == 0 || in_range.len() <= max_points {
            in_range
        } else if max_points == 1 {
            vec![in_range[0].clone()]
        } else if max_points == 2 {
            vec![in_range[0].clone(), in_range.last().unwrap().clone()]
        } else {
            let n = in_range.len();
            let num_channels = self.channel_names.len();
            // LTTB (Largest Triangle Three Buckets) 降采样
            // 保证视窗渲染性能的同时 100% 保留极值波峰波谷，并精确返回 max_points 个时序切片点
            let bucket_size = (n - 2) as f64 / (max_points - 2) as f64;
            let mut sampled = Vec::with_capacity(max_points);

            // 总是保留第一个点 (Point A 初始点)
            sampled.push(in_range[0].clone());
            let mut a_idx = 0;

            for i in 0..(max_points - 2) {
                // 当前分桶区间 [start_b, end_b)
                let start_b = ((i as f64 * bucket_size).floor() as usize + 1).min(n - 1);
                let end_b = (((i + 1) as f64 * bucket_size).floor() as usize + 1).min(n - 1);
                let end_b = end_b.max(start_b + 1);

                // 下一个分桶区间 [start_c, end_c)，用于计算中心点 C
                let (avg_t, avg_vals) = if i + 1 < max_points - 2 {
                    let start_c = (((i + 1) as f64 * bucket_size).floor() as usize + 1).min(n);
                    let end_c = (((i + 2) as f64 * bucket_size).floor() as usize + 1).min(n);
                    let end_c = end_c.max(start_c + 1).min(n);

                    let count = (end_c - start_c).max(1) as f64;
                    let mut sum_t = 0.0;
                    let mut sum_v = vec![0.0; num_channels];
                    for p in &in_range[start_c..end_c] {
                        sum_t += p.timestamp_us as f64;
                        for ch in 0..num_channels {
                            sum_v[ch] += p.values.get(ch).and_then(|v| *v).unwrap_or(0.0);
                        }
                    }
                    (
                        sum_t / count,
                        sum_v.into_iter().map(|s| s / count).collect::<Vec<_>>(),
                    )
                } else {
                    let last = &in_range[n - 1];
                    let vals = (0..num_channels)
                        .map(|ch| last.values.get(ch).and_then(|v| *v).unwrap_or(0.0))
                        .collect();
                    (last.timestamp_us as f64, vals)
                };

                let t_a = in_range[a_idx].timestamp_us as f64;
                let mut max_area = -1.0;
                let mut best_idx = start_b;

                for p_idx in start_b..end_b {
                    let t_p = in_range[p_idx].timestamp_us as f64;
                    let mut total_area = 0.0;

                    for ch in 0..num_channels {
                        let v_a = in_range[a_idx]
                            .values
                            .get(ch)
                            .and_then(|v| *v)
                            .unwrap_or(0.0);
                        let v_p = in_range[p_idx]
                            .values
                            .get(ch)
                            .and_then(|v| *v)
                            .unwrap_or(0.0);
                        let v_c = avg_vals.get(ch).copied().unwrap_or(0.0);

                        // 三角形面积公式: 0.5 * |(t_a - avg_t)*(v_p - v_a) - (t_a - t_p)*(v_c - v_a)|
                        let area = ((t_a - avg_t) * (v_p - v_a) - (t_a - t_p) * (v_c - v_a)).abs();
                        total_area += area;
                    }

                    if total_area > max_area {
                        max_area = total_area;
                        best_idx = p_idx;
                    }
                }

                sampled.push(in_range[best_idx].clone());
                a_idx = best_idx;
            }

            // 总是保留最后一个点
            sampled.push(in_range[n - 1].clone());
            sampled
        };

        let num_channels = self.channel_names.len();
        let mut timestamps = Vec::with_capacity(points.len());
        let mut series = vec![Vec::with_capacity(points.len()); num_channels];

        for p in &points {
            timestamps.push(p.timestamp_us as f64 / 1_000_000.0);
            for (ch_idx, s) in series.iter_mut().enumerate() {
                let val = p.values.get(ch_idx).and_then(|v| *v).unwrap_or(0.0);
                s.push(val);
            }
        }

        Some(WaveformBatch {
            session_id: self.session_id.clone(),
            channel_epoch: self.channel_epoch,
            channel_names: self.channel_names.clone(),
            points,
            timestamps,
            series,
            dropped_bytes: self.dropped_bytes,
        })
    }

    /// 获取最近的 n 个时序点
    pub fn get_recent(&self, n: usize) -> WaveformBatch {
        let count = n.min(self.len);
        let points_start = self.points.len().saturating_sub(count);
        let points: Vec<SamplePoint> = self.points.range(points_start..).cloned().collect();

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
            session_id: self.session_id.clone(),
            channel_epoch: self.channel_epoch,
            channel_names: self.channel_names.clone(),
            points,
            timestamps,
            series,
            dropped_bytes: self.dropped_bytes,
        }
    }

    /// 清空环形缓冲并重置计数器
    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
        self.total_pushed = 0;
        self.dropped_bytes = 0;
        self.points.clear();
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
        assert_eq!(b.points.len(), 3);

        // 再次从游标 3 读取，应该无新数据
        let (batch2, seq2) = rb.read_since(3);
        assert_eq!(seq2, 3);
        assert!(batch2.is_none());
    }

    #[test]
    fn test_ring_buffer_sparse_sample_point_and_forward_fill() {
        let mut rb = TimeSeriesRingBuffer::new(5, vec!["ch0".into(), "ch1".into()]);

        // 点 1: ch0=10.0, ch1=20.0
        rb.push_sample(&SamplePoint {
            timestamp_us: 1000,
            values: vec![Some(10.0), Some(20.0)],
        });

        // 点 2: 稀疏更新 ch0=None, ch1=25.0
        rb.push_sample(&SamplePoint {
            timestamp_us: 2000,
            values: vec![None, Some(25.0)],
        });

        let (batch, _) = rb.read_since(0);
        let b = batch.unwrap();

        // 验证稀疏 points
        assert_eq!(b.points[1].values[0], None);
        assert_eq!(b.points[1].values[1], Some(25.0));

        // 验证绘图前值保持 (ch0 保持 10.0)
        assert_eq!(b.series[0], vec![10.0, 10.0]);
        assert_eq!(b.series[1], vec![20.0, 25.0]);
    }

    #[test]
    fn test_ring_buffer_get_window_and_downsampling() {
        let mut rb = TimeSeriesRingBuffer::new(100, vec!["ch0".into()]);

        // 压入 50 个点 (t = 1000us ~ 50000us)
        for i in 1..=50 {
            rb.push_sample(&SamplePoint {
                timestamp_us: i * 1000,
                values: vec![Some(i as f64)],
            });
        }

        // 1. 查询子区间 [10000us, 30000us]，max_points=5
        let window = rb.get_window(10_000, 30_000, 5);
        assert!(window.is_some());
        let batch = window.unwrap();
        assert_eq!(batch.points.len(), 5);
        assert_eq!(batch.points.first().unwrap().timestamp_us, 10_000);
        assert_eq!(batch.points.last().unwrap().timestamp_us, 30_000);
        assert_eq!(batch.timestamps.len(), 5);
        assert_eq!(batch.series[0].len(), 5);

        // 2. 超出范围的查询返回 None
        let empty_win = rb.get_window(60_000, 70_000, 10);
        assert!(empty_win.is_none());

        // 3. 点数少于 max_points 时返回全部原始点
        let full_win = rb.get_window(10_000, 12_000, 10);
        assert!(full_win.is_some());
        assert_eq!(full_win.unwrap().points.len(), 3);
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
        assert_eq!(b.points.len(), 3);
        assert_eq!(b.points[0].timestamp_us, 200_000);
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
        assert!(rb.points.is_empty());

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
    fn test_log_ring_buffer_capacity_and_eviction() {
        let mut lrb = LogRingBuffer::new(3);
        assert_eq!(lrb.len(), 0);
        assert_eq!(lrb.capacity(), 3);

        lrb.push(LogLine {
            timestamp_us: 1000,
            direction: LogDirection::Rx,
            level: LogLevel::Info,
            text: "Line 1".to_string(),
            raw_hex: None,
            rx_origin: None,
        });
        lrb.push(LogLine {
            timestamp_us: 2000,
            direction: LogDirection::Rx,
            level: LogLevel::Warn,
            text: "Line 2".to_string(),
            raw_hex: None,
            rx_origin: None,
        });
        lrb.push(LogLine {
            timestamp_us: 3000,
            direction: LogDirection::Tx,
            level: LogLevel::Info,
            text: "Line 3".to_string(),
            raw_hex: None,
            rx_origin: None,
        });

        assert_eq!(lrb.len(), 3);
        assert_eq!(lrb.total_pushed(), 3);

        // 压入第 4 条，第 1 条被淘汰
        lrb.push(LogLine {
            timestamp_us: 4000,
            direction: LogDirection::Rx,
            level: LogLevel::Error,
            text: "Line 4".to_string(),
            raw_hex: None,
            rx_origin: None,
        });

        assert_eq!(lrb.len(), 3);
        assert_eq!(lrb.total_pushed(), 4);

        let (all_since_0, seq) = lrb.read_since(0);
        assert_eq!(seq, 4);
        assert_eq!(all_since_0.len(), 3);
        assert_eq!(all_since_0[0].text, "Line 2");
        assert_eq!(all_since_0[1].text, "Line 3");
        assert_eq!(all_since_0[2].text, "Line 4");
    }

    #[test]
    fn test_ring_buffer_get_window_peak_preservation() {
        // 验证峰值保留降采样 (Bucket Min-Max Downsampling)
        // 在 1000 个采样点中，大部分为 10.0，但在 t = 500ms 处存在一个 1 个采样的超调尖峰 28.5
        let mut rb = TimeSeriesRingBuffer::new(2000, vec!["ch0".into()]);
        for i in 0..1000 {
            let val = if i == 500 { 28.5 } else { 10.0 };
            rb.push_sample(&SamplePoint {
                timestamp_us: i * 1000,
                values: vec![Some(val)],
            });
        }

        // 降采样到 50 个点
        let win = rb
            .get_window(0, 1_000_000, 50)
            .expect("Window query failed");
        assert!(win.points.len() <= 50, "降采样点数不能超过 max_points");

        // 严格断言：尖峰 28.5 必须被 100% 保留！
        let has_peak = win.points.iter().any(|p| {
            p.values
                .get(0)
                .and_then(|v| *v)
                .map_or(false, |v| (v - 28.5).abs() < 1e-6)
        });
        assert!(has_peak, "尖峰 28.5 必须被降采样算法 100% 保留");
    }
}
