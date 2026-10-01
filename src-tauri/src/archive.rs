use crate::logger::get_app_dir;
use crate::model::{LogDirection, LogLevel, LogLine};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// 串口数据本地归档目录 (%APPDATA%/LLM-Serial/archive)
pub fn get_archive_dir() -> PathBuf {
    get_app_dir().join("archive")
}

/// 串口归档记录器 (PRD 2.4.1 PR-001 & engineering-decisions 5.6)
///
/// 核心职责：
/// 1. 独立于 UI 2000 行限制，持久化保存完整串口 RX/TX 报文；
/// 2. 携带连续递增序号 `seq` 与单调微秒时间戳 `timestamp_us`；
/// 3. 支持按文件大小轮转；历史文件不会因为数量达到阈值而停止写入；
/// 4. 磁盘异常计数与错误隔离 (严禁 Panic)；
/// 5. 500Hz 吞吐下序号连续完整。
pub struct SerialArchiveWriter {
    current_file: Option<BufWriter<File>>,
    current_file_path: Option<PathBuf>,
    current_file_bytes: u64,
    max_file_bytes: u64,
    archive_dir: PathBuf,
    seq: Arc<AtomicU64>,
    error_count: Arc<AtomicU64>,
}

static ARCHIVE_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(1);

impl SerialArchiveWriter {
    pub fn new() -> Self {
        Self::with_config(10 * 1024 * 1024, 10) // 10MB per file; second arg kept for compatibility
    }

    pub fn with_config(max_file_bytes: u64, max_files: usize) -> Self {
        Self::with_dir_and_config(get_archive_dir(), max_file_bytes, max_files)
    }

    pub fn with_dir_and_config(
        archive_dir: PathBuf,
        max_file_bytes: u64,
        _max_files: usize,
    ) -> Self {
        let mut writer = Self {
            current_file: None,
            current_file_path: None,
            current_file_bytes: 0,
            max_file_bytes,
            archive_dir,
            seq: Arc::new(AtomicU64::new(0)),
            error_count: Arc::new(AtomicU64::new(0)),
        };
        if let Err(e) = writer.rotate_new_file() {
            writer.error_count.fetch_add(1, Ordering::Relaxed);
            tracing::warn!("创建串口归档文件失败: {}", e);
        }
        writer
    }

    /// 轮转创建新归档文件
    fn rotate_new_file(&mut self) -> std::io::Result<()> {
        let dir = &self.archive_dir;
        fs::create_dir_all(dir)?;

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let instance_id = ARCHIVE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let file_name = format!("serial_archive_{}_{}.csv", now, instance_id);
        let file_path = dir.join(&file_name);

        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&file_path)?;

        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        // CSV 表头。`max_files` 曾经是一个硬上限，但达到上限后停止
        // 归档会造成静默数据缺口；现在仅按单文件大小轮转，历史文件
        // 由用户的磁盘策略管理。参数仍保留在构造函数中以兼容旧调用。
        let header = "seq,timestamp_us,direction,level,text,raw_hex\n";
        writer.write_all(header.as_bytes())?;
        writer.flush()?;

        self.current_file = Some(writer);
        self.current_file_path = Some(file_path);
        self.current_file_bytes = header.len() as u64;

        Ok(())
    }

    /// 写入一条日志行
    pub fn write_line(&mut self, log: &LogLine) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let dir_str = match log.direction {
            LogDirection::Rx => "RX",
            LogDirection::Tx => "TX",
        };
        let level_str = match log.level {
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
            LogLevel::Data => "DATA",
        };

        // CSV 转义
        let escaped_text = log.text.replace('"', "\"\"");
        let raw_hex = log.raw_hex.as_deref().unwrap_or("");

        let line = format!(
            "{},{},{},{},\"{}\",\"{}\"\n",
            seq, log.timestamp_us, dir_str, level_str, escaped_text, raw_hex
        );

        let line_len = line.len() as u64;
        if self.current_file_bytes + line_len > self.max_file_bytes {
            if let Err(e) = self.rotate_new_file() {
                self.error_count.fetch_add(1, Ordering::Relaxed);
                tracing::warn!("归档文件轮转失败: {}", e);
                return;
            }
        }

        if let Some(writer) = self.current_file.as_mut() {
            match writer.write_all(line.as_bytes()) {
                Ok(_) => {
                    self.current_file_bytes += line_len;
                }
                Err(e) => {
                    self.error_count.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!("写入串口归档失败: {}", e);
                }
            }
        }
    }

    /// 刷新缓冲区落盘
    pub fn flush(&mut self) {
        if let Some(writer) = self.current_file.as_mut() {
            if let Err(e) = writer.flush() {
                self.error_count.fetch_add(1, Ordering::Relaxed);
                tracing::warn!("刷新串口归档失败: {}", e);
            }
        }
    }

    pub fn current_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    pub fn error_count(&self) -> u64 {
        self.error_count.load(Ordering::Relaxed)
    }

    pub fn current_file_path(&self) -> Option<PathBuf> {
        self.current_file_path.clone()
    }
}

