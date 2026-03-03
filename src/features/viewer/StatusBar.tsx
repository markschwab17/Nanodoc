/**
 * Status Bar Component
 *
 * Thin bar at the bottom of the viewer showing file name, file size,
 * zoom percentage, active tool, and optional mouse coordinates.
 */

import { useMemo } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore, type ToolType } from "@/shared/stores/uiStore";

/** Human-readable labels for each tool type. */
const TOOL_LABELS: Record<ToolType, string> = {
  select: "Select",
  text: "Text",
  highlight: "Highlight",
  note: "Note",
  pan: "Pan",
  callout: "Callout",
  redact: "Redact",
  selectText: "Select Text",
  form: "Form",
  draw: "Draw",
  shape: "Shape",
  stamp: "Stamp",
};

/** Format bytes into a human-readable string. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface StatusBarProps {
  /** Mouse position in PDF points (optional). */
  mousePosition?: { x: number; y: number } | null;
}

export function StatusBar({ mousePosition }: StatusBarProps) {
  const getCurrentDocument = usePDFStore((s) => s.getCurrentDocument);
  const getDocumentPath = usePDFStore((s) => s.getDocumentPath);
  const currentDocumentId = usePDFStore((s) => s.currentDocumentId);
  const currentPage = usePDFStore((s) => s.currentPage);
  const zoomLevel = useUIStore((s) => s.zoomLevel);
  const activeTool = useUIStore((s) => s.activeTool);

  const doc = getCurrentDocument();

  const fileName = useMemo(() => {
    if (!currentDocumentId) return "Untitled";
    const path = getDocumentPath(currentDocumentId);
    if (path) {
      // Extract file name from path (handle both / and \)
      const parts = path.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1] || "Untitled";
    }
    return doc?.getMetadata().name || "Untitled";
  }, [currentDocumentId, getDocumentPath, doc]);

  const fileSize = useMemo(() => {
    if (!doc) return null;
    const size = doc.getMetadata().fileSize;
    return size > 0 ? formatFileSize(size) : null;
  }, [doc]);

  const pageCount = doc?.getMetadata().pageCount ?? 0;
  const zoomPercent = Math.round(zoomLevel * 100);
  const toolLabel = TOOL_LABELS[activeTool] ?? activeTool;

  return (
    <div className="h-6 flex items-center gap-3 px-3 text-xs bg-muted border-t select-none shrink-0 text-muted-foreground">
      {/* File name */}
      <span className="truncate max-w-[200px]" title={fileName}>
        {fileName}
      </span>

      {/* File size */}
      {fileSize && (
        <>
          <span className="text-border">|</span>
          <span>{fileSize}</span>
        </>
      )}

      {/* Page indicator */}
      {pageCount > 0 && (
        <>
          <span className="text-border">|</span>
          <span>
            Page {currentPage + 1} / {pageCount}
          </span>
        </>
      )}

      {/* Spacer */}
      <span className="flex-1" />

      {/* Mouse coordinates */}
      {mousePosition && (
        <>
          <span>
            X: {mousePosition.x.toFixed(1)} Y: {mousePosition.y.toFixed(1)} pt
          </span>
          <span className="text-border">|</span>
        </>
      )}

      {/* Active tool */}
      <span>{toolLabel}</span>
      <span className="text-border">|</span>

      {/* Zoom */}
      <span>{zoomPercent}%</span>
    </div>
  );
}
