//! File watcher: emits a Tauri event when a watched PDF changes on disk.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Holds active file watchers.
pub struct WatcherState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

/// Start watching a file for modifications.
/// Emits `file-changed` event with the file path when the file is modified.
#[tauri::command]
pub fn watch_file(
    file_path: String,
    app: AppHandle,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {file_path}"));
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher =
        RecommendedWatcher::new(tx, Config::default()).map_err(|e| format!("Watcher error: {e}"))?;

    watcher
        .watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Watch error: {e}"))?;

    let watched_path = file_path.clone();
    let app_clone = app.clone();

    // Spawn a thread to listen for events
    std::thread::spawn(move || {
        for res in rx {
            match res {
                Ok(event) => {
                    if matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_)
                    ) {
                        let _ = app_clone.emit("file-changed", &watched_path);
                    }
                }
                Err(e) => {
                    eprintln!("File watch error: {e}");
                    break;
                }
            }
        }
    });

    let mut watchers = state
        .watchers
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    watchers.insert(file_path, watcher);

    Ok(())
}

/// Stop watching a file.
#[tauri::command]
pub fn unwatch_file(
    file_path: String,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    watchers.remove(&file_path);
    Ok(())
}
