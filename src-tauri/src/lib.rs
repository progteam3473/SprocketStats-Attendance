mod nfc_reader;

use std::sync::{mpsc, Mutex};
use std::thread;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .build(),
        )
        // 1. Setup hook runs when the app starts up
        .setup(|app| {
            // Fullscreen, no titlebar and always-on-top come from tauri.conf.json;
            // just make sure the kiosk window has focus.
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_focus();
            }

            // Scan feedback channel: the `nfc_feedback` command sends the
            // frontend's verdict, the NFC thread waits on it after each scan.
            let (feedback_tx, feedback_rx) = mpsc::channel();
            app.manage(nfc_reader::FeedbackSender(Mutex::new(feedback_tx)));

            // Spawn the NFC loop on a background thread on startup
            let handle = app.handle().clone();
            thread::spawn(move || nfc_reader::start_nfc_loop(handle, feedback_rx));

            Ok(())
        })
        // 2. Intercept window events (e.g. prevent Alt+F4 / Close)
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Block the app from closing via OS close events
                api.prevent_close();
            }
        })
        // 3. IPC commands callable from the frontend
        .invoke_handler(tauri::generate_handler![nfc_reader::nfc_feedback])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
