pub mod data_source;
pub mod demuxer;
pub mod parser;
pub mod ring_buffer;
pub mod step;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use self::data_source::{DataSource, MockDataSource, SerialDataSource};
use self::demuxer::{DemuxOutput, StreamDemuxer};
use self::ring_buffer::{LogRingBuffer, TimeSeriesRingBuffer};
use self::step::StepDetector;
use crate::config::ChannelMapping;
use crate::model::{LogDirection, LogLevel, LogLine, SerialStatusEvent, WaveformBatch};

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
    terminal_buffer: Arc<RwLock<LogRingBuffer>>,
    archive: crate::archive::SharedSerialArchive,
    demuxer: Arc<RwLock<StreamDemuxer>>,
    start_instant: Arc<RwLock<Option<Instant>>>,
    last_rate_time: Arc<RwLock<Instant>>,
    last_rate_samples: Arc<AtomicU64>,
    current_sample_rate: Arc<RwLock<f64>>,
    shutdown_tx: Arc<RwLock<Option<tokio::sync::watch::Sender<bool>>>>,
    reset_signal: Arc<AtomicBool>,
    channel_mapping: Arc<RwLock<ChannelMapping>>,
    step_detector: Arc<RwLock<StepDetector>>,
    outbound_tx: Arc<RwLock<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>>,
    emergency_tx: Arc<RwLock<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>>,
    session_id: Arc<RwLock<String>>,
    channel_epoch: Arc<AtomicU64>,
    session_counter: Arc<AtomicU64>,
    periodic_stop_tx: Arc<RwLock<Option<tokio::sync::watch::Sender<bool>>>>,
    last_connected_port: Arc<RwLock<Option<String>>>,
    last_connected_baud: Arc<RwLock<Option<u32>>>,
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
        // 固定 2,000 行纯文本日志队列 (仅保留非数值日志，供底栏抽屉展示，PR-001)
        let log_buffer = Arc::new(RwLock::new(LogRingBuffer::new(2000)));
        // 固定 2,000 行全量终端日志队列 (包含波形数值行与文本行，供常规终端展示，PR-001)
        let terminal_buffer = Arc::new(RwLock::new(LogRingBuffer::new(2000)));
        let archive = crate::archive::SharedSerialArchive::new();
        let demuxer = Arc::new(RwLock::new(StreamDemuxer::new()));
        // 从工作区持久化配置中加载通道映射 (M8 Step 8.1 & M2)
        let saved_config = crate::config::load_config();
        let channel_mapping = Arc::new(RwLock::new(saved_config.channel_mapping));
        let step_detector = Arc::new(RwLock::new(StepDetector::new()));
        let outbound_tx = Arc::new(RwLock::new(None));
        let emergency_tx = Arc::new(RwLock::new(None));

        let session_id = Arc::new(RwLock::new(String::new()));
        let channel_epoch = Arc::new(AtomicU64::new(0));
        let session_counter = Arc::new(AtomicU64::new(0));
        let periodic_stop_tx = Arc::new(RwLock::new(None));
        let last_connected_port = Arc::new(RwLock::new(None));
        let last_connected_baud = Arc::new(RwLock::new(None));

        Self {
            is_running: Arc::new(AtomicBool::new(false)),
            mode: Arc::new(RwLock::new("mock".to_string())),
            total_samples: Arc::new(AtomicU64::new(0)),
            ring_buffer,
            log_buffer,
            terminal_buffer,
            archive,
            demuxer,
            start_instant: Arc::new(RwLock::new(None)),
            last_rate_time: Arc::new(RwLock::new(Instant::now())),
            last_rate_samples: Arc::new(AtomicU64::new(0)),
            current_sample_rate: Arc::new(RwLock::new(0.0)),
            shutdown_tx: Arc::new(RwLock::new(None)),
            reset_signal: Arc::new(AtomicBool::new(false)),
            channel_mapping,
            step_detector,
            outbound_tx,
            emergency_tx,
            session_id,
            channel_epoch,
            session_counter,
            periodic_stop_tx,
            last_connected_port,
            last_connected_baud,
        }
    }

    /// 启动数据管线 (数据采集分流任务 + 60Hz 波形分发任务 + 10Hz 日志分发任务)
    ///
    /// 单例互斥：若当前已有管线在运行，先停掉并释放旧连接句柄 (PR-001 W2)
    pub async fn start(
        &self,
        app: AppHandle,
        mode_str: String,
        port_name: Option<String>,
        baud_rate: Option<u32>,
    ) -> Result<PipelineStatus, String> {
        // 如果正在运行，先停止旧任务
        if self.is_running.load(Ordering::SeqCst) {
            self.stop(Some(&app)).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // 生成唯一 session_id 与递增 channel_epoch (PR-001 W2)
        let sess_num = self.session_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let new_session_id = format!("sess_{}_{}", now_ms, sess_num);
        let new_epoch = self.channel_epoch.fetch_add(1, Ordering::SeqCst) + 1;

        *self.session_id.write().await = new_session_id.clone();

        {
            let mut rb = self.ring_buffer.write().await;
            rb.set_session_info(new_session_id.clone(), new_epoch);
        }
        {
            let mut sd = self.step_detector.write().await;
            sd.set_session_id(new_session_id.clone());
        }

        let mut data_source: Box<dyn DataSource> = if mode_str == "serial" {
            let port = port_name
                .filter(|p| !p.trim().is_empty())
                .ok_or_else(|| "未指定物理串口端口号 (如 COM3)".to_string())?;
            let baud = baud_rate.unwrap_or(115200);
            tracing::info!("Opening physical serial port: {} @ {} baud (session: {}, epoch: {})", port, baud, new_session_id, new_epoch);
            let serial = SerialDataSource::open(&port, baud, app.clone())?;
            *self.last_connected_port.write().await = Some(port.clone());
            *self.last_connected_baud.write().await = Some(baud);
            Box::new(serial)
        } else {
            let start_samples = self.total_samples.load(Ordering::Relaxed);
            let dt = 0.01;
            let mut mock = MockDataSource::with_time(start_samples as f64 * dt);
            if mode_str.contains("teleplot") {
                mock.set_format(data_source::MockFormat::Teleplot);
            }
            *self.last_connected_port.write().await = Some("VIRTUAL_COM".to_string());
            *self.last_connected_baud.write().await = None;
            Box::new(mock)
        };

        self.is_running.store(true, Ordering::SeqCst);

        // 广播 serial://status 连接成功事件
        let status_event = SerialStatusEvent {
            is_connected: true,
            port: self.last_connected_port.read().await.clone(),
            session_id: new_session_id.clone(),
            channel_epoch: new_epoch,
            error: None,
            reappeared: false,
        };
        let _ = app.emit("serial://status", &status_event);

        // 创建多任务协调取消信道
        let (shutdown_tx, mut shutdown_rx_ingest) = tokio::sync::watch::channel(false);
        let mut shutdown_rx_waveform = shutdown_tx.subscribe();
        let mut shutdown_rx_logs = shutdown_tx.subscribe();
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // 创建发送通道与高优先级急停通道 (Step 4.1 & PR-001 W2 / W7)
        let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(200);
        let (emergency_tx, mut emergency_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(50);
        *self.outbound_tx.write().await = Some(outbound_tx);
        *self.emergency_tx.write().await = Some(emergency_tx);

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
        let terminal_buffer_ingest = self.terminal_buffer.clone();
        let archive_ingest = self.archive.clone();
        let demuxer_ingest = self.demuxer.clone();
        let reset_signal_ingest = self.reset_signal.clone();
        let step_detector_ingest = self.step_detector.clone();
        let channel_mapping_ingest = self.channel_mapping.clone();
        let app_ingest = app.clone();
        let session_id_for_ingest = new_session_id.clone();
        let epoch_for_ingest = new_epoch;
        let last_port_for_probe = self.last_connected_port.clone();

        // 任务 1: 数据采集与智能分流任务 (StreamDemuxer) + 阶跃实时检测 + 高优先级急停与普通发送
        tokio::spawn(async move {
            let mut pipeline_start = Instant::now();

            while is_running_ingest.load(Ordering::Relaxed) {
                // 检查是否收到重置信号，同步重置底层数据源与样本计数
                if reset_signal_ingest.swap(false, Ordering::SeqCst) {
                    data_source.reset();
                    pipeline_start = Instant::now();
                    let mut sd = step_detector_ingest.write().await;
                    sd.reset();
                }

                tokio::select! {
                    biased;
                    _ = shutdown_rx_ingest.changed() => {
                        if *shutdown_rx_ingest.borrow() {
                            data_source.stop();
                            break;
                        }
                    }
                    Some(emergency_bytes) = emergency_rx.recv() => {
                        let _ = data_source.write_emergency_bytes(emergency_bytes);
                    }
                    Some(outbound_bytes) = outbound_rx.recv() => {
                        let _ = data_source.write_bytes(outbound_bytes);
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
                                            rb.set_channel_names(current_channels.clone());
                                        }
                                        rb.push_sample(&sample);
                                        total_samples_ingest.fetch_add(1, Ordering::Relaxed);
                                        drop(rb);

                                        // 数值波形行以 Data 级别写入归档与终端缓冲 (PR-001 W3)
                                        let raw_hex = Some(line.as_bytes().iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "));
                                        let data_log = LogLine {
                                            timestamp_us,
                                            direction: LogDirection::Rx,
                                            level: LogLevel::Data,
                                            text: line.clone(),
                                            raw_hex,
                                        };
                                        archive_ingest.write_line(&data_log);
                                        terminal_buffer_ingest.write().await.push(data_log);

                                        // 阶跃检测器实时提取四大指标 (M3 Step 3.1 & 3.2)
                                        let mapping = channel_mapping_ingest.read().await.clone();
                                        let target_idx = current_channels.iter().position(|c| c == &mapping.target).unwrap_or(0);
                                        let actual_idx = current_channels.iter().position(|c| c == &mapping.actual).unwrap_or(1.min(sample.values.len().saturating_sub(1)));
                                        let output_idx = current_channels.iter().position(|c| c == &mapping.output).unwrap_or(2.min(sample.values.len().saturating_sub(1)));

                                        let target_val = sample.values.get(target_idx).and_then(|v| *v).unwrap_or(0.0);
                                        let actual_val = sample.values.get(actual_idx).and_then(|v| *v).unwrap_or(0.0);
                                        let output_val = sample.values.get(output_idx).and_then(|v| *v).unwrap_or(0.0);

                                        let snapshot_opt = {
                                            let mut sd = step_detector_ingest.write().await;
                                            sd.feed(sample.timestamp_us, target_val, actual_val, output_val, &mapping.target, &mapping.actual)
                                        };

                                        if let Some(snapshot) = snapshot_opt {
                                            tracing::info!("Step snapshot generated: id={}, Mp={:?}%, ess={:?}", snapshot.id, snapshot.metrics.overshoot_percent, snapshot.metrics.steady_state_error);
                                            let _ = app_ingest.emit("step://snapshot", &snapshot);
                                            let _ = app_ingest.emit("step-snapshot", &snapshot);
                                        }
                                    }
                                    DemuxOutput::Log(log_line) => {
                                        archive_ingest.write_line(&log_line);
                                        terminal_buffer_ingest.write().await.push(log_line.clone());
                                        log_buffer_ingest.write().await.push(log_line);
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
                                tracing::warn!("[Pipeline Ingestion Error / Disconnected]: {}", e);
                                is_running_ingest.store(false, Ordering::SeqCst);

                                let port_opt = last_port_for_probe.read().await.clone();
                                // 发射 serial://status 断开事件
                                let status_event = SerialStatusEvent {
                                    is_connected: false,
                                    port: port_opt.clone(),
                                    session_id: session_id_for_ingest.clone(),
                                    channel_epoch: epoch_for_ingest,
                                    error: Some(e.clone()),
                                    reappeared: false,
                                };
                                let _ = app_ingest.emit("serial://status", &status_event);

                                // 若为物理串口拔出，保留已有图表缓冲，后台每 2 秒探测原 COM 口重新出现 (PR-001 W2)
                                if let Some(target_port) = port_opt {
                                    if target_port != "VIRTUAL_COM" {
                                        let app_probe = app_ingest.clone();
                                        let probe_session_id = session_id_for_ingest.clone();
                                        let probe_epoch = epoch_for_ingest;
                                        let is_running_probe = is_running_ingest.clone();
                                        tokio::spawn(async move {
                                            let mut probe_interval = tokio::time::interval(Duration::from_secs(2));
                                            loop {
                                                probe_interval.tick().await;
                                                // 若已重新连接或已销毁，停止探测
                                                if is_running_probe.load(Ordering::Relaxed) {
                                                    break;
                                                }
                                                if let Ok(ports) = crate::serial::enumerate_serial_ports() {
                                                    if ports.iter().any(|p| p.port_name == target_port) {
                                                        tracing::info!("原串口 [{}] 已重新出现，通知前端可重连", target_port);
                                                        let reappeared_event = SerialStatusEvent {
                                                            is_connected: false,
                                                            port: Some(target_port.clone()),
                                                            session_id: probe_session_id,
                                                            channel_epoch: probe_epoch,
                                                            error: None,
                                                            reappeared: true,
                                                        };
                                                        let _ = app_probe.emit("serial://status", &reappeared_event);
                                                        let _ = app_probe.emit("serial://reappeared", &reappeared_event);
                                                        break;
                                                    }
                                                }
                                            }
                                        });
                                    }
                                }
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

        // 任务 3: 10Hz 终端与日志聚合批次分发任务 (从 terminal_buffer 派发，含 raw_hex，PR-001 W3)
        let is_running_logs = self.is_running.clone();
        let terminal_buffer_logs = self.terminal_buffer.clone();
        let app_logs = app.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(100));
            let mut last_log_seq: u64 = terminal_buffer_logs.read().await.total_pushed();

            while is_running_logs.load(Ordering::Relaxed) {
                tokio::select! {
                    _ = shutdown_rx_logs.changed() => {
                        if *shutdown_rx_logs.borrow() {
                            break;
                        }
                    }
                    _ = interval.tick() => {
                        let tb = terminal_buffer_logs.read().await;
                        let (new_logs, new_seq) = tb.read_since(last_log_seq);
                        drop(tb);

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
    pub async fn stop(&self, app: Option<&AppHandle>) -> PipelineStatus {
        self.is_running.store(false, Ordering::SeqCst);
        if let Some(tx) = self.shutdown_tx.read().await.as_ref() {
            let _ = tx.send(true);
        }
        *self.outbound_tx.write().await = None;
        *self.emergency_tx.write().await = None;
        let _ = self.stop_periodic_send().await;
        self.archive.flush();

        let mut rate = self.current_sample_rate.write().await;
        *rate = 0.0;

        if let Some(app_handle) = app {
            let session_id = self.session_id.read().await.clone();
            let epoch = self.channel_epoch.load(Ordering::Relaxed);
            let status_event = SerialStatusEvent {
                is_connected: false,
                port: self.last_connected_port.read().await.clone(),
                session_id,
                channel_epoch: epoch,
                error: None,
                reappeared: false,
            };
            let _ = app_handle.emit("serial://status", &status_event);
        }

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
            let mut tb = self.terminal_buffer.write().await;
            tb.clear();
        }
        {
            let mut dm = self.demuxer.write().await;
            dm.reset();
        }
        {
            let mut sd = self.step_detector.write().await;
            sd.reset();
        }
        self.archive.flush();

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

    pub fn terminal_buffer(&self) -> Arc<RwLock<LogRingBuffer>> {
        self.terminal_buffer.clone()
    }

    pub fn archive(&self) -> crate::archive::SharedSerialArchive {
        self.archive.clone()
    }

    pub fn demuxer(&self) -> Arc<RwLock<StreamDemuxer>> {
        self.demuxer.clone()
    }

    pub async fn set_channel_mapping(&self, mapping: ChannelMapping) {
        let mut cm = self.channel_mapping.write().await;
        *cm = mapping;
    }

    pub async fn get_channel_mapping(&self) -> ChannelMapping {
        self.channel_mapping.read().await.clone()
    }

    /// 按时间段获取 Rust 环形缓冲降采样历史数据 (PR-001 get_waveform_window)
    pub async fn get_waveform_window(
        &self,
        start_us: u64,
        end_us: u64,
        max_points: Option<usize>,
    ) -> Result<Option<WaveformBatch>, String> {
        let rb = self.ring_buffer.read().await;
        Ok(rb.get_window(start_us, end_us, max_points.unwrap_or(1000)))
    }

    /// 向底层数据源发送指令数据 (Step 4.1 & 7.1)
    pub async fn send_data(&self, data: &str, is_hex: bool, append_newline: bool) -> Result<(), String> {
        let bytes = if is_hex {
            let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
            if cleaned.len() % 2 != 0 {
                return Err("HEX 字符串长度必须为偶数 (如 01 03 00 00 00 02)".to_string());
            }
            (0..cleaned.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
                .map_err(|e| format!("无效的十六进制字符: {}", e))?
        } else {
            let mut b = unescape_ascii(data);
            if append_newline && !b.ends_with(b"\n") && !b.ends_with(b"\r") {
                b.extend_from_slice(b"\r\n");
            }
            b
        };

        // 记录到 LogBuffer 与归档作为 TX 日志
        let log_text = if is_hex {
            bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ")
        } else {
            data.trim_end_matches(['\r', '\n']).to_string()
        };

        let raw_hex = Some(bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "));

        let start_instant = *self.start_instant.read().await;
        let timestamp_us = start_instant.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0);

        let log_line = LogLine {
            timestamp_us,
            level: LogLevel::Info,
            direction: LogDirection::Tx,
            text: log_text,
            raw_hex,
        };

        self.archive.write_line(&log_line);
        self.terminal_buffer.write().await.push(log_line.clone());
        self.log_buffer.write().await.push(log_line);

        if let Some(tx) = self.outbound_tx.read().await.as_ref() {
            tx.try_send(bytes).map_err(|e| format!("发送队列已满: {}", e))?;
        } else {
            return Err("串口未连接或管线未启动".to_string());
        }

        Ok(())
    }

    /// 直接发送原始字节流 (PR-001 send_bytes)
    pub async fn send_raw_bytes(&self, bytes: Vec<u8>) -> Result<(), String> {
        let hex_str = bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
        let start_instant = *self.start_instant.read().await;
        let timestamp_us = start_instant.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0);

        let log_line = LogLine {
            timestamp_us,
            level: LogLevel::Info,
            direction: LogDirection::Tx,
            text: hex_str.clone(),
            raw_hex: Some(hex_str),
        };

        self.archive.write_line(&log_line);
        self.terminal_buffer.write().await.push(log_line.clone());
        self.log_buffer.write().await.push(log_line);

        if let Some(tx) = self.outbound_tx.read().await.as_ref() {
            tx.try_send(bytes).map_err(|e| format!("发送队列已满: {}", e))?;
        } else {
            return Err("串口未连接或管线未启动".to_string());
        }

        Ok(())
    }

    /// 最高优先级急停指令下发 (PR-001 W7)
    pub async fn send_emergency_stop(&self, data: Option<String>) -> Result<(), String> {
        let cmd = data.unwrap_or_else(|| "CMD:STOP\n".to_string());
        let cleaned: String = cmd.chars().filter(|c| !c.is_whitespace()).collect();
        let is_hex = !cleaned.is_empty()
            && cleaned.len() % 2 == 0
            && cleaned.chars().all(|c| c.is_ascii_hexdigit());

        let bytes = if is_hex {
            (0..cleaned.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16).unwrap_or(0))
                .collect::<Vec<u8>>()
        } else {
            unescape_ascii(&cmd)
        };

        let hex_str = bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
        let start_instant = *self.start_instant.read().await;
        let timestamp_us = start_instant.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0);

        let log_line = LogLine {
            timestamp_us,
            level: LogLevel::Warn,
            direction: LogDirection::Tx,
            text: format!("[EMERGENCY] 发出最高优先级急停指令: {}{}", cmd.trim_end_matches(['\r', '\n']), if is_hex { " (HEX)" } else { "" }),
            raw_hex: Some(hex_str),
        };

        self.archive.write_line(&log_line);
        self.terminal_buffer.write().await.push(log_line.clone());
        self.log_buffer.write().await.push(log_line);

        if let Some(tx) = self.emergency_tx.read().await.as_ref() {
            tx.try_send(bytes).map_err(|e| format!("急停发送队列已满: {}", e))?;
        } else {
            return Err("串口未连接或管线未启动".to_string());
        }

        Ok(())
    }

    /// Rust 侧高精度定时循环发送 (PR-001 start_periodic_send)
    pub async fn start_periodic_send(
        &self,
        data: String,
        interval_ms: u64,
        is_hex: bool,
    ) -> Result<(), String> {
        if !self.is_running.load(Ordering::Relaxed) {
            return Err("管线未启动，无法启动定时发送".to_string());
        }
        if interval_ms < 10 {
            return Err("定时发送周期不能小于 10ms".to_string());
        }

        // 停止之前的定时任务
        self.stop_periodic_send().await?;

        let bytes = if is_hex {
            let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
            if cleaned.len() % 2 != 0 {
                return Err("HEX 字符串长度必须为偶数".to_string());
            }
            (0..cleaned.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16))
                .collect::<Result<Vec<u8>, _>>()
                .map_err(|e| format!("无效的十六进制字符: {}", e))?
        } else {
            let mut b = unescape_ascii(&data);
            if !b.ends_with(b"\n") && !b.ends_with(b"\r") {
                b.extend_from_slice(b"\r\n");
            }
            b
        };

        let log_text = if is_hex {
            bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ")
        } else {
            data.trim_end_matches(['\r', '\n']).to_string()
        };
        let raw_hex = Some(bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "));

        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        *self.periodic_stop_tx.write().await = Some(stop_tx);

        let outbound_tx = self.outbound_tx.read().await.clone()
            .ok_or_else(|| "发送通道未建立".to_string())?;
        let log_buffer = self.log_buffer.clone();
        let start_instant = self.start_instant.clone();

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval_ms));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    _ = ticker.tick() => {
                        let timestamp_us = {
                            let si = *start_instant.read().await;
                            si.map(|s| s.elapsed().as_micros() as u64).unwrap_or(0)
                        };
                        {
                            let mut lb = log_buffer.write().await;
                            lb.push(LogLine {
                                timestamp_us,
                                level: LogLevel::Info,
                                direction: LogDirection::Tx,
                                text: log_text.clone(),
                                raw_hex: raw_hex.clone(),
                            });
                        }
                        if outbound_tx.send(bytes.clone()).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        Ok(())
    }

    /// 停止 Rust 侧定时循环发送 (PR-001 stop_periodic_send)
    pub async fn stop_periodic_send(&self) -> Result<(), String> {
        if let Some(tx) = self.periodic_stop_tx.write().await.take() {
            let _ = tx.send(true);
        }
        Ok(())
    }
}

/// 将 ASCII 字符串中的常见转义字符 (\r, \n, \t, \\) 解析为对应字节 (M4 Step 4.1)
pub fn unescape_ascii(input: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('r') => {
                    chars.next();
                    bytes.push(b'\r');
                }
                Some('n') => {
                    chars.next();
                    bytes.push(b'\n');
                }
                Some('t') => {
                    chars.next();
                    bytes.push(b'\t');
                }
                Some('\\') => {
                    chars.next();
                    bytes.push(b'\\');
                }
                _ => {
                    bytes.push(b'\\');
                }
            }
        } else {
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            bytes.extend_from_slice(s.as_bytes());
        }
    }
    bytes
}

impl Default for PipelineManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SamplePoint;

    #[tokio::test]
    async fn test_pipeline_channel_mapping_get_set() {
        let pm = PipelineManager::new();
        let default_mapping = pm.get_channel_mapping().await;
        assert_eq!(default_mapping.target, "setpoint");
        assert_eq!(default_mapping.actual, "actual");
        assert_eq!(default_mapping.output, "output");

        let new_mapping = ChannelMapping {
            target: "ch1".to_string(),
            actual: "ch2".to_string(),
            output: "ch0".to_string(),
        };
        pm.set_channel_mapping(new_mapping.clone()).await;
        let fetched = pm.get_channel_mapping().await;
        assert_eq!(fetched, new_mapping);
    }

    #[tokio::test]
    async fn test_pipeline_1000hz_multi_channel_throughput() {
        // 压测 1000Hz 下 8 通道数据流写入 RingBuffer 与读取
        let channels = vec![
            "ch0".to_string(),
            "ch1".to_string(),
            "ch2".to_string(),
            "ch3".to_string(),
            "ch4".to_string(),
            "ch5".to_string(),
            "ch6".to_string(),
            "ch7".to_string(),
        ];
        let mut rb = TimeSeriesRingBuffer::new(60_000, channels.clone());

        let start_time = Instant::now();
        // 灌入 1000 个 8 通道样本点
        for i in 0..1000 {
            let timestamp_us = i as u64 * 1000; // 每 1ms 一个点，对应 1000Hz
            let values = (0..8).map(|c| Some((c as f64) * 10.0 + (i as f64) * 0.01)).collect();
            let sample = SamplePoint {
                timestamp_us,
                values,
            };
            rb.push_sample(&sample);
        }
        let elapsed = start_time.elapsed();
        // 1000 点内存写入应在数毫秒内完成
        assert!(elapsed.as_millis() < 50, "1000Hz 样本写入耗时过长: {:?}", elapsed);
        assert_eq!(rb.total_pushed(), 1000);

        // 验证读取批次
        let (batch, new_seq) = rb.read_since(0);
        assert!(batch.is_some());
        let b = batch.unwrap();
        assert_eq!(b.timestamps.len(), 1000);
        assert_eq!(b.series.len(), 8);
        assert_eq!(b.series[0].len(), 1000);
        assert_eq!(new_seq, 1000);
    }

    #[tokio::test]
    async fn test_pipeline_channel_semantic_binding_lookup() {
        // 测试将语义角色 Target/Actual/Output 动态绑定到指定通道
        let mapping = ChannelMapping {
            target: "ch3".to_string(),
            actual: "ch5".to_string(),
            output: "ch1".to_string(),
        };
        let channel_names = vec![
            "ch0".to_string(),
            "ch1".to_string(),
            "ch2".to_string(),
            "ch3".to_string(),
            "ch4".to_string(),
            "ch5".to_string(),
        ];

        let target_idx = channel_names.iter().position(|c| c == &mapping.target);
        let actual_idx = channel_names.iter().position(|c| c == &mapping.actual);
        let output_idx = channel_names.iter().position(|c| c == &mapping.output);

        assert_eq!(target_idx, Some(3));
        assert_eq!(actual_idx, Some(5));
        assert_eq!(output_idx, Some(1));
    }

    #[tokio::test]
    async fn test_send_data_ascii_and_hex_validation() {
        let pm = PipelineManager::new();
        // 未启动管线时发送应返回未连接错误
        let res = pm.send_data("TEST", false, true).await;
        assert!(res.is_err());

        // 模拟已存在 outbound_tx
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);
        *pm.outbound_tx.write().await = Some(tx);

        // 1. 发送 ASCII 并附加 \r\n
        let send_res = pm.send_data("HELLO", false, true).await;
        assert!(send_res.is_ok());
        let received = rx.recv().await.unwrap();
        assert_eq!(received, b"HELLO\r\n");

        // 2. 发送有效 HEX
        let hex_res = pm.send_data("01 03 00 00 00 02 C4 0B", true, false).await;
        assert!(hex_res.is_ok());
        let hex_received = rx.recv().await.unwrap();
        assert_eq!(hex_received, vec![0x01, 0x03, 0x00, 0x00, 0x00, 0x02, 0xC4, 0x0B]);

        // 3. 发送奇数位无效 HEX 应报错拦截
        let bad_hex = pm.send_data("01 03 0", true, false).await;
        assert!(bad_hex.is_err());

        // 4. 验证 TX 日志被记录到 log_buffer
        {
            let lb = pm.log_buffer.read().await;
            let logs = lb.get_recent(10);
            assert!(logs.iter().any(|l| l.direction == LogDirection::Tx && l.text == "HELLO"));
        }

        // 5. 发送包含 \r\n 转义字符的 ASCII 指令，不应重复附加 \r\n
        let esc_res = pm.send_data("RST\\n", false, true).await;
        assert!(esc_res.is_ok());
        let esc_received = rx.recv().await.unwrap();
        assert_eq!(esc_received, b"RST\n");
    }

    #[tokio::test]
    async fn test_periodic_send_scheduling() {
        let pm = PipelineManager::new();
        pm.is_running.store(true, Ordering::SeqCst);

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(100);
        *pm.outbound_tx.write().await = Some(tx);

        // 启动 20ms 周期定时发送
        let res = pm.start_periodic_send("PING".to_string(), 20, false).await;
        assert!(res.is_ok());

        // 接收至少 2 次定时发送
        let first = rx.recv().await;
        assert!(first.is_some());
        assert_eq!(first.unwrap(), b"PING\r\n");

        let second = rx.recv().await;
        assert!(second.is_some());
        assert_eq!(second.unwrap(), b"PING\r\n");

        // 停止定时发送
        let stop_res = pm.stop_periodic_send().await;
        assert!(stop_res.is_ok());
    }

    #[tokio::test]
    async fn test_send_emergency_stop_ascii_and_hex() {
        let pm = PipelineManager::new();
        // 1. 未连接时发送急停应报错
        let err_res = pm.send_emergency_stop(Some("CMD:STOP\n".to_string())).await;
        assert!(err_res.is_err());

        // 模拟 emergency_tx
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(10);
        *pm.emergency_tx.write().await = Some(tx);

        // 2. 发送 ASCII 急停指令
        let res_ascii = pm.send_emergency_stop(Some("CMD:STOP\n".to_string())).await;
        assert!(res_ascii.is_ok());
        let recv_ascii = rx.recv().await.unwrap();
        assert_eq!(recv_ascii, b"CMD:STOP\n");

        // 3. 发送 HEX 停机指令 (如 Modbus 停机: 01 05 00 00 FF 00 8C 3A)
        let res_hex = pm.send_emergency_stop(Some("01 05 00 00 FF 00 8C 3A".to_string())).await;
        assert!(res_hex.is_ok());
        let recv_hex = rx.recv().await.unwrap();
        assert_eq!(recv_hex, vec![0x01, 0x05, 0x00, 0x00, 0xFF, 0x00, 0x8C, 0x3A]);

        // 4. 验证急停日志记录到 terminal_buffer 和 log_buffer
        let tb = pm.terminal_buffer.read().await;
        let recent = tb.get_recent(10);
        assert!(recent.iter().any(|l| l.level == LogLevel::Warn && l.text.contains("CMD:STOP")));
        assert!(recent.iter().any(|l| l.level == LogLevel::Warn && l.text.contains("(HEX)")));
    }

    #[tokio::test]
    async fn test_pipeline_mixed_stress_stream_500hz() {
        // 模拟 500Hz 混合数据流压测：包含 CSV、Teleplot、文本日志、脏数据
        let mut demuxer = StreamDemuxer::new();
        let mut rb = TimeSeriesRingBuffer::new(5000, vec!["speed".to_string(), "target".to_string()]);
        let mut log_buf = LogRingBuffer::new(1000);

        for i in 0..500 {
            let timestamp_us = i as u64 * 2000; // 2ms 对应 500Hz
            // 构造混合行
            let line = match i % 5 {
                0 => format!(">speed:{:.2}\n", (i as f64) * 0.5),
                1 => format!(">target:{:.2}\n", 100.0),
                2 => format!("{:.2},{:.2}\n", (i as f64) * 0.5, 100.0),
                3 => format!("[INFO] Status tick {}\n", i),
                _ => "DIRTY_CORRUPT_BYTES???\n".to_string(),
            };

            let out = demuxer.demux_line(&line, timestamp_us, LogDirection::Rx);
            match out {
                DemuxOutput::Sample(sample) => {
                    rb.push_sample(&sample);
                }
                DemuxOutput::Log(log) => {
                    log_buf.push(log);
                }
                DemuxOutput::None => {}
            }
        }

        // 验证 RingBuffer 数据点数与日志行数
        assert!(rb.total_pushed() > 0);
        assert!(log_buf.len() > 0);
        // 验证读取批次无损
        let (batch, _) = rb.read_since(0);
        assert!(batch.is_some());

        // 进一步压测：通过 process_serial_bytes 注入包含非法 UTF-8、乱码字节的高频流
        let mut rx_buf = Vec::new();
        let mut err_cnt = std::sync::atomic::AtomicU64::new(0);
        let raw_stress_bytes = b"10.5,20.3\n\xff\xfe\xaaGARBAGE\n>speed:123.4\n[ERROR] Overcurrent\n";
        let lines = crate::pipeline::data_source::process_serial_bytes(raw_stress_bytes, &mut rx_buf, &mut err_cnt);
        // 4 行中有 1 行是非法 UTF-8，被静默丢弃并计入错误计数，提取出 3 行有效数据
        assert_eq!(lines.len(), 3);
        assert_eq!(err_cnt.load(Ordering::Relaxed), 1);
    }
}
