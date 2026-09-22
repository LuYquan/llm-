pub mod data_source;
pub mod demuxer;
pub mod parser;
pub mod ring_buffer;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use self::data_source::{DataSource, MockDataSource, SerialDataSource};
use self::demuxer::{DemuxOutput, StreamDemuxer};
use self::ring_buffer::{LogDirection, LogRingBuffer, TimeSeriesRingBuffer};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineStatus {
    pub is_running: bool,
    pub mode: String,
    pub sample_rate: f64,
    pub total_samples: u64,
    #[serde(default)]
    pub error_count: u64,
}

/// 数据管线管理器 (PRD 2.2 三级管道核心控制)
pub struct PipelineManager {
    is_running: Arc<AtomicBool>,
    mode: Arc<RwLock<String>>,
    total_samples: Arc<AtomicU64>,
    ring_buffer: Arc<RwLock<TimeSeriesRingBuffer>>,
    log_buffer: Arc<RwLock<LogRingBuffer>>,
    demuxer: Arc<RwLock<StreamDemuxer>>,
    start_instant: Arc<RwLock<Option<Instant>>>,
    last_rate_time: Arc<RwLock<Instant>>,
    last_rate_samples: Arc<AtomicU64>,
    current_sample_rate: Arc<RwLock<f64>>,
    shutdown_tx: Arc<RwLock<Option<tokio::sync::watch::Sender<bool>>>>,
    reset_signal: Arc<AtomicBool>,
}

