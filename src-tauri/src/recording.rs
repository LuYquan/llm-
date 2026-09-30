use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::logger::get_app_dir;
use crate::model::RawChunk;
use crate::protocol::ProtocolConfig;

const SEGMENT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
const RECORD_QUEUE_CHUNKS: usize = 4096;
const MANIFEST_UPDATE_CHUNKS: u64 = 256;
const MAX_CHUNK_INDEX_LINE_BYTES: usize = 4096;
const MAX_RECORDING_PAGE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub session_id: Option<String>,
    pub directory: Option<String>,
    pub rx_bytes: u64,
    pub rx_chunks: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSegment {
    pub file: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingManifest {
    pub format_version: u32,
    pub session_id: String,
    pub epoch: u64,
    pub source: String,
    pub port: Option<String>,
    pub baud_rate: Option<u32>,
    #[serde(default)]
    pub protocol_config: Option<ProtocolConfig>,
    pub time_source: String,
    pub status: String,
    pub started_unix_ms: u128,
    pub ended_unix_ms: Option<u128>,
    pub rx_bytes: u64,
    pub rx_chunks: u64,
    #[serde(default)]
    pub unindexed_bytes: u64,
    pub segments: Vec<RecordingSegment>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecordingSummary {
    pub directory: String,
    pub manifest: RecordingManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRawChunk {
    pub rx_sequence: u64,
    pub received_at_us: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPage {
    pub session_id: String,
    pub epoch: u64,
    pub chunks: Vec<RecordedRawChunk>,
    pub next_after_rx_sequence: Option<u64>,
    pub eof: bool,
    pub sequence_gap: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RecordingMetadata {
    pub source: String,
    pub port: Option<String>,
    pub baud_rate: Option<u32>,
    pub protocol_config: Option<ProtocolConfig>,
}

enum WriterCommand {
    Chunk(RawChunk),
    Event {
        event: String,
        message: Option<String>,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Stop(mpsc::Sender<Result<(), String>>),
}

struct ActiveRecording {
    sender: SyncSender<WriterCommand>,
}

struct RecorderState {
    status: RecordingStatus,
    active: Option<ActiveRecording>,
    starting: bool,
    finalizing: bool,
}

#[derive(Clone)]
pub struct RecordingService {
    state: Arc<Mutex<RecorderState>>,
    root_dir: PathBuf,
}

impl RecordingService {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RecorderState {
                status: RecordingStatus::default(),
                active: None,
                starting: false,
                finalizing: false,
            })),
            root_dir: get_app_dir().join("recordings"),
        }
    }

    pub fn with_root_dir(root_dir: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(RecorderState {
                status: RecordingStatus::default(),
                active: None,
                starting: false,
                finalizing: false,
            })),
            root_dir,
        }
    }

    pub fn start(
        &self,
        session_id: String,
        epoch: u64,
        metadata: RecordingMetadata,
    ) -> Result<RecordingStatus, String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "记录器状态锁不可用".to_string())?;
            if state.active.is_some()
                || state.starting
                || state.finalizing
                || state.status.is_recording
            {
                return Err("已有记录会话正在运行".to_string());
            }
            state.starting = true;
        }

        let result = self.start_inner(session_id, epoch, metadata);
        if result.is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.starting = false;
            }
        }
        result
    }

    fn start_inner(
        &self,
        session_id: String,
        epoch: u64,
        metadata: RecordingMetadata,
    ) -> Result<RecordingStatus, String> {
        let root = &self.root_dir;
        fs::create_dir_all(&root).map_err(|e| format!("创建记录目录失败: {e}"))?;
        let started_unix_ms = unix_ms();
        let safe_session = safe_component(&session_id);
        let directory = root.join(format!("{safe_session}_{started_unix_ms}"));
        fs::create_dir(&directory).map_err(|e| format!("创建记录会话目录失败: {e}"))?;

        let initial_manifest = RecordingManifest {
            format_version: 1,
            session_id: session_id.clone(),
            epoch,
            source: if metadata.source.is_empty() {
                "unknown".to_string()
            } else {
                metadata.source
            },
            port: metadata.port,
            baud_rate: metadata.baud_rate,
            protocol_config: metadata.protocol_config,
            time_source: "host_monotonic_receive".to_string(),
            status: "recording".to_string(),
            started_unix_ms,
            ended_unix_ms: None,
            rx_bytes: 0,
            rx_chunks: 0,
            unindexed_bytes: 0,
            segments: Vec::new(),
            error: None,
        };
        write_manifest_atomic(&directory, &initial_manifest)?;

        let shared_state = self.state.clone();
        let worker_directory = directory.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (sender, receiver) = mpsc::sync_channel(RECORD_QUEUE_CHUNKS);
        thread::Builder::new()
            .name(format!("record-writer-{}", safe_session))
            .spawn(move || {
                let writer = RecordingWriter::open(
                    worker_directory.clone(),
                    initial_manifest,
                    shared_state.clone(),
                );
                match writer {
                    Ok(mut writer) => {
                        let _ = ready_tx.send(Ok(()));
                        writer.run(receiver);
                    }
                    Err(error) => {
                        set_recording_error(&shared_state, error.clone());
                        let _ = ready_tx.send(Err(error));
                    }
                }
            })
            .map_err(|e| format!("启动记录写入线程失败: {e}"))?;

        ready_rx
            .recv()
            .map_err(|e| format!("记录写入线程未能启动: {e}"))??;
        let status = RecordingStatus {
            is_recording: true,
            session_id: Some(session_id),
            directory: Some(directory.to_string_lossy().to_string()),
            rx_bytes: 0,
            rx_chunks: 0,
            error: None,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "记录器状态锁不可用".to_string())?;
        state.starting = false;
        state.status = status.clone();
        state.active = Some(ActiveRecording { sender });
        Ok(status)
    }

    /// 原始块使用有界队列写入。队列溢出时中断记录并明确报告，绝不静默丢弃后继续宣称完整。
    pub fn write_chunk(&self, chunk: RawChunk) {
        let sender = self.state.lock().ok().and_then(|state| {
            if state.status.is_recording {
                state.active.as_ref().map(|active| active.sender.clone())
            } else {
                None
            }
        });
        let Some(sender) = sender else { return };

        match sender.try_send(WriterCommand::Chunk(chunk)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.interrupt("记录队列已满；为避免静默丢失，已中断本次记录".to_string());
            }
            Err(TrySendError::Disconnected(_)) => {
                self.interrupt("记录写入线程已退出".to_string());
            }
        }
    }

    pub fn stop(&self) -> Result<RecordingStatus, String> {
        let active = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "记录器状态锁不可用".to_string())?;
            let active = state.active.take();
            if active.is_some() {
                state.finalizing = true;
            }
            active
        };
        if let Some(active) = active {
            let (reply_tx, reply_rx) = mpsc::channel();
            if let Err(error) = active.sender.send(WriterCommand::Stop(reply_tx)) {
                if let Ok(mut state) = self.state.lock() {
                    state.finalizing = false;
                    state.status.is_recording = false;
                    state.status.error = Some(format!("发送停止记录请求失败: {error}"));
                }
                return Err(format!("发送停止记录请求失败: {error}"));
            }
            reply_rx
                .recv()
                .map_err(|error| {
                    if let Ok(mut state) = self.state.lock() {
                        state.finalizing = false;
                        state.status.is_recording = false;
                        state.status.error = Some(format!("等待记录刷新失败: {error}"));
                    }
                    format!("等待记录刷新失败: {error}")
                })??;
        }
        self.status()
    }

    /// Append a structured event to the active session without exposing the
    /// recording writer or its file handles to callers. Events are serialized
    /// by the same bounded writer queue as raw chunks, so their order relative
    /// to samples and the final stop marker is deterministic.
    pub fn append_event(&self, event: String, message: Option<String>) -> Result<bool, String> {
        if event.trim().is_empty() {
            return Err("记录事件名称不能为空".to_string());
        }
        if event.len() > 128 {
            return Err("记录事件名称过长".to_string());
        }
        if message.as_ref().map(|value| value.len()).unwrap_or(0) > 64 * 1024 {
            return Err("记录事件内容超过 64 KiB 限制".to_string());
        }

        let sender = {
            let state = self
                .state
                .lock()
                .map_err(|_| "记录器状态锁不可用".to_string())?;
            if !state.status.is_recording {
                return Ok(false);
            }
            state
                .active
                .as_ref()
                .map(|active| active.sender.clone())
                .ok_or_else(|| "记录写入通道不可用".to_string())?
        };

        let (reply_tx, reply_rx) = mpsc::channel();
        sender
            .send(WriterCommand::Event {
                event,
                message,
                reply: reply_tx,
            })
            .map_err(|_| "记录写入线程已退出".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "等待记录事件刷新失败".to_string())??;
        Ok(true)
    }

    pub fn status(&self) -> Result<RecordingStatus, String> {
        self.state
            .lock()
            .map(|state| state.status.clone())
            .map_err(|_| "记录器状态锁不可用".to_string())
    }

    pub fn list(&self) -> Result<Vec<RecordingSummary>, String> {
        let root = &self.root_dir;
        if !root.exists() {
            return Ok(Vec::new());
        }
        let (busy_directory, is_busy) = self
            .state
            .lock()
            .map(|state| {
                (
                    state.status.directory.clone(),
                    state.status.is_recording || state.finalizing || state.active.is_some(),
                )
            })
            .map_err(|_| "记录器状态锁不可用".to_string())?;
        let mut summaries = Vec::new();
        let entries = fs::read_dir(&root).map_err(|e| format!("读取记录会话列表失败: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取记录会话条目失败: {e}"))?;
            if !entry.path().is_dir() {
                continue;
            }
            let manifest_path = entry.path().join("manifest.json");
            let manifest_text = match fs::read_to_string(&manifest_path) {
                Ok(text) => text,
                Err(_) => continue,
            };
            let mut manifest: RecordingManifest = match serde_json::from_str(&manifest_text) {
                Ok(manifest) => manifest,
                Err(_) => continue,
            };
            let directory_path = entry.path();
            let is_current_writer = is_busy
                && busy_directory.as_deref() == Some(directory_path.to_string_lossy().as_ref());
            if manifest.status == "recording" && !is_current_writer {
                recover_interrupted_recording(&directory_path, &mut manifest)?;
            }
            summaries.push(RecordingSummary {
                directory: directory_path.to_string_lossy().to_string(),
                manifest,
            });
        }
        summaries.sort_by_key(|summary| summary.manifest.started_unix_ms);
        Ok(summaries)
    }

    /// Read a bounded, indexed page of raw RX chunks from a completed session.
    /// The directory must exactly match a session returned by `list()` and is
    /// canonicalized beneath this recorder's root before any file is opened.
    pub fn read_page(
        &self,
        session_id: &str,
        directory: &str,
        after_rx_sequence: Option<u64>,
        max_bytes: Option<usize>,
    ) -> Result<RecordingPage, String> {
        let summaries = self.list()?;
        let summary = summaries
            .into_iter()
            .find(|item| item.manifest.session_id == session_id && item.directory == directory)
            .ok_or_else(|| "记录会话不存在或目录标识不匹配".to_string())?;
        if summary.manifest.status == "recording" {
            return Err("记录仍在写入；停止记录后才能回放已完成的索引".to_string());
        }
        if summary.manifest.status != "complete" && summary.manifest.status != "interrupted" {
            return Err(format!("记录状态 {} 不支持回放", summary.manifest.status));
        }

        let root = self
            .root_dir
            .canonicalize()
            .map_err(|e| format!("解析记录根目录失败: {e}"))?;
        let session_dir = PathBuf::from(&summary.directory)
            .canonicalize()
            .map_err(|e| format!("解析记录会话目录失败: {e}"))?;
        if !session_dir.starts_with(&root) {
            return Err("记录目录超出本应用记录根目录".to_string());
        }

        let page_limit = max_bytes.unwrap_or(64 * 1024).clamp(1, MAX_RECORDING_PAGE_BYTES);
        let index_file = File::open(session_dir.join("chunks.jsonl"))
            .map_err(|e| format!("打开记录索引失败: {e}"))?;
        let mut reader = BufReader::new(index_file);
        let mut page = RecordingPage {
            session_id: summary.manifest.session_id.clone(),
            epoch: summary.manifest.epoch,
            chunks: Vec::new(),
            next_after_rx_sequence: after_rx_sequence,
            eof: true,
            sequence_gap: false,
        };
        let mut used_bytes = 0usize;
        let mut line = Vec::new();
        let mut previous_sequence = 0u64;
        let mut last_returned_sequence = after_rx_sequence.unwrap_or(0);
        loop {
            line.clear();
            let read = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("读取记录索引失败: {e}"))?;
            if read == 0 {
                break;
            }
            if line.len() > MAX_CHUNK_INDEX_LINE_BYTES {
                return Err("记录索引行超过允许长度".to_string());
            }
            let content = line.strip_suffix(b"\n").unwrap_or(&line);
            let content = content.strip_suffix(b"\r").unwrap_or(content);
            let chunk: ChunkIndexOwned = serde_json::from_slice(content)
                .map_err(|e| format!("解析记录索引失败: {e}"))?;
            if chunk.session_id != summary.manifest.session_id
                || chunk.epoch != summary.manifest.epoch
                || chunk.rx_sequence <= previous_sequence
            {
                return Err("记录索引中的会话、代次或接收序号不连续".to_string());
            }
            previous_sequence = chunk.rx_sequence;
            if after_rx_sequence.is_some_and(|after| chunk.rx_sequence <= after) {
                continue;
            }

            let Some(segment_index) = parse_segment_index(&chunk.segment) else {
                return Err("记录索引包含非法分段路径".to_string());
            };
            let expected_file = format!("rx-{segment_index:06}.bin");
            if chunk.segment != expected_file || chunk.length == 0 {
                return Err("记录索引包含非法分段名称或空块".to_string());
            }
            if !page.chunks.is_empty() && used_bytes.saturating_add(chunk.length) > page_limit {
                page.eof = false;
                break;
            }
            if chunk.length > page_limit {
                return Err("单个原始接收块超过回放页容量".to_string());
            }

            let segment_path = session_dir.join(&chunk.segment);
            let metadata = fs::metadata(&segment_path)
                .map_err(|e| format!("读取原始分段元数据失败: {e}"))?;
            let end = chunk
                .offset
                .checked_add(chunk.length as u64)
                .ok_or_else(|| "记录索引的字节偏移溢出".to_string())?;
            if end > metadata.len() {
                return Err("记录索引指向不完整的原始 RX 字节".to_string());
            }
            let mut segment = File::open(segment_path).map_err(|e| format!("打开原始分段失败: {e}"))?;
            segment
                .seek(SeekFrom::Start(chunk.offset))
                .map_err(|e| format!("定位原始分段失败: {e}"))?;
            let mut bytes = vec![0u8; chunk.length];
            segment
                .read_exact(&mut bytes)
                .map_err(|e| format!("读取原始 RX 字节失败: {e}"))?;

            if chunk.rx_sequence > last_returned_sequence.saturating_add(1) {
                page.sequence_gap = true;
            }
            last_returned_sequence = chunk.rx_sequence;
            page.next_after_rx_sequence = Some(chunk.rx_sequence);
            used_bytes += bytes.len();
            page.chunks.push(RecordedRawChunk {
                rx_sequence: chunk.rx_sequence,
                received_at_us: chunk.received_at_us,
                bytes,
            });
        }
        Ok(page)
    }

    fn interrupt(&self, message: String) {
        let sender = match self.state.lock() {
            Ok(mut state) => {
                if !state.status.is_recording && state.active.is_none() {
                    return;
                }
                state.status.is_recording = false;
                state.status.error = Some(message.clone());
                state.finalizing = true;
                state.active.take().map(|active| active.sender)
            }
            Err(_) => None,
        };

        if let Some(sender) = sender {
            // A full queue is the condition that triggers this path. Sending
            // the stop marker from a helper thread lets the writer drain the
            // already accepted prefix and finalize it, without blocking the
            // serial ingest task. The writer reads the shared error above and
            // therefore finalizes the manifest as `interrupted`.
            let state = self.state.clone();
            thread::spawn(move || {
                let (reply_tx, reply_rx) = mpsc::channel();
                let send_result = sender.send(WriterCommand::Stop(reply_tx));
                if send_result.is_ok() {
                    let _ = reply_rx.recv();
                } else if let Ok(mut state) = state.lock() {
                    state.finalizing = false;
                    state.status.error = Some("记录写入线程已退出，未能完成收尾".to_string());
                }
            });
        } else if let Ok(mut state) = self.state.lock() {
            state.finalizing = false;
        }
        tracing::error!("原始记录中断: {}", message);
    }
}

