/**
 * File System Interface
 * 
 * Defines the contract for file system operations that work
 * in both browser and Tauri environments.
 */
export interface FileSystemInterface {
  /**
   * Opens a file dialog and returns the selected file data, name, and path (if available).
   * Returns null if the user cancels the dialog.
   * Path will be null in browser environment, and a string path in Tauri environment.
   */
  openFile(): Promise<{ data: Uint8Array; name: string; path: string | null } | null>;

  /**
   * Saves a file with the given data and name.
   * In browser, this will trigger a download.
   * In Tauri, this will use the native save dialog.
   */
  saveFile(data: Uint8Array, name: string): Promise<void>;

  /**
   * Reads a file from the given path.
   * In browser, this requires a File object or blob URL.
   * In Tauri, this reads from the file system.
   */
  readFile(path: string): Promise<Uint8Array>;

  /**
   * Saves multiple files as a ZIP archive.
   * In browser, this will trigger a download.
   * In Tauri, this will use the native save dialog.
   */
  saveMultipleFilesAsZip(
    files: Array<{ data: Uint8Array; name: string }>,
    zipFileName: string
  ): Promise<void>;

  /**
   * Saves a text file.
   * In browser, this will trigger a download.
   * In Tauri, this will use the native save dialog.
   */
  saveTextFile(text: string, fileName: string): Promise<void>;
}








