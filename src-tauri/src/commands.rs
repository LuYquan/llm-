use tauri::{AppHandle, State};
use crate::config::{load_config, save_config, AppConfig};
use crate::logger::open_log_directory;
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
    state: State<'_, AppState>,
) -> Result<PipelineStatus, String> {
    Ok(state.pipeline.stop().await)
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
pub async fn open_log_dir() -> Result<String, String> {
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
