use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// 获取应用数据根目录 (%APPDATA%/LLM-Serial，若存在 portable.flag 则为 exe 同级目录下的 data)
pub fn get_app_dir() -> PathBuf {
    // 检查是否存在便携模式标记 (portable.flag 位于 exe 同级目录)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            if exe_dir.join("portable.flag").exists() {
                return exe_dir.join("data");
            }
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("LLM-Serial")
    } else if let Ok(home) = std::env::var("USERPROFILE") {
        PathBuf::from(home).join(".llm-serial")
    } else {
        PathBuf::from("LLM-Serial")
    }
}

/// 获取日志目录 (%APPDATA%/LLM-Serial/logs)
pub fn get_log_dir() -> PathBuf {
    get_app_dir().join("logs")
}

/// 清理超过 max_days 天的历史旧日志 (PRD Step 2.1 保留 7 天)
pub fn cleanup_old_logs(log_dir: &std::path::Path, max_days: u64) {
    if !log_dir.exists() {
        return;
    }
    let max_age = Duration::from_secs(max_days * 24 * 3600);
    let now = SystemTime::now();

    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(age) = now.duration_since(modified) {
                            if age > max_age {
                                let _ = fs::remove_file(&path);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 初始化系统级轮转日志 (控制台输出 + 每日轮转文件)
pub fn init_logger() -> Option<WorkerGuard> {
    let log_dir = get_log_dir();
    let _ = fs::create_dir_all(&log_dir);
    cleanup_old_logs(&log_dir, 7);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "llm-serial.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,llm_serial_lib=debug"));

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(
            fmt::layer()
                .with_writer(std::io::stdout)
                .with_target(false)
                .with_thread_ids(false),
        )
        .with(
            fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false)
                .with_target(true),
        );

    if subscriber.try_init().is_ok() {
        tracing::info!("Logger initialized. Log dir: {}", log_dir.display());
        Some(guard)
    } else {
        None
    }
}

/// 在系统文件资源管理器中打开日志目录
pub fn open_log_directory() -> Result<String, String> {
    let log_dir = get_log_dir();
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    {
        let win_path = log_dir.to_string_lossy().replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(&win_path)
            .spawn()
            .map_err(|e| format!("无法打开资源管理器: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&log_dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {}", e))?;
    }

    Ok(log_dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_dir_path() {
        let log_dir = get_log_dir();
        assert!(log_dir.to_string_lossy().contains("LLM-Serial"));
        assert!(log_dir.to_string_lossy().contains("logs"));
    }

    #[test]
    fn test_cleanup_old_logs_nonexistent_dir() {
        let dummy_dir = PathBuf::from("nonexistent_test_dir_12345");
        // Should not panic on non-existent directory
        cleanup_old_logs(&dummy_dir, 7);
    }

    #[test]
    fn test_cleanup_old_logs_with_temp_dir() {
        let temp_dir = std::env::temp_dir().join("llm_serial_test_logger_cleanup");
        let _ = fs::create_dir_all(&temp_dir);
        let file1 = temp_dir.join("recent.log");
        fs::write(&file1, "recent log content").unwrap();

        // With max_days = 10, newly created file should NOT be removed
        cleanup_old_logs(&temp_dir, 10);
        assert!(file1.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
