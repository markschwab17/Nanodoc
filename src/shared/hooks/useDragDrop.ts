/**
 * useDragDrop Hook
 * 
 * Handles drag and drop file opening with file system abstraction.
 */

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { usePDF } from "./usePDF";

export function useDragDrop() {
  const { loadPDF, currentDocument } = usePDF();

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      // Only handle drops when no PDF is loaded
      for (const file of acceptedFiles) {
        if (file.type === "application/pdf" || file.name.endsWith(".pdf")) {
          try {
            const arrayBuffer = await file.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);
            
            // Initialize mupdf
            const mupdfModule = await import("mupdf");
            
            await loadPDF(data, file.name, mupdfModule.default, null);
          } catch (error) {
            console.error("Error loading dropped file:", error);
          }
        }
      }
    },
    [loadPDF]
  );

  const dropzoneConfig = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
    },
    noClick: true,
    noKeyboard: true,
    // Disable dropzone when PDF is loaded to allow page insertion
    disabled: !!currentDocument,
  });

  const { getRootProps, getInputProps, isDragActive } = dropzoneConfig;

  // When PDF is loaded, return empty props so dropzone doesn't interfere
  if (currentDocument) {
    return {
      getRootProps: () => ({}),
      getInputProps: () => ({}),
      isDragActive: false,
    };
  }

  return {
    getRootProps,
    getInputProps,
    isDragActive,
  };
}

