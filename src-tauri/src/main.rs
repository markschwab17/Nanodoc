// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Handle file opening from command line arguments
            // When a file is opened via file association, Tauri passes it as a command-line argument
            let args: Vec<String> = std::env::args().collect();
            eprintln!("Command line args: {:?}", args);
            
            if args.len() > 1 {
                let file_path = &args[1];
                eprintln!("Processing file path: {}", file_path);
                
                // Only process if it looks like a file path (not a flag)
                // Check if it ends with .pdf or if the path exists
                if !file_path.starts_with('-') {
                    let is_pdf = file_path.ends_with(".pdf");
                    let path_exists = std::path::Path::new(file_path).exists();
                    
                    eprintln!("Is PDF: {}, Path exists: {}", is_pdf, path_exists);
                    
                    if is_pdf || path_exists {
                        // Emit event to frontend after a delay to ensure window is ready
                        let app_handle = app.handle().clone();
                        let file_path_clone = file_path.clone();
                        std::thread::spawn(move || {
                            // Wait longer to ensure window is fully ready
                            std::thread::sleep(std::time::Duration::from_millis(1000));
                            eprintln!("Attempting to emit event for file: {}", file_path_clone);
                            if let Some(window) = app_handle.get_webview_window("main") {
                                match window.emit("open-pdf-file", &file_path_clone) {
                                    Ok(_) => eprintln!("Successfully emitted open-pdf-file event"),
                                    Err(e) => eprintln!("Error emitting event: {:?}", e),
                                }
                            } else {
                                eprintln!("Window 'main' not found");
                            }
                        });
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}