/// Restore the last contiguous prefix whose index entries point at bytes that
/// actually reached disk. Unindexed raw tails are retained and reported so a
/// crash cannot silently erase bytes that may still be useful for manual salvage.
fn recover_interrupted_recording(
    directory: &Path,
    manifest: &mut RecordingManifest,
) -> Result<(), String> {
    let index_path = directory.join("chunks.jsonl");
    let recovery_path = directory.join("chunks.jsonl.recover.tmp");
    let mut expected_offsets: HashMap<String, u64> = HashMap::new();
    let mut last_segment_index: Option<u32> = None;
    let mut last_sequence = 0u64;
    let mut last_received_at_us = 0u64;
    let mut indexed_bytes = 0u64;
    let mut indexed_chunks = 0u64;

    if index_path.exists() {
        let source = File::open(&index_path).map_err(|e| format!("打开记录索引以恢复失败: {e}"))?;
        let mut reader = BufReader::new(source);
        let target = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&recovery_path)
            .map_err(|e| format!("创建恢复索引临时文件失败: {e}"))?;
        let mut writer = BufWriter::with_capacity(64 * 1024, target);
        let mut line = Vec::new();

        loop {
            match read_bounded_line(&mut reader, &mut line) {
                Ok(false) => break,
                Ok(true) => {}
                Err(_) => break,
            }

            let content = line.strip_suffix(b"\n").unwrap_or(&line);
            let content = content.strip_suffix(b"\r").unwrap_or(content);
            let Ok(chunk) = serde_json::from_slice::<ChunkIndexOwned>(content) else {
                break;
            };

            let Some(segment_index) = parse_segment_index(&chunk.segment) else {
                break;
            };
            if chunk.session_id != manifest.session_id
                || chunk.epoch != manifest.epoch
                || chunk.rx_sequence <= last_sequence
                || chunk.received_at_us < last_received_at_us
                || chunk.length == 0
                || last_segment_index.is_some_and(|last| {
                    segment_index < last || segment_index > last.saturating_add(1)
                })
            {
                break;
            }

            let expected_offset = expected_offsets.get(&chunk.segment).copied().unwrap_or(0);
            if chunk.offset != expected_offset {
                break;
            }
            let Some(chunk_end) = chunk.offset.checked_add(chunk.length as u64) else {
                break;
            };
            let segment_path = directory.join(&chunk.segment);
            let segment_length = match fs::metadata(&segment_path) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => return Err(format!("读取记录分段以恢复失败: {error}")),
            };
            if segment_length < chunk_end {
                break;
            }

            writer
                .write_all(content)
                .and_then(|_| writer.write_all(b"\n"))
                .map_err(|e| format!("写入恢复索引失败: {e}"))?;
            indexed_bytes = indexed_bytes.saturating_add(chunk.length as u64);
            indexed_chunks = indexed_chunks.saturating_add(1);
            expected_offsets.insert(chunk.segment, chunk_end);
            last_sequence = chunk.rx_sequence;
            last_received_at_us = chunk.received_at_us;
            last_segment_index = Some(segment_index);
        }

        writer
            .flush()
            .map_err(|e| format!("刷新恢复索引失败: {e}"))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|e| format!("同步恢复索引失败: {e}"))?;
        drop(writer);
        let backup_path = directory.join(format!("chunks.jsonl.pre-recovery-{}", unix_ms()));
        fs::rename(&index_path, &backup_path).map_err(|e| format!("保留异常索引原件失败: {e}"))?;
        if let Err(error) = fs::rename(&recovery_path, &index_path) {
            let _ = fs::rename(&backup_path, &index_path);
            return Err(format!("替换为完整记录索引前缀失败: {error}"));
        }
    }

    let mut segments = BTreeMap::new();
    let mut physical_bytes = 0u64;
    for entry in fs::read_dir(directory).map_err(|e| format!("扫描记录分段失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取记录分段条目失败: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if parse_segment_index(&name).is_none() {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取记录分段类型失败: {e}"))?;
        if !file_type.is_file() {
            continue;
        }
        let bytes = entry
            .metadata()
            .map_err(|e| format!("读取记录分段长度失败: {e}"))?
            .len();
        physical_bytes = physical_bytes.saturating_add(bytes);
        segments.insert(name, bytes);
    }

    let mut manifest_segments = Vec::with_capacity(segments.len());
    for (file, bytes) in segments {
        manifest_segments.push(RecordingSegment { file, bytes });
    }
    manifest.status = "interrupted".to_string();
    manifest.ended_unix_ms = Some(unix_ms());
    manifest.rx_bytes = indexed_bytes;
    manifest.rx_chunks = indexed_chunks;
    manifest.unindexed_bytes = physical_bytes.saturating_sub(indexed_bytes);
    manifest.segments = manifest_segments;
    let message = format!(
        "程序异常退出；已恢复 {indexed_chunks} 个完整块、{indexed_bytes} 个索引字节；保留 {} 个未索引原始尾部字节",
        manifest.unindexed_bytes
    );
    manifest.error = Some(message.clone());
    write_manifest_atomic(directory, manifest)?;

    let mut events = open_append(&directory.join("events.jsonl"))?;
    write_event(&mut events, "recording_recovered", Some(&message))
        .map_err(|e| format!("写入记录恢复事件失败: {e}"))?;
    events
        .flush()
        .map_err(|e| format!("刷新记录恢复事件失败: {e}"))?;
    events
        .get_ref()
        .sync_all()
        .map_err(|e| format!("同步记录恢复事件失败: {e}"))?;
    Ok(())
}

