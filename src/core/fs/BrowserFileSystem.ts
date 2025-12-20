import type { FileSystemInterface } from "./FileSystemInterface";
import JSZip from "jszip";

/**
 * Browser File System Implementation
 * 
 * Uses HTML Input API and File API for file operations in the browser.
 */
export class BrowserFileSystem implements FileSystemInterface {
  /**
   * Opens a file dialog using a hidden input element.
   * Returns the selected file data, name, and path (null in browser), or null if cancelled.
   */
  async openFile(): Promise<{ data: Uint8Array; name: string; path: string | null } | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.style.display = "none";

      input.addEventListener("change", async (event) => {
        const target = event.target as HTMLInputElement;
        const file = target.files?.[0];

        if (!file) {
          resolve(null);
          return;
        }

        try {
          const arrayBuffer = await file.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          resolve({ data, name: file.name, path: null });
        } catch (error) {
          console.error("Error reading file:", error);
          resolve(null);
        } finally {
          document.body.removeChild(input);
        }
      });

      input.addEventListener("cancel", () => {
        resolve(null);
        document.body.removeChild(input);
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  /**
   * Saves a file by triggering a download in the browser.
   */
  async saveFile(data: Uint8Array, name: string): Promise<void> {
    try {
      // Ensure the filename has .pdf extension
      const fileName = name.endsWith('.pdf') ? name : `${name}.pdf`;
      
      // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
      const arrayBuffer = new ArrayBuffer(data.length);
      const view = new Uint8Array(arrayBuffer);
      view.set(data);
      
      // Use application/pdf MIME type so browsers recognize it as a PDF
      const blob = new Blob([arrayBuffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.style.display = "none";

      document.body.appendChild(link);
      
      // Use a small delay to ensure the link is in the DOM before clicking
      // Some browsers require the element to be in the DOM for a moment
      await new Promise(resolve => setTimeout(resolve, 10));
      
      link.click();
      
      // Wait a bit before removing to ensure click is processed
      await new Promise(resolve => setTimeout(resolve, 100));
      document.body.removeChild(link);

      // Clean up the object URL after a short delay
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 100);
    } catch (error) {
      console.error("Error in saveFile:", error);
      throw error;
    }
  }

  /**
   * Reads a file from a File object or blob URL.
   * In browser context, this requires a File object or a blob URL.
   * For file paths, use openFile() instead.
   */
  async readFile(path: string): Promise<Uint8Array> {
    // If it's a blob URL, fetch it
    if (path.startsWith("blob:")) {
      const response = await fetch(path);
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    }

    // If it's a data URL, decode it
    if (path.startsWith("data:")) {
      const base64 = path.split(",")[1];
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    }

    throw new Error(
      "BrowserFileSystem.readFile() requires a blob URL, data URL, or File object. Use openFile() for file selection."
    );
  }

  /**
   * Saves multiple files as a ZIP archive by triggering a download in the browser.
   */
  async saveMultipleFilesAsZip(
    files: Array<{ data: Uint8Array; name: string }>,
    zipFileName: string
  ): Promise<void> {
    const zip = new JSZip();
    
    // Add all files to the ZIP
    for (const file of files) {
      zip.file(file.name, file.data);
    }
    
    // Generate ZIP file
    const zipBlob = await zip.generateAsync({ type: "blob" });
    
    // Trigger download
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = zipFileName.endsWith(".zip") ? zipFileName : `${zipFileName}.zip`;
    link.style.display = "none";
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up the object URL after a short delay
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Saves a text file by triggering a download in the browser.
   */
  async saveTextFile(text: string, fileName: string): Promise<void> {
    // Ensure the filename has .txt extension
    const finalFileName = fileName.endsWith(".txt") ? fileName : `${fileName}.txt`;
    
    // Create blob with text content
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = finalFileName;
    link.style.display = "none";
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up the object URL after a short delay
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Saves a file directly to the specified path.
   * Not available in browser environment - throws an error.
   */
  async saveFileToPath(_data: Uint8Array, _filePath: string): Promise<void> {
    throw new Error(
      "saveFileToPath is not available in browser environment. Use saveFile() instead."
    );
  }
}

