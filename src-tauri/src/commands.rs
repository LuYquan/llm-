use tauri::{AppHandle, State};
use crate::config::{load_config, save_config, AppConfig, ChannelMapping};
use crate::logger::open_log_directory;
use crate::model::{ChecksumResult, WaveformBatch};
use crate::pipeline::{PipelineManager, PipelineStatus};
use crate::serial::{enumerate_serial_ports, SerialPortInfo};

pub struct AppState {
    pub pipeline: PipelineManager,
}

#[tauri::command]
pub async fn start_pipeline(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: Option<String>,
    port: Option<String>,
    baud_rate: Option<u32>,
) -> Result<PipelineStatus, String> {
    let mode_str = mode.unwrap_or_else(|| "mock".to_string());
    state.pipeline.start(app, mode_str, port, baud_rate).await
}

#[tauri::command]
pub async fn stop_pipeline(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.stop(Some(&app)).await)
}

#[tauri::command]
pub async fn reset_pipeline(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.reset(&app).await)
}

#[tauri::command]
pub async fn get_pipeline_status(
    state: State<'_, AppState>,
) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.get_status().await)
}

#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    enumerate_serial_ports()
}

#[tauri::command]
pub async fn connect_serial(
    app: AppHandle,
    state: State<'_, AppState>,
    port: String,
    baud_rate: Option<u32>,
) -> Result<PipelineStatus, String> {
    state.pipeline.start(app, "serial".to_string(), Some(port), baud_rate).await
}

#[tauri::command]
pub async fn disconnect_serial(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.stop(Some(&app)).await)
}

#[tauri::command]
pub async fn start_mock(
    app: AppHandle,
    state: State<'_, AppState>,
    format: Option<String>,
) -> Result<PipelineStatus, String> {
    let mode_str = format.map(|f| format!("mock_{}", f)).unwrap_or_else(|| "mock".to_string());
    state.pipeline.start(app, mode_str, None, None).await
}

#[tauri::command]
pub async fn stop_mock(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.stop(Some(&app)).await)
}

#[tauri::command]
pub async fn send_bytes(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    state.pipeline.send_raw_bytes(bytes).await
}

#[tauri::command]
pub async fn send_emergency_stop(
    state: State<'_, AppState>,
    data: Option<String>,
) -> Result<(), String> {
    state.pipeline.send_emergency_stop(data).await
}

#[tauri::command]
pub async fn get_waveform_window(
    state: State<'_, AppState>,
    start_us: u64,
    end_us: u64,
    max_points: Option<usize>,
) -> Result<Option<WaveformBatch>, String> {
    state.pipeline.get_waveform_window(start_us, end_us, max_points).await
}

#[tauri::command]
pub async fn start_periodic_send(
    state: State<'_, AppState>,
    data: String,
    interval_ms: u64,
    is_hex: bool,
) -> Result<(), String> {
    state.pipeline.start_periodic_send(data, interval_ms, is_hex).await
}

#[tauri::command]
pub async fn stop_periodic_send(
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pipeline.stop_periodic_send().await
}

#[tauri::command]
pub fn calculate_checksums(
    data: String,
    is_hex: bool,
) -> Result<ChecksumResult, String> {
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
        data.into_bytes()
    };
    Ok(ChecksumResult::from_bytes(&bytes))
}

#[tauri::command]
pub async fn open_log_dir() -> Result<String, String> {
    open_log_directory()
}

#[tauri::command]
pub async fn open_log_directory_cmd() -> Result<String, String> {
    open_log_directory()
}

#[tauri::command]
pub async fn load_app_config() -> Result<AppConfig, String> {
    Ok(load_config())
}

#[tauri::command]
pub async fn save_app_config(config: AppConfig) -> Result<(), String> {
    save_config(&config)
}

#[tauri::command]
pub async fn get_workspace_config() -> Result<AppConfig, String> {
    Ok(load_config())
}

#[tauri::command]
pub async fn save_workspace_config(config: AppConfig) -> Result<(), String> {
    save_config(&config)
}

#[tauri::command]
pub async fn set_channel_mapping(
    state: State<'_, AppState>,
    mapping: ChannelMapping,
) -> Result<(), String> {
    state.pipeline.set_channel_mapping(mapping.clone()).await;
    // 静默持久化至 config.json (PRD 10.2 & M8)
    let mut cfg = load_config();
    cfg.channel_mapping = mapping;
    let _ = save_config(&cfg);
    Ok(())
}

#[tauri::command]
pub async fn get_channel_mapping(
    state: State<'_, AppState>,
) -> Result<ChannelMapping, String> {
    Ok(state.pipeline.get_channel_mapping().await)
}

#[tauri::command]
pub async fn send_serial_data(
    state: State<'_, AppState>,
    data: String,
    is_hex: bool,
    append_newline: bool,
) -> Result<(), String> {
    state.pipeline.send_data(&data, is_hex, append_newline).await
}

#[tauri::command]
pub async fn diagnose_pid_offline(
    metrics: crate::model::StepMetrics,
    current_pid: crate::ai::PidParams,
) -> Result<crate::ai::AiDiagnosisResult, String> {
    Ok(crate::ai::OfflineRuleEngine::diagnose(current_pid, &metrics))
}

#[tauri::command]
pub async fn score_step_metrics(
    metrics: crate::model::StepMetrics,
) -> Result<crate::ai::RadarMetrics, String> {
    Ok(crate::ai::MetricScorer::score(&metrics))
}

#[tauri::command]
pub async fn validate_and_apply_pid(
    state: State<'_, AppState>,
    current_pid: crate::ai::PidParams,
    new_pid: crate::ai::PidParams,
) -> Result<String, String> {
    // 1. 经由 SafetyGuard 严格防线校验
    let cmd = crate::ai::SafetyGuard::validate_and_format_command(current_pid, new_pid)?;
    // 2. 下发指令至串口/仿真
    state.pipeline.send_data(&cmd, false, false).await?;
    tracing::info!("PID 参数成功通过 SafetyGuard 并核准下发: {}", cmd.trim());
    Ok(cmd)
}

#[tauri::command]
pub async fn approve_pid_params(
    state: State<'_, AppState>,
    current_pid: crate::ai::PidParams,
    new_pid: crate::ai::PidParams,
) -> Result<String, String> {
    validate_and_apply_pid(state, current_pid, new_pid).await
}

#[tauri::command]
pub async fn save_api_key(api_key: String) -> Result<(), String> {
    crate::secrets::save_api_key(&api_key)
}

#[tauri::command]
pub async fn get_api_key() -> Result<String, String> {
    crate::secrets::load_api_key()
}