fn parse_segment_index(name: &str) -> Option<u32> {
    let digits = name.strip_prefix("rx-")?.strip_suffix(".bin")?;
    if digits.len() != 6 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn read_bounded_line<R: BufRead>(reader: &mut R, line: &mut Vec<u8>) -> std::io::Result<bool> {
    line.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let bytes_to_consume = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(bytes_to_consume) > MAX_CHUNK_INDEX_LINE_BYTES {
            reader.consume(bytes_to_consume);
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "记录索引行超过安全上限",
            ));
        }
        let is_complete = available[bytes_to_consume - 1] == b'\n';
        line.extend_from_slice(&available[..bytes_to_consume]);
        reader.consume(bytes_to_consume);
        if is_complete {
            return Ok(true);
        }
    }
}

impl Default for RecordingService {
    fn default() -> Self {
        Self::new()
    }
}

struct RecordingWriter {
    directory: PathBuf,
    manifest: RecordingManifest,
    raw_writer: BufWriter<File>,
    chunks_writer: BufWriter<File>,
    events_writer: BufWriter<File>,
    segment_index: u32,
    segment_bytes: u64,
    chunks_since_manifest: u64,
    shared_state: Arc<Mutex<RecorderState>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkIndex<'a> {
    session_id: &'a str,
    epoch: u64,
    rx_sequence: u64,
    received_at_us: u64,
    segment: &'a str,
    offset: u64,
    length: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkIndexOwned {
    session_id: String,
    epoch: u64,
    rx_sequence: u64,
    received_at_us: u64,
    segment: String,
    offset: u64,
    length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingEvent<'a> {
    event: &'a str,
    unix_ms: u128,
    message: Option<&'a str>,
}

impl RecordingWriter {
    fn open(
        directory: PathBuf,
        manifest: RecordingManifest,
        shared_state: Arc<Mutex<RecorderState>>,
    ) -> Result<Self, String> {
        let segment_index = 0;
        let raw_writer = open_segment(&directory, segment_index)?;
        let chunks_writer = open_append(&directory.join("chunks.jsonl"))?;
        let mut events_writer = open_append(&directory.join("events.jsonl"))?;
        write_event(&mut events_writer, "recording_started", None)?;
        events_writer
            .flush()
            .map_err(|e| format!("刷新记录事件失败: {e}"))?;
        Ok(Self {
            directory,
            manifest,
            raw_writer,
            chunks_writer,
            events_writer,
            segment_index,
            segment_bytes: 0,
            chunks_since_manifest: 0,
            shared_state,
        })
    }