impl PipelineManager {
    pub fn new() -> Self {
        let channel_names = vec![
            "setpoint".to_string(),
            "actual".to_string(),
            "output".to_string(),
        ];
        // 固定 60,000 点容量环形缓冲 (60 秒 @ 1kHz, engineering-decisions 2.2)
        let ring_buffer = Arc::new(RwLock::new(TimeSeriesRingBuffer::new(60_000, channel_names.clone())));
        // 固定 2,000 行文本日志队列 (engineering-decisions 2.2)
        let log_buffer = Arc::new(RwLock::new(LogRingBuffer::new(2000)));
        let demuxer = Arc::new(RwLock::new(StreamDemuxer::new()));

        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            mode: Arc::new(RwLock::new("mock".to_string())),
            total_samples: Arc::new(AtomicU64::new(0)),
            ring_buffer,
            log_buffer,
            demuxer,
            start_instant: Arc::new(RwLock::new(None)),
            last_rate_time: Arc::new(RwLock::new(Instant::now())),
            last_rate_samples: Arc::new(AtomicU64::new(0)),
            current_sample_rate: Arc::new(RwLock::new(0.0)),
            shutdown_tx: Arc::new(RwLock::new(None)),
            reset_signal: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动数据管线 (数据采集分流任务 + 60Hz 波形分发任务 + 10Hz 日志分发任务)
    pub async fn start(
        &self,
        app: AppHandle,
        mode_str: String,
        port_name: Option<String>,
        baud_rate: Option<u32>,
    ) -> Result<PipelineStatus, String> {
        // 如果正在运行，先停止旧任务
        if self.is_running.load(Ordering::SeqCst) {
            self.stop().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let mut data_source: Box<dyn DataSource> = if mode_str == "serial" {
            let port = port_name
                .filter(|p| !p.trim().is_empty())
                .ok_or_else(|| "未指定物理串口端口号 (如 COM3)".to_string())?;
            let baud = baud_rate.unwrap_or(115200);
            tracing::info!("Opening physical serial port: {} @ {} baud", port, baud);
            let serial = SerialDataSource::open(&port, baud, app.clone())?;
            Box::new(serial)
        } else {
            let start_samples = self.total_samples.load(Ordering::Relaxed);
            let dt = 0.01;
            let mut mock = MockDataSource::with_time(start_samples as f64 * dt);
            if mode_str.contains("teleplot") {
                mock.set_format(data_source::MockFormat::Teleplot);
            }
            Box::new(mock)
        };

        self.is_running.store(true, Ordering::SeqCst);

        // 创建多任务协调取消信道
        let (shutdown_tx, mut shutdown_rx_ingest) = tokio::sync::watch::channel(false);
        let mut shutdown_rx_waveform = shutdown_tx.subscribe();
        let mut shutdown_rx_logs = shutdown_tx.subscribe();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        {
            let mut mode = self.mode.write().await;
            *mode = mode_str.clone();
            let mut start_time = self.start_instant.write().await;
            *start_time = Some(Instant::now());
            let mut last_rt = self.last_rate_time.write().await;
            *last_rt = Instant::now();
            self.last_rate_samples.store(self.total_samples.load(Ordering::Relaxed), Ordering::Relaxed);
            let mut rate = self.current_sample_rate.write().await;
            *rate = if mode_str.starts_with("mock") { 100.0 } else { 0.0 };
        }

        let is_running_ingest = self.is_running.clone();
        let total_samples_ingest = self.total_samples.clone();
        let ring_buffer_ingest = self.ring_buffer.clone();
        let log_buffer_ingest = self.log_buffer.clone();
        let demuxer_ingest = self.demuxer.clone();
        let reset_signal_ingest = self.reset_signal.clone();

        // 任务 1: 数据采集与智能分流任务 (StreamDemuxer)
        tokio::spawn(async move {
            let mut pipeline_start = Instant::now();

            while is_running_ingest.load(Ordering::Relaxed) {
                // 检查是否收到重置信号，同步重置底层数据源与样本计数
                if reset_signal_ingest.swap(false, Ordering::SeqCst) {
                    data_source.reset();
                    pipeline_start = Instant::now();
                }

                tokio::select! {
                    _ = shutdown_rx_ingest.changed() => {
                        if *shutdown_rx_ingest.borrow() {
                            data_source.stop();
                            break;
                        }
                    }
                    read_res = data_source.read_line() => {
                        match read_res {
                            Ok(Some(line)) => {
                                let timestamp_us = pipeline_start.elapsed().as_micros() as u64;

                                let output = {
                                    let mut demux = demuxer_ingest.write().await;
                                    demux.demux_line(&line, timestamp_us, LogDirection::Rx)
                                };

                                match output {
                                    DemuxOutput::Sample(sample) => {
                                        let current_channels = {
                                            let dm = demuxer_ingest.read().await;
                                            dm.channel_names().to_vec()
                                        };
                                        let mut rb = ring_buffer_ingest.write().await;
                                        if !current_channels.is_empty() && rb.channel_names() != &current_channels {
                                            rb.set_channel_names(current_channels);
                                        }
                                        rb.push_sample(&sample);
                                        total_samples_ingest.fetch_add(1, Ordering::Relaxed);
                                    }
                                    DemuxOutput::Log(log_line) => {
                                        let mut lb = log_buffer_ingest.write().await;
                                        lb.push(log_line);
                                    }
                                    DemuxOutput::None => {}
                                }
                            }
                            Ok(None) => {
                                // 流结束时刷新可能暂存的最后一个 Teleplot 周期
                                let remaining_sample = {
                                    let mut demux = demuxer_ingest.write().await;
                                    demux.flush()
                                };
                                if let Some(sample) = remaining_sample {
                                    let current_channels = {
                                        let dm = demuxer_ingest.read().await;
                                        dm.channel_names().to_vec()
                                    };
                                    let mut rb = ring_buffer_ingest.write().await;
                                    if !current_channels.is_empty() && rb.channel_names() != &current_channels {
                                        rb.set_channel_names(current_channels);
                                    }
                                    rb.push_sample(&sample);
                                    total_samples_ingest.fetch_add(1, Ordering::Relaxed);
                                }
                                break;
                            }
                            Err(e) => {
                                tracing::warn!("[Pipeline Ingestion Error]: {}", e);
                                is_running_ingest.store(false, Ordering::SeqCst);
                                break;
                            }
                        }
                    }
                }
            }
            data_source.stop();
        });

        // 任务 2: 60Hz 波形聚合批次分发任务 (以 ~16.6ms 间隔发射 waveform://batch)
        let is_running_waveform = self.is_running.clone();
        let ring_buffer_waveform = self.ring_buffer.clone();
        let app_waveform = app.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(16));
            let mut last_seq: u64 = ring_buffer_waveform.read().await.total_pushed();

            while is_running_waveform.load(Ordering::Relaxed) {
                tokio::select! {
                    _ = shutdown_rx_waveform.changed() => {
                        if *shutdown_rx_waveform.borrow() {
                            break;
                        }
                    }
                    _ = interval.tick() => {
                        let rb = ring_buffer_waveform.read().await;
                        let (batch, new_seq) = rb.read_since(last_seq);
                        drop(rb);

                        if let Some(b) = batch {
                            last_seq = new_seq;
                            // 统一 IPC 事件名称 (PRD 2.4.3 & engineering-decisions 2.3)
                            let _ = app_waveform.emit("waveform://batch", &b);
                            // 保持向后兼容事件名
                            let _ = app_waveform.emit("waveform-batch", &b);
                        } else if new_seq < last_seq {
                            last_seq = new_seq;
                        }
                    }
                }
            }
        });

