mod nfc_reader;

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
            if let Some(main_window) = app.get_webview_window("main") {
                // Force fullscreen, remove titlebar, and keep on top
                let _ = main_window.set_fullscreen(true);
                let _ = main_window.set_decorations(false);
                let _ = main_window.set_always_on_top(true);
                let _ = main_window.set_focus();
            }

            // Spawn the NFC loop on a background thread on startup
            thread::spawn(nfc_reader::start_nfc_loop);

            Ok(())
        })
        // 2. Intercept window events (e.g. prevent Alt+F4 / Close)
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Block the app from closing via OS close events
                api.prevent_close();
            }
        })
        // 3. Register your IPC commands here if you have any
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
