// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Handle file opening from command line arguments
            // When a file is opened via file association, Tauri passes it as a command-line argument
            let args: Vec<String> = std::env::args().collect();

            if args.len() > 1 {
                let raw_file_path = &args[1];

                // Only process if it looks like a file path (not a flag)
                if !raw_file_path.starts_with('-') {
                    // Clean the path - remove surrounding quotes if present
                    let file_path = raw_file_path.trim_matches('"').trim_matches('\'');

                    // Check if it ends with .pdf (case insensitive) or if the path exists
                    let is_pdf = file_path.to_lowercase().ends_with(".pdf");
                    let path_exists = std::path::Path::new(file_path).exists();

                    if is_pdf || path_exists {
                        let app_handle = app.handle().clone();
                        let file_path_clone = file_path.to_string();

                        // Use on_window_event to emit once the window is ready,
                        // instead of a hard-coded 1.5s sleep
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let fp = file_path_clone.clone();
                            // Try emitting immediately since window exists at setup time
                            std::thread::spawn(move || {
                                // Small yield to let the webview finish initialization
                                std::thread::sleep(std::time::Duration::from_millis(200));
                                if let Err(e) = window.emit("open-pdf-file", &fp) {
                                    eprintln!("Error emitting event: {:?}", e);
                                }
                            });
                        } else {
                            // Window not yet created - use a retry loop with short intervals
                            std::thread::spawn(move || {
                                for _ in 0..20 {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    if let Some(window) = app_handle.get_webview_window("main") {
                                        let _ = window.emit("open-pdf-file", &file_path_clone);
                                        break;
                                    }
                                }
                            });
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
