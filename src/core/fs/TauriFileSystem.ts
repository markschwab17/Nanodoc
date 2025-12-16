import type { FileSystemInterface } from "./FileSystemInterface";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile as tauriReadFile, writeFile as tauriWriteFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import JSZip from "jszip";

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
   * Saves a file using the native save dialog.
   * Defaults to desktop directory.
   */
  async saveFile(data: Uint8Array, name: string): Promise<void> {
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

      await tauriWriteFile(filePath, data);
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
   * Gets the desktop directory path.
   * Falls back to home directory if desktop cannot be determined.
   */
  async getDesktopPath(): Promise<string> {
    try {
      // For Tauri 2.0, we'll construct the path based on platform
      const osPlatform = await platform();
      
      // Platform can be: "macos", "ios", "windows", "linux", "android", etc.
      if (osPlatform === "macos" || osPlatform === "linux") {
        // Use environment variable or default
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        return `${homeDir}/Desktop`;
      } else if (osPlatform === "windows") {
        const homeDir = process.env.USERPROFILE || process.env.HOMEPATH || "~";
        return `${homeDir}\\Desktop`;
      }
      
      // Fallback to home directory
      const homeDir = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "~";
      return homeDir;
    } catch (error) {
      console.error("Error getting desktop path:", error);
      // Fallback to current directory or home
      return process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || ".";
    }
  }

  /**
   * Saves a file to a specific path.
   */
  async saveFileToPath(data: Uint8Array, filePath: string): Promise<void> {
    try {
      await tauriWriteFile(filePath, data);
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

      await tauriWriteFile(filePath, data);
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
      // Create ZIP file using JSZip
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