    fn run(&mut self, receiver: mpsc::Receiver<WriterCommand>) {
        let mut requested_stop = false;
        let mut stop_reply = None;
        loop {
            match receiver.recv() {
                Ok(WriterCommand::Chunk(chunk)) => {
                    if let Err(error) = self.write_chunk(&chunk) {
                        set_recording_error(&self.shared_state, error.clone());
                        self.manifest.error = Some(error);
                        self.manifest.status = "interrupted".to_string();
                        break;
                    }
                }
                Ok(WriterCommand::Event {
                    event,
                    message,
                    reply,
                }) => {
                    let result = self.write_event(&event, message.as_deref());
                    let _ = reply.send(result);
                }
                Ok(WriterCommand::Stop(reply)) => {
                    requested_stop = true;
                    stop_reply = Some(reply);
                    break;
                }
                Err(_) => break,
            }
        }

        let shared_error = self
            .shared_state
            .lock()
            .ok()
            .and_then(|state| state.status.error.clone());
        if self.manifest.error.is_none() {
            self.manifest.error = shared_error;
        }
        if requested_stop && self.manifest.error.is_none() {
            self.manifest.status = "complete".to_string();
        } else if self.manifest.status == "recording" {
            self.manifest.status = "interrupted".to_string();
            self.manifest
                .error
                .get_or_insert_with(|| "记录写入通道关闭".to_string());
        }
        self.manifest.ended_unix_ms = Some(unix_ms());
        let event_name = if self.manifest.status == "complete" {
            "recording_stopped"
        } else {
            "recording_interrupted"
        };
        let event_error = self.manifest.error.clone();
        let finalize = self.finalize(event_name, event_error.as_deref());

        if let Ok(mut state) = self.shared_state.lock() {
            state.status.is_recording = false;
            state.status.session_id = Some(self.manifest.session_id.clone());
            state.status.directory = Some(self.directory.to_string_lossy().to_string());
            state.status.rx_bytes = self.manifest.rx_bytes;
            state.status.rx_chunks = self.manifest.rx_chunks;
            state.status.error = self
                .manifest
                .error
                .clone()
                .or_else(|| finalize.as_ref().err().cloned());
            state.active = None;
            state.finalizing = false;
        }
        if let Some(reply) = stop_reply {
            let _ = reply.send(finalize);
        }
    }

