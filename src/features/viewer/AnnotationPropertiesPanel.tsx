/**
 * Annotation Properties Panel
 *
 * A compact floating panel that displays read-only properties of the
 * currently selected annotation: position, size, type, and page number.
 * Shown only when an annotation is selected (via custom events or store).
 */

import { useState, useEffect, useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Annotation } from "@/core/pdf/types";

/** Friendly label for each annotation type. */
function annotationTypeLabel(type: Annotation["type"]): string {
  const labels: Record<Annotation["type"], string> = {
    text: "Text",
    highlight: "Highlight",
    note: "Note",
    callout: "Callout",
    redact: "Redaction",
    image: "Image",
    formField: "Form Field",
    draw: "Drawing",
    shape: "Shape",
    stamp: "Stamp",
    signatureField: "Signature Field",
  };
  return labels[type] ?? type;
}

export function AnnotationPropertiesPanel() {
  const { currentPage, getCurrentDocument } = usePDFStore();
  const currentDocument = getCurrentDocument();

  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Resolve annotation from store
  const annotation: Annotation | null = (() => {
    if (!selectedAnnotationId || !currentDocument) return null;
    const annotations = usePDFStore.getState().getAnnotations(currentDocument.getId());
    return annotations.find((a) => a.id === selectedAnnotationId) ?? null;
  })();

  // Listen for annotation selection / deselection events
  const handleAnnotationSelected = useCallback((e: Event) => {
    const detail = (e as CustomEvent<{ annotationId?: string }>).detail;
    if (detail?.annotationId) {
      setSelectedAnnotationId(detail.annotationId);
    }
  }, []);

  const handleAnnotationDeselected = useCallback(() => {
    setSelectedAnnotationId(null);
  }, []);

  useEffect(() => {
    window.addEventListener("annotationSelected", handleAnnotationSelected);
    window.addEventListener("annotationDeselected", handleAnnotationDeselected);

    return () => {
      window.removeEventListener("annotationSelected", handleAnnotationSelected);
      window.removeEventListener("annotationDeselected", handleAnnotationDeselected);
    };
  }, [handleAnnotationSelected, handleAnnotationDeselected]);

  // Clear selection when page changes (only in single-page mode)
  const { readMode } = useUIStore();
  useEffect(() => {
    if (!readMode) setSelectedAnnotationId(null);
  }, [currentPage, readMode]);

  // Form fields use the dedicated FormFieldPropertiesPanel
  if (!annotation || annotation.type === "formField") return null;

  const x = Math.round(annotation.x);
  const y = Math.round(annotation.y);
  const w = annotation.width != null ? Math.round(annotation.width) : null;
  const h = annotation.height != null ? Math.round(annotation.height) : null;

  return (
    <div className="flex-shrink-0 border-t border-border bg-background text-xs select-none">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between px-3 py-1 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="font-medium text-foreground">
          {annotationTypeLabel(annotation.type)} Properties
        </span>
        {collapsed ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        )}
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="flex items-center gap-4 px-3 pb-1.5 text-muted-foreground">
          <div className="flex items-center gap-1">
            <span>Type:</span>
            <span className="text-foreground">{annotationTypeLabel(annotation.type)}</span>
          </div>
          <div className="flex items-center gap-1">
            <span>Page:</span>
            <span className="text-foreground">{annotation.pageNumber + 1}</span>
          </div>
          <div className="flex items-center gap-1">
            <span>Position:</span>
            <span className="text-foreground">{x}, {y}</span>
          </div>
          {w != null && h != null && (
            <div className="flex items-center gap-1">
              <span>Size:</span>
              <span className="text-foreground">{w} &times; {h}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
