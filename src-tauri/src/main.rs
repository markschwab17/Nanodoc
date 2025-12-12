// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

#[tauri::command]
async fn open_file_path(file_path: String) -> Result<(), String> {
    // This command can be called from the frontend
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // Handle file drop events (when files are dropped on the app)
            app.listen_global("tauri://file-drop", move |event| {
                if let Some(paths) = event.payload() {
                    // Parse the paths
                    if let Ok(paths_vec) = serde_json::from_str::<Vec<String>>(paths) {
                        for path in paths_vec {
                            if path.ends_with(".pdf") {
                                app_handle.emit_all("open-pdf-file", path.clone())
                                    .unwrap_or_else(|e| eprintln!("Error emitting open-pdf-file: {}", e));
                                break; // Only open the first PDF
                            }
                        }
                    }
                }
            });

            // Handle file drop hover (optional)
            app.listen_global("tauri://file-drop-hover", |_event| {
                // Could show visual feedback
            });

            // Handle file drop cancelled (optional)
            app.listen_global("tauri://file-drop-cancelled", |_event| {
                // Clean up any visual feedback
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}






