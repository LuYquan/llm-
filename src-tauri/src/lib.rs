pub mod commands;
pub mod config;
pub mod logger;
pub mod pipeline;
pub mod serial;

use commands::{
    get_pipeline_status, list_serial_ports, load_app_config, open_log_dir, reset_pipeline,
    save_app_config, start_pipeline, stop_pipeline, AppState,
};
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
            open_log_dir,
            load_app_config,
            save_app_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

