/**
 * RedlinePopup — expandable comment popup attached to strikethrough annotations.
 * Rendered via portal to document.body so it's never clipped by page containers.
 * Positions itself relative to the anchor strikethrough element using screen coordinates.
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, ChevronDown, ChevronUp } from "lucide-react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import type { Annotation } from "@/core/pdf/types";

const SEVERITY_STYLES: Record<string, { bg: string; text: string }> = {
  critical: { bg: "bg-red-100", text: "text-red-800" },
  high: { bg: "bg-orange-100", text: "text-orange-800" },
  medium: { bg: "bg-amber-100", text: "text-amber-800" },
  low: { bg: "bg-blue-100", text: "text-blue-800" },
  info: { bg: "bg-gray-100", text: "text-gray-600" },
};

const POPUP_WIDTH = 340;

interface RedlinePopupPortalProps {
  annotation: Annotation;
  /** The annotation ID — used to find the anchor element via data-annotation-id. */
  anchorRef: string;
  onClose: () => void;
}

/**
 * Portal-based popup that finds its anchor element in the DOM and positions
 * itself in fixed screen coordinates, above or below depending on space.
 */
export function RedlinePopupPortal({ annotation, anchorRef, onClose }: RedlinePopupPortalProps) {
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Calculate position from the anchor element
  useEffect(() => {
    const anchor = document.querySelector(`[data-annotation-id="${anchorRef}"]`);
    if (!anchor) return;

    const updatePos = () => {
      const rect = anchor.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      // Prefer below, flip above if not enough space
      const above = spaceBelow < 250 && spaceAbove > spaceBelow;

      setPos({
        top: above ? rect.top : rect.bottom + 6,
        left: Math.min(rect.left, window.innerWidth - POPUP_WIDTH - 16),
        above,
      });
    };

    updatePos();

    // Update on scroll/resize so popup stays anchored
    const scrollContainer = anchor.closest("[class*='overflow']") || window;
    const handleUpdate = () => requestAnimationFrame(updatePos);
    window.addEventListener("resize", handleUpdate);
    scrollContainer.addEventListener("scroll", handleUpdate, { passive: true });
    return () => {
      window.removeEventListener("resize", handleUpdate);
      scrollContainer.removeEventListener("scroll", handleUpdate);
    };
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <RedlinePopupContent
      ref={popupRef}
      annotation={annotation}
      style={{
        position: "fixed",
        zIndex: 9999,
        left: `${pos.left}px`,
        width: `${POPUP_WIDTH}px`,
        ...(pos.above
          ? { bottom: `${window.innerHeight - pos.top + 6}px` }
          : { top: `${pos.top}px` }
        ),
      }}
      onClose={onClose}
    />,
    document.body
  );
}

/** The actual popup UI — separated so the portal wrapper handles positioning. */
import React from "react";

interface RedlinePopupContentProps {
  annotation: Annotation;
  style: React.CSSProperties;
  onClose: () => void;
}

const RedlinePopupContent = React.forwardRef<HTMLDivElement, RedlinePopupContentProps>(
  function RedlinePopupContent({ annotation, style, onClose }, ref) {
    const [expanded, setExpanded] = useState(true);
    const [editingComment, setEditingComment] = useState(false);
    const [editingSuggestion, setEditingSuggestion] = useState(false);
    const [commentText, setCommentText] = useState(annotation.commentContent || "");
    const [suggestionText, setSuggestionText] = useState(annotation.redlineSuggestion || "");

    const sev = annotation.redlineSeverity || "info";
    const styles = SEVERITY_STYLES[sev] || SEVERITY_STYLES.info;

    const saveComment = useCallback(() => {
      const doc = usePDFStore.getState().getCurrentDocument();
      if (!doc) return;
      usePDFStore.getState().updateAnnotation(doc.getId(), annotation.id, {
        commentContent: commentText,
      });
      setEditingComment(false);
    }, [annotation.id, commentText]);

    const saveSuggestion = useCallback(() => {
      const doc = usePDFStore.getState().getCurrentDocument();
      if (!doc) return;
      usePDFStore.getState().updateAnnotation(doc.getId(), annotation.id, {
        redlineSuggestion: suggestionText,
      });
      setEditingSuggestion(false);
    }, [annotation.id, suggestionText]);

    return (
      <div
        ref={ref}
        className="shadow-2xl rounded-lg border border-gray-200 bg-white"
        style={style}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200 rounded-t-lg">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${styles.bg} ${styles.text}`}>
              {sev}
            </span>
            {annotation.redlineCategory && (
              <span className="text-xs text-gray-500 truncate">{annotation.redlineCategory}</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setExpanded(!expanded)} className="p-0.5 text-gray-400 hover:text-gray-600 rounded">
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <button onClick={onClose} className="p-0.5 text-gray-400 hover:text-gray-600 rounded">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {expanded && (
          <div className="px-3 py-2 space-y-2 overflow-y-auto rounded-b-lg" style={{ maxHeight: "320px" }}>
            {/* Comment — editable */}
            <div>
              <p className="text-[10px] text-gray-400 font-medium mb-1">Comment</p>
              {editingComment ? (
                <textarea
                  autoFocus
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onBlur={saveComment}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setCommentText(annotation.commentContent || ""); setEditingComment(false); }
                  }}
                  className="w-full text-xs text-gray-700 leading-relaxed border border-gray-300 rounded px-2 py-1.5 resize-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  rows={3}
                  placeholder="Add a comment..."
                />
              ) : (
                <div
                  onClick={() => setEditingComment(true)}
                  className="text-xs text-gray-700 leading-relaxed cursor-text min-h-[28px] rounded px-1 py-0.5 hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-colors"
                >
                  {commentText || <span className="text-gray-400 italic">Click to add comment...</span>}
                </div>
              )}
            </div>

            {/* Suggested replacement — editable */}
            <div className="rounded bg-emerald-50 border border-emerald-200 px-2.5 py-2">
              <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide mb-1">Suggested Replacement</p>
              {editingSuggestion ? (
                <textarea
                  autoFocus
                  value={suggestionText}
                  onChange={(e) => setSuggestionText(e.target.value)}
                  onBlur={saveSuggestion}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { setSuggestionText(annotation.redlineSuggestion || ""); setEditingSuggestion(false); }
                  }}
                  className="w-full text-xs text-emerald-900 leading-relaxed bg-white border border-emerald-300 rounded px-2 py-1.5 resize-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  rows={4}
                  placeholder="Add suggested replacement text..."
                />
              ) : (
                <div
                  onClick={() => setEditingSuggestion(true)}
                  className="text-xs text-emerald-900 leading-relaxed cursor-text min-h-[28px] rounded px-1 py-0.5 hover:bg-emerald-100 border border-transparent hover:border-emerald-300 transition-colors"
                >
                  {suggestionText || <span className="text-emerald-600 italic">Click to add suggestion...</span>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
);
