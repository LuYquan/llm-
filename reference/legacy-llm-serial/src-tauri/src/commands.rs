use crate::config::{load_config_checked, save_config, AppConfig, ChannelMapping};
use crate::logger::open_log_directory;
use crate::model::{ChecksumResult, SerialSettings, WaveformBatch};
use crate::pipeline::{PipelineManager, PipelineStatus};
use crate::protocol::ProtocolConfig;
use crate::recording::{RecordingPage, RecordingStatus, RecordingSummary};
use crate::serial::{enumerate_serial_ports, SerialPortInfo};
use tauri::{ipc::Channel, AppHandle, State};

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
    serial_settings: Option<SerialSettings>,
) -> Result<PipelineStatus, String> {
    let mode_str = mode.unwrap_or_else(|| "serial".to_string());
    state
        .pipeline
        .start(app, mode_str, port, baud_rate, serial_settings)
        .await
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
pub async fn get_pipeline_status(state: State<'_, AppState>) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.get_status().await)
}

#[tauri::command]
pub async fn set_acquisition_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<PipelineStatus, String> {
    state.pipeline.set_acquisition_enabled(enabled).await
}

#[tauri::command]
pub async fn start_recording(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    state.pipeline.start_recording().await
}

#[tauri::command]
pub async fn stop_recording(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    state.pipeline.stop_recording()
}

/// Persist a bounded analysis provenance payload in the active recording's
/// events.jsonl. Returning false means no recording is active; this is not an
/// error because analyses may also be run against live, unrecorded data.
#[tauri::command]
pub async fn append_analysis_event(
    state: State<'_, AppState>,
    provenance: serde_json::Value,
) -> Result<bool, String> {
    let message = serde_json::to_string(&provenance)
        .map_err(|error| format!("序列化分析溯源失败: {error}"))?;
    state
        .pipeline
        .append_recording_event("analysis_completed".to_string(), Some(message))
}

#[tauri::command]
pub async fn get_recording_status(state: State<'_, AppState>) -> Result<RecordingStatus, String> {
    state.pipeline.recording_status()
}

#[tauri::command]
pub async fn list_recordings(state: State<'_, AppState>) -> Result<Vec<RecordingSummary>, String> {
    state.pipeline.list_recordings()
}

#[tauri::command]
pub async fn read_recording_page(
    state: State<'_, AppState>,
    session_id: String,
    directory: String,
    after_rx_sequence: Option<u64>,
    max_bytes: Option<usize>,
) -> Result<RecordingPage, String> {
    state.pipeline.read_recording_page(
        &session_id,
        &directory,
        after_rx_sequence,
        max_bytes,
    )
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
    serial_settings: Option<SerialSettings>,
) -> Result<PipelineStatus, String> {
    state
        .pipeline
        .start(
            app,
            "serial".to_string(),
            Some(port),
            baud_rate,
            serial_settings,
        )
        .await
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
    let mode_str = format
        .map(|f| format!("mock_{}", f))
        .unwrap_or_else(|| "mock".to_string());
    state.pipeline.start(app, mode_str, None, None, None).await
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
) -> Result<crate::model::WriteReceipt, String> {
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
pub async fn send_emergency_bytes(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    state.pipeline.send_emergency_raw_bytes(bytes).await
}

#[tauri::command]
pub async fn software_stop(
    state: State<'_, AppState>,
    bytes: Option<Vec<u8>>,
) -> Result<(), String> {
    state.pipeline.send_software_stop(bytes).await
}

#[tauri::command]
pub async fn resume_writes(state: State<'_, AppState>) -> Result<(), String> {
    state.pipeline.resume_writes().await
}

#[tauri::command]
pub async fn get_write_lock_status(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.pipeline.writes_locked())
}

#[tauri::command]
pub async fn get_waveform_window(
    state: State<'_, AppState>,
    start_us: u64,
    end_us: u64,
    max_points: Option<usize>,
) -> Result<Option<WaveformBatch>, String> {
    state
        .pipeline
        .get_waveform_window(start_us, end_us, max_points)
        .await
}

#[tauri::command]
pub async fn subscribe_waveform_channel(
    state: State<'_, AppState>,
    channel: Channel<WaveformBatch>,
) -> Result<(), String> {
    state.pipeline.set_waveform_channel(channel).await;
    Ok(())
}

#[tauri::command]
pub async fn unsubscribe_waveform_channel(state: State<'_, AppState>) -> Result<(), String> {
    state.pipeline.clear_waveform_channel().await;
    Ok(())
}

#[tauri::command]
pub async fn start_periodic_send(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    interval_ms: u64,
) -> Result<(), String> {
    state.pipeline.start_periodic_send(bytes, interval_ms).await
}

#[tauri::command]
pub async fn stop_periodic_send(state: State<'_, AppState>) -> Result<(), String> {
    state.pipeline.stop_periodic_send().await
}

#[tauri::command]
pub fn calculate_checksums(data: String, is_hex: bool) -> Result<ChecksumResult, String> {
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
    load_config_with_secret()
}

#[tauri::command]
pub async fn save_app_config(mut config: AppConfig) -> Result<(), String> {
    persist_config_with_secret(&mut config)
}

#[tauri::command]
pub async fn get_workspace_config() -> Result<AppConfig, String> {
    load_config_with_secret()
}

#[tauri::command]
pub async fn save_workspace_config(mut config: AppConfig) -> Result<(), String> {
    persist_config_with_secret(&mut config)
}

#[tauri::command]
pub async fn request_ai_chat(
    request: crate::ai::client::AiChatRequest,
) -> Result<String, String> {
    let api_key = crate::secrets::load_api_key()?;
    crate::ai::client::chat(request, &api_key).await
}

#[tauri::command]
pub async fn fetch_ai_models(
    request: crate::ai::client::AiModelsRequest,
) -> Result<Vec<String>, String> {
    let api_key = crate::secrets::load_api_key()?;
    crate::ai::client::models(request, &api_key).await
}

#[tauri::command]
pub async fn set_protocol_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ProtocolConfig,
) -> Result<u64, String> {
    state.pipeline.set_protocol_config(&app, config).await
}

