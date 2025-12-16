// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
async fn open_file_path(_file_path: String) -> Result<(), String> {
    // This command can be called from the frontend
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|_app| {
            // File drop handling can be added later if needed
            // Tauri v2 handles file drops differently - may need window-level event listeners
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}