    fn write_chunk(&mut self, chunk: &RawChunk) -> Result<(), String> {
        if self.segment_bytes > 0
            && self.segment_bytes.saturating_add(chunk.bytes.len() as u64) > SEGMENT_LIMIT_BYTES
        {
            self.rotate_segment()?;
        }
        let offset = self.segment_bytes;
        self.raw_writer
            .write_all(&chunk.bytes)
            .map_err(|e| format!("写入原始 RX 字节失败: {e}"))?;
        let segment_name = format!("rx-{:06}.bin", self.segment_index);
        let index = ChunkIndex {
            session_id: &chunk.session_id,
            epoch: chunk.epoch,
            rx_sequence: chunk.rx_sequence,
            received_at_us: chunk.received_at_us,
            segment: &segment_name,
            offset,
            length: chunk.bytes.len(),
        };
        serde_json::to_writer(&mut self.chunks_writer, &index)
            .map_err(|e| format!("写入原始块索引失败: {e}"))?;
        self.chunks_writer
            .write_all(b"\n")
            .map_err(|e| format!("写入原始块索引换行失败: {e}"))?;
        self.segment_bytes = self.segment_bytes.saturating_add(chunk.bytes.len() as u64);
        self.manifest.rx_bytes = self
            .manifest
            .rx_bytes
            .saturating_add(chunk.bytes.len() as u64);
        self.manifest.rx_chunks = self.manifest.rx_chunks.saturating_add(1);
        self.chunks_since_manifest += 1;
        self.update_shared_status();
        if self.chunks_since_manifest >= MANIFEST_UPDATE_CHUNKS {
            self.flush_and_update_manifest()?;
        }
        Ok(())
    }

