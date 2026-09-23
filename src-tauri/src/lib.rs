pub mod ai;
pub mod archive;
pub mod commands;
pub mod config;
pub mod logger;
pub mod model;
pub mod pipeline;
pub mod secrets;
pub mod serial;

use commands::*;
use pipeline::PipelineManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化系统级轮转日志 (Step 2.1)
    let _log_guard = logger::init_logger();

    tauri::Builder::default()
        .manage(AppState {
            pipeline: PipelineManager::new(),
        })
        .invoke_handler(tauri::generate_handler![
            start_pipeline,
            stop_pipeline,
            reset_pipeline,
            get_pipeline_status,
            list_serial_ports,
            connect_serial,
            disconnect_serial,
            start_mock,
            stop_mock,
            send_bytes,
            send_emergency_stop,
            get_waveform_window,
            start_periodic_send,
            stop_periodic_send,
            calculate_checksums,
            open_log_dir,
            open_log_directory_cmd,
            load_app_config,
            save_app_config,
            get_workspace_config,
            save_workspace_config,
            set_channel_mapping,
            get_channel_mapping,
            send_serial_data,
            diagnose_pid_offline,
            score_step_metrics,
            validate_and_apply_pid,
            approve_pid_params,
            save_api_key,
            get_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