/// 旧版本曾将 API Key 写入普通 config.json。
/// 首次读取时先迁移到受保护存储并回读验证，再清除旧字段。
fn load_config_with_secret() -> Result<AppConfig, String> {
    let mut config = load_config_checked()?;
    let mut should_persist = false;
    if !config.ai_config.api_key.is_empty() {
        crate::secrets::save_api_key(&config.ai_config.api_key)?;
        let verified = crate::secrets::load_api_key()?;
        if verified != config.ai_config.api_key {
            return Err("API Key 加密迁移校验失败；原配置文件已保留".to_string());
        }
        config.ai_config.api_key.clear();
        config.ai_config.api_key_configured = true;
        should_persist = true;
    }

    let stored_key = crate::secrets::load_api_key()?;
    let configured = !stored_key.is_empty();
    if config.ai_config.api_key_configured != configured || !config.ai_config.api_key.is_empty() {
        config.ai_config.api_key_configured = configured;
        config.ai_config.api_key.clear();
        should_persist = true;
    }
    if should_persist {
        save_config(&config)?;
    }
    // The renderer receives only a boolean state. The plaintext key remains
    // inside the Rust command boundary for actual requests.
    config.ai_config.api_key.clear();
    config.ai_config.api_key_configured = configured;
    Ok(config)
}

/// 普通配置保存前将密钥交给 DPAPI/受保护存储，并在序列化前移除明文。
/// 空输入且仍标记为 configured 时保留已有密钥，避免普通 autosave 清空密钥。
fn persist_config_with_secret(config: &mut AppConfig) -> Result<(), String> {
    let incoming_key = config.ai_config.api_key.trim().to_string();
    if !incoming_key.is_empty() {
        crate::secrets::save_api_key(&incoming_key)?;
        if crate::secrets::load_api_key()? != incoming_key {
            return Err("API Key 加密保存校验失败；普通配置未写入".to_string());
        }
        config.ai_config.api_key_configured = true;
    } else if config.ai_config.api_key_configured {
        config.ai_config.api_key_configured = !crate::secrets::load_api_key()?.is_empty();
    } else {
        crate::secrets::save_api_key("")?;
        config.ai_config.api_key_configured = false;
    }
    config.ai_config.api_key.clear();
    save_config(config)
}

#[tauri::command]
pub async fn set_channel_mapping(
    state: State<'_, AppState>,
    mapping: ChannelMapping,
) -> Result<(), String> {
    state.pipeline.set_channel_mapping(mapping.clone()).await;
    // 静默持久化至 config.json (PRD 10.2 & M8)
    let mut cfg = load_config_checked()?;
    cfg.channel_mapping = mapping;
    save_config(&cfg)?;
    Ok(())
}

#[tauri::command]
pub async fn get_channel_mapping(state: State<'_, AppState>) -> Result<ChannelMapping, String> {
    Ok(state.pipeline.get_channel_mapping().await)
}

#[tauri::command]
pub async fn send_serial_data(
    state: State<'_, AppState>,
    data: String,
    is_hex: bool,
    append_newline: bool,
) -> Result<crate::model::WriteReceipt, String> {
    state
        .pipeline
        .send_data(&data, is_hex, append_newline)
        .await
}

#[tauri::command]
pub async fn diagnose_pid_offline(
    metrics: crate::model::StepMetrics,
    current_pid: crate::ai::PidParams,
) -> Result<crate::ai::AiDiagnosisResult, String> {
    crate::ai::OfflineRuleEngine::diagnose(current_pid, &metrics)
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