        // 任务 3: 10Hz 文本日志聚合批次分发任务 (以 100ms 间隔发射 logs://batch)
        let is_running_logs = self.is_running.clone();
        let log_buffer_logs = self.log_buffer.clone();
        let app_logs = app.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            let mut last_log_seq: u64 = log_buffer_logs.read().await.total_pushed();

            while is_running_logs.load(Ordering::Relaxed) {
                tokio::select! {
                    _ = shutdown_rx_logs.changed() => {
                        if *shutdown_rx_logs.borrow() {
                            break;
                        }
                    }
                    _ = interval.tick() => {
                        let lb = log_buffer_logs.read().await;
                        let (new_logs, new_seq) = lb.read_since(last_log_seq);
                        drop(lb);

                        if !new_logs.is_empty() {
                            last_log_seq = new_seq;
                            // 统一 IPC 事件名称 (PRD 2.4.3 & engineering-decisions 2.3)
                            let _ = app_logs.emit("logs://batch", &new_logs);
                        } else if new_seq < last_log_seq {
                            last_log_seq = new_seq;
                        }
                    }
                }
            }
        });

        Ok(self.get_status().await)
    }

    /// 停止数据管线
    pub async fn stop(&self) -> PipelineStatus {
        self.is_running.store(false, Ordering::SeqCst);
        if let Some(tx) = self.shutdown_tx.read().await.as_ref() {
            let _ = tx.send(true);
        }
        let mut rate = self.current_sample_rate.write().await;
        *rate = 0.0;
        self.get_status().await
    }

    /// 重置数据管线缓冲并通知前端
    pub async fn reset(&self, app: &AppHandle) -> PipelineStatus {
        self.reset_signal.store(true, Ordering::SeqCst);
        {
            let mut rb = self.ring_buffer.write().await;
            rb.clear();
        }
        {
            let mut lb = self.log_buffer.write().await;
            lb.clear();
        }
        {
            let mut dm = self.demuxer.write().await;
            dm.reset();
        }

        self.total_samples.store(0, Ordering::SeqCst);
        let mut start_time = self.start_instant.write().await;
        *start_time = Some(Instant::now());

        let _ = app.emit("waveform-reset", ());
        let _ = app.emit("waveform://reset", ());
        self.get_status().await
    }

    /// 获取当前管线运行状态与指标
    pub async fn get_status(&self) -> PipelineStatus {
        let is_running = self.is_running.load(Ordering::Relaxed);
        let mode = self.mode.read().await.clone();
        let total = self.total_samples.load(Ordering::Relaxed);
        let error_count = self.demuxer.read().await.error_count();

        let sample_rate = if is_running {
            if mode.starts_with("mock") {
                100.0
            } else {
                let now = Instant::now();
                let last_time = *self.last_rate_time.read().await;
                let dt = (now - last_time).as_secs_f64();
                if dt >= 0.5 {
                    let last_samples = self.last_rate_samples.load(Ordering::Relaxed);
                    let delta = total.saturating_sub(last_samples);
                    let rate = delta as f64 / dt;
                    *self.current_sample_rate.write().await = rate;
                    *self.last_rate_time.write().await = now;
                    self.last_rate_samples.store(total, Ordering::Relaxed);
                    rate
                } else {
                    *self.current_sample_rate.read().await
                }
            }
        } else {
            0.0
        };

        PipelineStatus {
            is_running,
            mode,
            sample_rate,
            total_samples: total,
            error_count,
        }
    }

    pub fn ring_buffer(&self) -> Arc<RwLock<TimeSeriesRingBuffer>> {
        self.ring_buffer.clone()
    }

    pub fn log_buffer(&self) -> Arc<RwLock<LogRingBuffer>> {
        self.log_buffer.clone()
    }

    pub fn demuxer(&self) -> Arc<RwLock<StreamDemuxer>> {
        self.demuxer.clone()
    }
}

impl Default for PipelineManager {
    fn default() -> Self {
        Self::new()
    }
}