    fn rotate_segment(&mut self) -> Result<(), String> {
        self.raw_writer
            .flush()
            .map_err(|e| format!("刷新原始 RX 分段失败: {e}"))?;
        self.raw_writer
            .get_ref()
            .sync_data()
            .map_err(|e| format!("同步原始 RX 分段失败: {e}"))?;
        self.manifest.segments.push(RecordingSegment {
            file: format!("rx-{:06}.bin", self.segment_index),
            bytes: self.segment_bytes,
        });
        self.segment_index += 1;
        self.segment_bytes = 0;
        self.raw_writer = open_segment(&self.directory, self.segment_index)?;
        self.chunks_since_manifest = 0;
        self.flush_and_update_manifest()
    }

    fn update_shared_status(&self) {
        if let Ok(mut state) = self.shared_state.lock() {
            state.status.rx_bytes = self.manifest.rx_bytes;
            state.status.rx_chunks = self.manifest.rx_chunks;
        }
    }

    fn write_event(&mut self, event: &str, message: Option<&str>) -> Result<(), String> {
        write_event(&mut self.events_writer, event, message)
            .map_err(|error| format!("写入记录事件失败: {error}"))?;
        self.events_writer
            .flush()
            .map_err(|error| format!("刷新记录事件失败: {error}"))
    }

    fn flush_and_update_manifest(&mut self) -> Result<(), String> {
        self.raw_writer
            .flush()
            .map_err(|e| format!("刷新原始 RX 分段失败: {e}"))?;
        self.chunks_writer
            .flush()
            .map_err(|e| format!("刷新原始块索引失败: {e}"))?;
        self.manifest.segments.retain(|segment| segment.bytes > 0);
        if self.segment_bytes > 0 {
            let segment_name = format!("rx-{:06}.bin", self.segment_index);
            if let Some(segment) = self
                .manifest
                .segments
                .iter_mut()
                .find(|segment| segment.file == segment_name)
            {
                segment.bytes = self.segment_bytes;
            } else {
                self.manifest.segments.push(RecordingSegment {
                    file: segment_name,
                    bytes: self.segment_bytes,
                });
            }
        }
        write_manifest_atomic(&self.directory, &self.manifest)?;
        self.chunks_since_manifest = 0;
        Ok(())
    }

    fn finalize(&mut self, event: &str, message: Option<&str>) -> Result<(), String> {
        write_event(&mut self.events_writer, event, message)
            .map_err(|e| format!("写入记录结束事件失败: {e}"))?;
        self.events_writer
            .flush()
            .map_err(|e| format!("刷新记录事件失败: {e}"))?;
        self.raw_writer
            .flush()
            .map_err(|e| format!("刷新原始 RX 分段失败: {e}"))?;
        self.raw_writer
            .get_ref()
            .sync_all()
            .map_err(|e| format!("同步原始 RX 分段失败: {e}"))?;
        self.chunks_writer
            .flush()
            .map_err(|e| format!("刷新原始块索引失败: {e}"))?;
        self.chunks_writer
            .get_ref()
            .sync_all()
            .map_err(|e| format!("同步原始块索引失败: {e}"))?;
        self.events_writer
            .get_ref()
            .sync_all()
            .map_err(|e| format!("同步记录事件失败: {e}"))?;
        if self.segment_bytes > 0 {
            self.manifest
                .segments
                .retain(|segment| segment.file != format!("rx-{:06}.bin", self.segment_index));
            self.manifest.segments.push(RecordingSegment {
                file: format!("rx-{:06}.bin", self.segment_index),
                bytes: self.segment_bytes,
            });
        }
        write_manifest_atomic(&self.directory, &self.manifest)
    }
}

fn open_segment(directory: &Path, index: u32) -> Result<BufWriter<File>, String> {
    let path = directory.join(format!("rx-{index:06}.bin"));
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("创建原始 RX 分段失败: {e}"))?;
    Ok(BufWriter::with_capacity(256 * 1024, file))
}

fn open_append(path: &Path) -> Result<BufWriter<File>, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("创建记录索引文件失败: {e}"))?;
    Ok(BufWriter::with_capacity(64 * 1024, file))
}

