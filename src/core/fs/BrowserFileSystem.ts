import type { FileSystemInterface } from "./FileSystemInterface";

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
    // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
    const arrayBuffer = new ArrayBuffer(data.length);
    const view = new Uint8Array(arrayBuffer);
    view.set(data);
    const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
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
}

