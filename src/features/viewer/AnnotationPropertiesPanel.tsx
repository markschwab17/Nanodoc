/**
 * Annotation Properties Panel
 *
 * A compact floating panel that displays read-only properties of the
 * currently selected annotation: position, size, type, and page number.
 * Shown only when an annotation is selected (via custom events or store).
 */

import { useState, useEffect, useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
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

  // Clear selection when page changes
  useEffect(() => {
    setSelectedAnnotationId(null);
  }, [currentPage]);

  if (!annotation) return null;

  const x = Math.round(annotation.x);
  const y = Math.round(annotation.y);
  const w = annotation.width != null ? Math.round(annotation.width) : null;
  const h = annotation.height != null ? Math.round(annotation.height) : null;

  return (
    <div className="absolute bottom-14 right-3 z-30 max-w-xs bg-popover border shadow-sm rounded-md text-xs select-none">
      {/* Header */}
      <button
        className="flex w-full items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-accent/50 rounded-t-md transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="font-medium text-foreground">
          {annotationTypeLabel(annotation.type)} Properties
        </span>
        {collapsed ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        )}
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="px-2.5 pb-2 pt-0.5 space-y-1 text-muted-foreground">
          <div className="flex justify-between">
            <span>Type</span>
            <span className="text-foreground">{annotationTypeLabel(annotation.type)}</span>
          </div>
          <div className="flex justify-between">
            <span>Page</span>
            <span className="text-foreground">{annotation.pageNumber + 1}</span>
          </div>
          <div className="flex justify-between">
            <span>Position</span>
            <span className="text-foreground">
              {x}, {y}
            </span>
          </div>
          {w != null && h != null && (
            <div className="flex justify-between">
              <span>Size</span>
              <span className="text-foreground">
                {w} &times; {h}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
