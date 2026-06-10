import type { FileSystemInterface } from "./FileSystemInterface";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile as tauriReadFile, writeFile as tauriWriteFile, rename as tauriRename, remove as tauriRemove } from "@tauri-apps/plugin-fs";

/**
 * Atomic file write: write to a temp file in the same directory, then rename
 * over the target. If the process dies mid-write the original file is intact
 * (only the .tmp file is partial). rename() on the same filesystem is atomic.
 */
export async function atomicWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.nanodoc-tmp`;
  try {
    await tauriWriteFile(tmpPath, data);
    await tauriRename(tmpPath, filePath);
  } catch (error) {
    // Best-effort cleanup of the temp file; the original is untouched.
    try {
      await tauriRemove(tmpPath);
    } catch {
      // temp file may not exist
    }
    throw error;
  }
}

/**
 * Tauri File System Implementation
 * 
 * Uses Tauri plugins for native file system operations.
 */
export class TauriFileSystem implements FileSystemInterface {
  /**
   * Opens a native file dialog and returns the selected file data, name, and path.
   * Returns null if the user cancels the dialog.
   */
  async openFile(): Promise<{ data: Uint8Array; name: string; path: string } | null> {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "PDF",
            extensions: ["pdf"],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });

      if (!selected || Array.isArray(selected)) {
        return null;
      }

      // Tauri v2 dialog returns a string path when single file is selected
      const filePath = selected as string;
      const fileData = await tauriReadFile(filePath);
      const fileName = filePath.split(/[/\\]/).pop() || "file";

      return {
        data: fileData,
        name: fileName,
        path: filePath,
      };
    } catch (error) {
      console.error("Error opening file:", error);
      return null;
    }
  }

  /**
   * Opens the save dialog and returns the chosen path without writing.
   * Use for Save As when the path is needed for sidecar files before the main file is written.
   * `defaultDir` (e.g. the source file's folder) takes precedence over Desktop.
   */
  async getSavePath(name: string, defaultDir?: string | null): Promise<string | null> {
    try {
      const dir = defaultDir || (await this.getDesktopPath());
      const filePath = await save({
        defaultPath: `${dir}/${name}`,
        filters: [
          { name: "PDF", extensions: ["pdf"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!filePath) return null;
      // Enforce .pdf so a typed name without extension still produces a
      // file other applications recognize.
      return /\.pdf$/i.test(filePath) ? filePath : `${filePath}.pdf`;
    } catch (error) {
      console.error("Error getting save path:", error);
      return null;
    }
  }

  /**
   * Saves a file using the native save dialog.
   * Defaults to desktop directory.
   * Returns the chosen file path so callers can write sidecar files (e.g. .ai.json).
   */
  async saveFile(data: Uint8Array, name: string): Promise<string | void> {
    try {
      const desktopPath = await this.getDesktopPath();
      const filePath = await save({
        defaultPath: `${desktopPath}/${name}`,
        filters: [
          {
            name: "PDF",
            extensions: ["pdf"],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });

      if (!filePath) {
        throw new Error("No file path selected");
      }

      const finalPath = /\.pdf$/i.test(filePath) ? filePath : `${filePath}.pdf`;
      await atomicWriteFile(finalPath, data);
      return finalPath;
    } catch (error) {
      console.error("Error saving file:", error);
      throw error;
    }
  }

  /**
   * Reads a file from the given file system path.
   */
  async readFile(path: string): Promise<Uint8Array> {
    try {
      return await tauriReadFile(path);
    } catch (error) {
      console.error("Error reading file:", error);
      throw error;
    }
  }

  /**
   * Gets the desktop directory path via Tauri's path API.
   *
   * The previous implementation read process.env.HOME/USERPROFILE, which do
   * NOT exist in the Tauri webview — every save dialog defaulted to a literal
   * "~/Desktop" string that nothing expands. Falls back to the home directory
   * if the desktop dir cannot be determined.
   */
  async getDesktopPath(): Promise<string> {
    try {
      const { desktopDir } = await import("@tauri-apps/api/path");
      return await desktopDir();
    } catch {
      // e.g. headless or sandboxed environments without a desktop dir
    }
    try {
      const { homeDir } = await import("@tauri-apps/api/path");
      return await homeDir();
    } catch (error) {
      console.error("Error getting desktop path:", error);
      return ".";
    }
  }

  /**
   * Saves a file to a specific path (atomic: temp file + rename, so a crash
   * mid-write never corrupts the existing file).
   */
  async saveFileToPath(data: Uint8Array, filePath: string): Promise<void> {
    try {
      await atomicWriteFile(filePath, data);
    } catch (error) {
      console.error("Error saving file to path:", error);
      throw error;
    }
  }

  /**
   * Saves a file directly to the desktop.
   */
  async saveFileToDesktop(data: Uint8Array, name: string): Promise<string> {
    try {
      const desktopPath = await this.getDesktopPath();
      const filePath = `${desktopPath}/${name}`;
      await this.saveFileToPath(data, filePath);
      return filePath;
    } catch (error) {
      console.error("Error saving file to desktop:", error);
      throw error;
    }
  }

  /**
   * Opens a file dialog with desktop as default directory.
   */
  async saveFileAs(data: Uint8Array, name: string): Promise<void> {
    try {
      const desktopPath = await this.getDesktopPath();
      const filePath = await save({
        defaultPath: `${desktopPath}/${name}`,
        filters: [
          {
            name: "PDF",
            extensions: ["pdf"],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });

      if (!filePath) {
        throw new Error("No file path selected");
      }

      const finalPath = /\.pdf$/i.test(filePath) ? filePath : `${filePath}.pdf`;
      await atomicWriteFile(finalPath, data);
    } catch (error) {
      console.error("Error saving file:", error);
      throw error;
    }
  }

  /**
   * Saves multiple files as a ZIP archive using the native save dialog.
   */
  async saveMultipleFilesAsZip(
    files: Array<{ data: Uint8Array; name: string }>,
    zipFileName: string
  ): Promise<void> {
    try {
      // Create ZIP file using JSZip (loaded on demand — only needed for ZIP export)
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      
      // Add all files to the ZIP
      for (const file of files) {
        zip.file(file.name, file.data);
      }
      
      // Generate ZIP file as Uint8Array
      const zipData = await zip.generateAsync({ type: "uint8array" });
      
      // Get desktop path for default location
      const desktopPath = await this.getDesktopPath();
      const finalZipName = zipFileName.endsWith(".zip") ? zipFileName : `${zipFileName}.zip`;
      
      // Show save dialog
      const filePath = await save({
        defaultPath: `${desktopPath}/${finalZipName}`,
        filters: [
          {
            name: "ZIP Archive",
            extensions: ["zip"],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });

      if (!filePath) {
        throw new Error("No file path selected");
      }

      // Write ZIP file
      await tauriWriteFile(filePath, zipData);
    } catch (error) {
      console.error("Error saving ZIP file:", error);
      throw error;
    }
  }

  /**
   * Saves a text file using the native save dialog.
   */
  async saveTextFile(text: string, fileName: string): Promise<void> {
    try {
      // Ensure the filename has .txt extension
      const finalFileName = fileName.endsWith(".txt") ? fileName : `${fileName}.txt`;
      
      // Get desktop path for default location
      const desktopPath = await this.getDesktopPath();
      
      // Show save dialog
      const filePath = await save({
        defaultPath: `${desktopPath}/${finalFileName}`,
        filters: [
          {
            name: "Text File",
            extensions: ["txt"],
          },
          {
            name: "All Files",
            extensions: ["*"],
          },
        ],
      });

      if (!filePath) {
        throw new Error("No file path selected");
      }

      // Convert text to Uint8Array (UTF-8 encoding)
      const encoder = new TextEncoder();
      const textData = encoder.encode(text);
      
      // Write text file
      await tauriWriteFile(filePath, textData);
    } catch (error) {
      console.error("Error saving text file:", error);
      throw error;
    }
  }
}

