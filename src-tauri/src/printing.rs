//! Native printing support.
//!
//! On macOS, delegates to `lpr` which shows the system print dialog.
//! On Windows, uses `ShellExecuteW` with the "print" verb.

use std::path::Path;

/// Print a PDF file using the OS native print pipeline.
#[tauri::command]
pub fn print_pdf(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {file_path}"));
    }

    #[cfg(target_os = "macos")]
    {
        // `lpr` invokes the CUPS subsystem which shows the native print dialog
        // when called from a GUI context. For silent printing, use `lpr` directly.
        // For dialog, we use `open -a Preview --print` which opens the print dialog.
        let status = std::process::Command::new("open")
            .args(["-a", "Preview", "--args", "-print", &file_path])
            .status()
            .map_err(|e| format!("Failed to launch print: {e}"))?;

        if !status.success() {
            // Fallback: try lpr directly
            let lpr_status = std::process::Command::new("lpr")
                .arg(&file_path)
                .status()
                .map_err(|e| format!("Failed to print via lpr: {e}"))?;
            if !lpr_status.success() {
                return Err("Print command failed".to_string());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "", "/print", &file_path])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Failed to print: {e}"))?;
        if !status.success() {
            return Err("Print command failed".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("lpr")
            .arg(&file_path)
            .status()
            .map_err(|e| format!("Failed to print: {e}"))?;
        if !status.success() {
            return Err("Print command failed".to_string());
        }
    }

    Ok(())
}