/// 线程安全的归档记录句柄
#[derive(Clone)]
pub struct SharedSerialArchive {
    inner: Arc<Mutex<SerialArchiveWriter>>,
}

impl SharedSerialArchive {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SerialArchiveWriter::new())),
        }
    }

    pub fn write_line(&self, log: &LogLine) {
        if let Ok(mut writer) = self.inner.lock() {
            writer.write_line(log);
        }
    }

    pub fn flush(&self) {
        if let Ok(mut writer) = self.inner.lock() {
            writer.flush();
        }
    }

    pub fn current_seq(&self) -> u64 {
        self.inner.lock().map(|w| w.current_seq()).unwrap_or(0)
    }

    pub fn error_count(&self) -> u64 {
        self.inner.lock().map(|w| w.error_count()).unwrap_or(0)
    }
}

impl Default for SharedSerialArchive {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serial_archive_sequential_writes() {
        let temp_dir = std::env::temp_dir().join("llm_serial_test_archive_seq");
        let _ = fs::create_dir_all(&temp_dir);

        let mut writer = SerialArchiveWriter::with_dir_and_config(temp_dir.clone(), 1024 * 1024, 5);

        // 写入 500 条 RX/TX 行
        for i in 0..500 {
            let log = LogLine {
                timestamp_us: i * 2000,
                direction: if i % 2 == 0 {
                    LogDirection::Rx
                } else {
                    LogDirection::Tx
                },
                level: if i % 10 == 0 {
                    LogLevel::Warn
                } else {
                    LogLevel::Data
                },
                text: format!("10.00,{:.2},30.00", 9.0 + (i as f64) * 0.01),
                raw_hex: Some(format!("31 30 2E 30 30 {:02X}", i % 256)),
                rx_origin: None,
            };
            writer.write_line(&log);
        }
        writer.flush();

        assert_eq!(writer.current_seq(), 500);
        assert_eq!(writer.error_count(), 0);

        // 验证文件内容与序号连续性
        if let Some(path) = writer.current_file_path() {
            let content = fs::read_to_string(&path).expect("Read archive failed");
            let lines: Vec<&str> = content.lines().collect();
            assert_eq!(lines.len(), 501); // 1 header + 500 lines
            assert_eq!(lines[0], "seq,timestamp_us,direction,level,text,raw_hex");

            // 检查第 1 行与第 500 行的 seq 序号
            assert!(lines[1].starts_with("0,0,RX,WARN,"));
            assert!(lines[500].starts_with("499,998000,TX,DATA,"));

            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_serial_archive_file_rotation() {
        let temp_dir = std::env::temp_dir().join("llm_serial_test_archive_rot");
        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::create_dir_all(&temp_dir);

        // 配置小容量触发轮转；历史文件不被删除，也不能因为旧文件过多
        // 而停止写入，避免归档链路制造静默缺口。
        let mut writer = SerialArchiveWriter::with_dir_and_config(temp_dir.clone(), 500, 3);
        for i in 0..50 {
            let log = LogLine {
                timestamp_us: i * 1000,
                direction: LogDirection::Rx,
                level: LogLevel::Info,
                text: format!("Log line number {}", i),
                raw_hex: None,
                rx_origin: None,
            };
            writer.write_line(&log);
        }
        writer.flush();
        assert_eq!(writer.current_seq(), 50);
        assert_eq!(writer.error_count(), 0, "历史文件数量不应阻断新归档");

        let csv_files = fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("csv"))
            .count();
        assert!(csv_files > 3, "单文件轮转应继续创建新归档文件");
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