fn write_event(
    writer: &mut BufWriter<File>,
    event: &str,
    message: Option<&str>,
) -> Result<(), String> {
    let value = RecordingEvent {
        event,
        unix_ms: unix_ms(),
        message,
    };
    serde_json::to_writer(&mut *writer, &value).map_err(|e| format!("序列化记录事件失败: {e}"))?;
    writer
        .write_all(b"\n")
        .map_err(|e| format!("写入记录事件失败: {e}"))
}

fn write_manifest_atomic(directory: &Path, manifest: &RecordingManifest) -> Result<(), String> {
    let path = directory.join("manifest.json");
    let temp_path = directory.join("manifest.json.tmp");
    let contents =
        serde_json::to_vec_pretty(manifest).map_err(|e| format!("序列化记录清单失败: {e}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_path)
        .map_err(|e| format!("创建临时记录清单失败: {e}"))?;
    file.write_all(&contents)
        .map_err(|e| format!("写入临时记录清单失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("同步临时记录清单失败: {e}"))?;
    fs::rename(&temp_path, &path).map_err(|e| format!("原子替换记录清单失败: {e}"))
}

fn safe_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "session".to_string()
    } else {
        cleaned
    }
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn set_recording_error(shared_state: &Arc<Mutex<RecorderState>>, message: String) {
    if let Ok(mut state) = shared_state.lock() {
        state.status.is_recording = false;
        state.status.error = Some(message);
    }
}

#[cfg(test)]
static TEST_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_exact_bytes_with_chunk_index_and_manifest() {
        let root = std::env::temp_dir().join(format!(
            "llm-serial-recording-test-{}",
            TEST_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let directory = root.join("session");
        fs::create_dir(&directory).unwrap();
        let manifest = RecordingManifest {
            format_version: 1,
            session_id: "test-session".to_string(),
            epoch: 2,
            source: "serial".to_string(),
            port: Some("COM-test".to_string()),
            baud_rate: Some(115200),
            protocol_config: None,
            time_source: "host_monotonic_receive".to_string(),
            status: "recording".to_string(),
            started_unix_ms: unix_ms(),
            ended_unix_ms: None,
            rx_bytes: 0,
            rx_chunks: 0,
            unindexed_bytes: 0,
            segments: vec![],
            error: None,
        };
        let shared = Arc::new(Mutex::new(RecorderState {
            status: RecordingStatus {
                is_recording: true,
                session_id: Some("test-session".to_string()),
                directory: Some(directory.to_string_lossy().to_string()),
                ..Default::default()
            },
            active: None,
            starting: false,
            finalizing: false,
        }));
        let writer = RecordingWriter::open(directory.clone(), manifest, shared.clone()).unwrap();
        let (tx, rx) = mpsc::sync_channel(8);
        let join = thread::spawn(move || {
            let mut writer = writer;
            writer.run(rx);
        });
        tx.send(WriterCommand::Chunk(RawChunk {
            session_id: "test-session".to_string(),
            epoch: 2,
            rx_sequence: 1,
            received_at_us: 1234,
            bytes: vec![0x00, 0xFF, 0x80, 0x0A, 0x55],
        }))
        .unwrap();
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(WriterCommand::Stop(reply_tx)).unwrap();
        reply_rx.recv().unwrap().unwrap();
        join.join().unwrap();

        assert_eq!(
            fs::read(directory.join("rx-000000.bin")).unwrap(),
            vec![0x00, 0xFF, 0x80, 0x0A, 0x55]
        );
        let indices = fs::read_to_string(directory.join("chunks.jsonl")).unwrap();
        assert!(indices.contains("\"rxSequence\":1"));
        assert!(indices.contains("\"length\":5"));
        let final_manifest: RecordingManifest =
            serde_json::from_slice(&fs::read(directory.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(final_manifest.status, "complete");
        assert_eq!(final_manifest.rx_bytes, 5);
        assert_eq!(final_manifest.rx_chunks, 1);
        assert_eq!(final_manifest.unindexed_bytes, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovers_only_complete_indexed_prefix_and_preserves_raw_tail_and_old_index() {
        let root = std::env::temp_dir().join(format!(
            "llm-serial-recording-recovery-test-{}",
            TEST_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let directory = root.join("crashed-session");
        fs::create_dir_all(&directory).unwrap();
        let manifest = RecordingManifest {
            format_version: 1,
            session_id: "crashed-session".to_string(),
            epoch: 9,
            source: "serial".to_string(),
            port: Some("COM-test".to_string()),
            baud_rate: Some(115200),
            protocol_config: None,
            time_source: "host_monotonic_receive".to_string(),
            status: "recording".to_string(),
            started_unix_ms: unix_ms(),
            ended_unix_ms: None,
            rx_bytes: 0,
            rx_chunks: 0,
            unindexed_bytes: 0,
            segments: vec![],
            error: None,
        };
        write_manifest_atomic(&directory, &manifest).unwrap();
        fs::write(directory.join("rx-000000.bin"), [1u8, 2, 3, 4, 5]).unwrap();
        let first = serde_json::json!({
            "sessionId": "crashed-session", "epoch": 9, "rxSequence": 1,
            "receivedAtUs": 100, "segment": "rx-000000.bin", "offset": 0, "length": 2
        });
        let second = serde_json::json!({
            "sessionId": "crashed-session", "epoch": 9, "rxSequence": 2,
            "receivedAtUs": 200, "segment": "rx-000000.bin", "offset": 2, "length": 2
        });
        let original_index = format!("{first}\n{second}\n{{partial-json");
        fs::write(directory.join("chunks.jsonl"), &original_index).unwrap();

        let service = RecordingService::with_root_dir(root.clone());
        let summaries = service.list().unwrap();
        assert_eq!(summaries.len(), 1);
        let recovered = &summaries[0].manifest;
        assert_eq!(recovered.status, "interrupted");
        assert_eq!(recovered.rx_bytes, 4);
        assert_eq!(recovered.rx_chunks, 2);
        assert_eq!(recovered.unindexed_bytes, 1);
        assert_eq!(recovered.segments[0].bytes, 5);
        assert!(recovered
            .error
            .as_deref()
            .unwrap()
            .contains("恢复 2 个完整块"));
        assert_eq!(
            fs::read(directory.join("rx-000000.bin")).unwrap(),
            [1, 2, 3, 4, 5]
        );

        let recovered_index = fs::read_to_string(directory.join("chunks.jsonl")).unwrap();
        assert_eq!(recovered_index.lines().count(), 2);
        assert!(!recovered_index.contains("partial-json"));
        let backup = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("chunks.jsonl.pre-recovery-")
            })
            .expect("原始异常索引应保留以便人工恢复");
        assert_eq!(fs::read_to_string(backup.path()).unwrap(), original_index);
        let events = fs::read_to_string(directory.join("events.jsonl")).unwrap();
        assert!(events.contains("recording_recovered"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn service_records_and_stops_in_an_isolated_directory() {
        let root = std::env::temp_dir().join(format!(
            "llm-serial-recording-service-test-{}",
            TEST_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let service = RecordingService::with_root_dir(root.clone());
        let started = service
            .start(
                "service-test".to_string(),
                7,
                RecordingMetadata {
                    source: "serial".to_string(),
                    port: Some("COM-test".to_string()),
                    baud_rate: Some(115200),
                    protocol_config: Some(ProtocolConfig::Firewater),
                },
            )
            .unwrap();
        assert!(started.is_recording);

        let chunks = [vec![0x00, 0xFF], vec![0x80, 0x0A], vec![0x55]];
        let rx_sequences = [2, 3, 5];
        for (index, bytes) in chunks.iter().enumerate() {
            service.write_chunk(RawChunk {
                session_id: "service-test".to_string(),
                epoch: 7,
                rx_sequence: rx_sequences[index],
                received_at_us: 4567 + index as u64,
                bytes: bytes.clone(),
            });
        }
        assert!(service
            .append_event(
                "analysis_completed".to_string(),
                Some(r#"{"algorithm":"fft-spectrum","sampleCount":3}"#.to_string()),
            )
            .unwrap());
        let stopped = service.stop().unwrap();
        assert!(!stopped.is_recording);
        assert_eq!(stopped.rx_bytes, 5);

        let directory = PathBuf::from(stopped.directory.unwrap());
        assert_eq!(fs::read(directory.join("rx-000000.bin")).unwrap(), [0x00, 0xFF, 0x80, 0x0A, 0x55]);
        let summaries = service.list().unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].manifest.source, "serial");
        assert_eq!(summaries[0].manifest.port.as_deref(), Some("COM-test"));
        assert_eq!(summaries[0].manifest.protocol_config, Some(ProtocolConfig::Firewater));
        assert_eq!(summaries[0].manifest.status, "complete");
        let events = fs::read_to_string(directory.join("events.jsonl")).unwrap();
        assert!(events.contains("analysis_completed"));
        assert!(events.contains("fft-spectrum"));

        let page1 = service
            .read_page("service-test", &directory.to_string_lossy(), None, Some(4))
            .unwrap();
        assert_eq!(page1.chunks.len(), 2);
        assert!(!page1.eof);
        assert!(page1.sequence_gap, "首个记录块前缺少 RX 序号时必须标记缺口");
        assert_eq!(page1.chunks[0].bytes, chunks[0]);
        assert_eq!(page1.chunks[1].bytes, chunks[1]);
        let page2 = service
            .read_page("service-test", &directory.to_string_lossy(), page1.next_after_rx_sequence, Some(4))
            .unwrap();
        assert_eq!(page2.chunks.len(), 1);
        assert!(page2.eof);
        assert!(page2.sequence_gap, "分页之间缺失 RX 序号时必须标记缺口");
        assert_eq!(page2.chunks[0].bytes, chunks[2]);
        assert!(service
            .read_page("service-test", "../outside", None, Some(4))
            .is_err());

        let mut old_manifest_json = serde_json::to_value(&summaries[0].manifest).unwrap();
        old_manifest_json.as_object_mut().unwrap().remove("protocolConfig");
        let old_manifest: RecordingManifest = serde_json::from_value(old_manifest_json).unwrap();
        assert_eq!(old_manifest.protocol_config, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_recording_does_not_leave_finalizing_state_stuck_when_writer_exits() {
        let root = std::env::temp_dir().join(format!(
            "llm-serial-recording-interrupt-test-{}",
            TEST_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let service = RecordingService::with_root_dir(root.clone());
        let (sender, receiver) = mpsc::sync_channel::<WriterCommand>(1);
        drop(receiver);
        {
            let mut state = service.state.lock().unwrap();
            state.status = RecordingStatus {
                is_recording: true,
                session_id: Some("interrupt-test".to_string()),
                directory: Some(root.to_string_lossy().to_string()),
                ..Default::default()
            };
            state.active = Some(ActiveRecording { sender });
        }

        service.interrupt("测试记录中断".to_string());
        for _ in 0..100 {
            let status = service.state.lock().unwrap();
            if !status.finalizing {
                assert!(!status.status.is_recording);
                assert!(status.status.error.is_some());
                let _ = fs::remove_dir_all(root);
                return;
            }
            drop(status);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("记录写入线程退出后不能永久停留在 finalizing 状态");
    }
}
