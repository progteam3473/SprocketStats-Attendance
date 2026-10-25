mod nfc_reader;

use std::sync::{mpsc, Mutex};
use std::thread;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

// SHA-256 of the admin exit code, so the code itself isn't in the source.
// To change it: printf '%s' 'NewCode' | sha256sum
const EXIT_CODE_SHA256: &str = "b35f0413dc10ea54e20cb6ba00640b511b0073100ed2043b08503dfc03bb5e7d";

/// The only way out of the kiosk short of killing the process: the frontend
/// sends the code an admin typed; quit if it matches. Returns false if not.
#[tauri::command]
fn exit_app(code: String, app: AppHandle) -> bool {
    let digest = Sha256::digest(code.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if hex != EXIT_CODE_SHA256 {
        log::warn!("Exit attempted with a wrong code.");
        return false;
    }
    log::info!("Exit code accepted; quitting.");
    app.exit(0);
    true
}

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
        // 2. Intercept window events (e.g. prevent Alt+F4 / Close); exit_app
        //    quits via app.exit, which this doesn't block
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Block the app from closing via OS close events
                api.prevent_close();
            }
        })
        // 3. IPC commands callable from the frontend
        .invoke_handler(tauri::generate_handler![nfc_reader::nfc_feedback, exit_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
