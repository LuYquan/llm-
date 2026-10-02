pub mod ai;
pub mod archive;
pub mod commands;
pub mod config;
pub mod logger;
pub mod model;
pub mod pipeline;
pub mod protocol;
pub mod recording;
pub mod secrets;
pub mod serial;

use commands::*;
use pipeline::PipelineManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. 初始化系统级轮转日志
    let _log_guard = logger::init_logger();
    tracing::info!("Starting LLM Serial Application...");
    tracing::info!(concat!("llm-serial-build:", env!("LLM_SERIAL_BUILD_ID")));

    // 2. 捕获全局 Panic 并写入日志，杜绝静默闪退无痕迹
    std::panic::set_hook(Box::new(|panic_info| {
        let msg = match panic_info.payload().downcast_ref::<&str>() {
            Some(s) => *s,
            None => match panic_info.payload().downcast_ref::<String>() {
                Some(s) => &**s,
                None => "Unknown panic payload",
            },
        };
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let full_error = format!("CRITICAL PANIC at {}: {}", location, msg);
        tracing::error!("{}", full_error);
        eprintln!("{}", full_error);

        #[cfg(windows)]
        unsafe {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            let wide_msg: Vec<u16> = OsStr::new(&format!(
                "程序运行遇到异常:\n{}\n\n详细日志请查看 data/logs 目录。",
                full_error
            ))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
            let wide_title: Vec<u16> = OsStr::new("LLM串口 - 运行错误")
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // Windows MessageBoxW API (0x10 = MB_ICONERROR)
            extern "system" {
                fn MessageBoxW(
                    hwnd: isize,
                    text: *const u16,
                    caption: *const u16,
                    utype: u32,
                ) -> i32;
            }
            MessageBoxW(0, wide_msg.as_ptr(), wide_title.as_ptr(), 0x10);
        }
    }));

    let app = tauri::Builder::default()
        .setup(|app| {
            tracing::info!("Tauri setup hook started...");
            if let Some(window) = app.get_webview_window("main") {
                tracing::info!("Found main window, ensuring visibility and focus...");
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            } else {
                tracing::warn!("Warning: 'main' webview window not found in setup hook!");
            }
            tracing::info!("Tauri setup hook finished successfully.");
            Ok(())
        })
        .manage(AppState {
            pipeline: PipelineManager::new(),
        })
        .invoke_handler(tauri::generate_handler![
            start_pipeline,
            stop_pipeline,
            reset_pipeline,
            get_pipeline_status,
            set_acquisition_enabled,
            start_recording,
            stop_recording,
            append_analysis_event,
            get_recording_status,
            list_recordings,
            read_recording_page,
            list_serial_ports,
            connect_serial,
            disconnect_serial,
            start_mock,
            stop_mock,
            send_bytes,
            send_emergency_stop,
            send_emergency_bytes,
            software_stop,
            resume_writes,
            get_write_lock_status,
            get_waveform_window,
            subscribe_waveform_channel,
            unsubscribe_waveform_channel,
            start_periodic_send,
            stop_periodic_send,
            calculate_checksums,
            open_log_dir,
            open_log_directory_cmd,
            load_app_config,
            save_app_config,
            get_workspace_config,
            save_workspace_config,
            request_ai_chat,
            fetch_ai_models,
            set_protocol_config,
            set_channel_mapping,
            get_channel_mapping,
            send_serial_data,
            diagnose_pid_offline,
            score_step_metrics,
            validate_and_apply_pid,
            approve_pid_params,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => {
            tracing::info!("Tauri application built successfully, running event loop...");
            app.run(|_app_handle, event| match &event {
                tauri::RunEvent::Ready => {
                    tracing::info!("Tauri RunEvent::Ready fired.");
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: win_event,
                    ..
                } => {
                    tracing::info!("WindowEvent [{}]: {:?}", label, win_event);
                }
                tauri::RunEvent::Exit => {
                    tracing::info!("Tauri RunEvent::Exit fired.");
                }
                tauri::RunEvent::ExitRequested { code, .. } => {
                    tracing::info!("Tauri RunEvent::ExitRequested fired with code: {:?}", code);
                }
                _ => {}
            });
        }
        Err(err) => {
            let err_msg = format!("Failed to build tauri application: {}", err);
            tracing::error!("{}", err_msg);
            eprintln!("{}", err_msg);
            #[cfg(windows)]
            unsafe {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                let wide_msg: Vec<u16> = OsStr::new(&format!(
                    "启动失败:\n{}\n\n请检查 WebView2 运行时是否正常。",
                    err_msg
                ))
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
                let wide_title: Vec<u16> = OsStr::new("LLM串口 - 启动失败")
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                extern "system" {
                    fn MessageBoxW(
                        hwnd: isize,
                        text: *const u16,
                        caption: *const u16,
                        utype: u32,
                    ) -> i32;
                }
                MessageBoxW(0, wide_msg.as_ptr(), wide_title.as_ptr(), 0x10);
            }
        }
    }
}
