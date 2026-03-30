/**
 * Redline Panel — collapsible sidebar listing all contract redline annotations.
 *
 * Filters annotations from pdfStore where type === 'strikethrough' || type === 'comment',
 * sorted by page then position. Clickable severity chips to filter by risk level.
 */

import { useMemo, useState } from "react";
import { X, Check, XCircle, FileText, Plus, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useRedlineStore } from "@/shared/stores/redlineStore";
import { useUIStore } from "@/shared/stores/uiStore";
import type { Annotation } from "@/core/pdf/types";

const PANEL_WIDTH = 384;

type SeverityKey = "critical" | "high" | "medium" | "low" | "info";

const SEVERITY_ORDER: SeverityKey[] = ["critical", "high", "medium", "low", "info"];

/** Normalize severity to lowercase and map any non-standard values. */
function normalizeSeverity(raw: string | undefined | null): SeverityKey {
  if (!raw) return "info";
  const lower = raw.toLowerCase().trim();
  if (lower === "critical" || lower === "danger") return "critical";
  if (lower === "high" || lower === "warning") return "high";
  if (lower === "medium" || lower === "moderate" || lower === "caution") return "medium";
  if (lower === "low") return "low";
  if (lower === "info" || lower === "informational") return "info";
  return "medium"; // default fallback for unknown values
}

const SEVERITY_COLORS: Record<string, { border: string; bg: string; bgActive: string; text: string; ring: string }> = {
  critical: { border: "border-l-red-500", bg: "bg-red-50", bgActive: "bg-red-100", text: "text-red-700", ring: "ring-red-300" },
  high:     { border: "border-l-orange-500", bg: "bg-orange-50", bgActive: "bg-orange-100", text: "text-orange-700", ring: "ring-orange-300" },
  medium:   { border: "border-l-amber-500", bg: "bg-amber-50", bgActive: "bg-amber-100", text: "text-amber-700", ring: "ring-amber-300" },
  low:      { border: "border-l-blue-500", bg: "bg-blue-50", bgActive: "bg-blue-100", text: "text-blue-700", ring: "ring-blue-300" },
  info:     { border: "border-l-gray-400", bg: "bg-gray-50", bgActive: "bg-gray-200", text: "text-gray-600", ring: "ring-gray-300" },
};

export function RedlinePanel() {
  const panelOpen = useRedlineStore((s) => s.panelOpen);
  const setPanelOpen = useRedlineStore((s) => s.setPanelOpen);
  const focusedRedlineId = useRedlineStore((s) => s.focusedRedlineId);
  const setFocusedRedlineId = useRedlineStore((s) => s.setFocusedRedlineId);
  const riskScore = useRedlineStore((s) => s.riskScore);
  const { getCurrentDocument, getAnnotations, removeAnnotation, updateAnnotation } = usePDFStore();
  const setActiveTool = useUIStore((s) => s.setActiveTool);

  const [activeFilter, setActiveFilter] = useState<SeverityKey | "all">("all");
  const [showTooltip, setShowTooltip] = useState(true);

  const currentDocument = getCurrentDocument();
  const documentId = currentDocument?.getId() ?? null;
  const allAnnotations = documentId ? getAnnotations(documentId) : [];

  // All redline annotations
  const redlineAnnotations = useMemo(() => {
    return allAnnotations
      .filter((a: Annotation) => a.type === "strikethrough" || a.type === "comment")
      .sort((a: Annotation, b: Annotation) => {
        if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
        return (b.y || 0) - (a.y || 0);
      });
  }, [allAnnotations]);

  // Severity counts (normalized)
  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of redlineAnnotations) {
      const sev = normalizeSeverity(a.redlineSeverity);
      counts[sev] = (counts[sev] || 0) + 1;
    }
    return counts;
  }, [redlineAnnotations]);

  // Filtered annotations (using normalized severity)
  const filteredAnnotations = useMemo(() => {
    if (activeFilter === "all") return redlineAnnotations;
    return redlineAnnotations.filter((a) => normalizeSeverity(a.redlineSeverity) === activeFilter);
  }, [redlineAnnotations, activeFilter]);

  const handleScrollTo = (annot: Annotation) => {
    setFocusedRedlineId(annot.id);
    const quoteText = annot.selectedText?.replace(/\s+/g, " ").trim().substring(0, 80) || undefined;
    // If the annotation has resolved quads, compute a bbox to help the viewer scroll precisely
    let bbox: number[] | undefined;
    if (annot.quads && annot.quads.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of annot.quads) {
        for (let i = 0; i < q.length; i += 2) {
          const px = q[i], py = q[i + 1];
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
      if (isFinite(minX)) bbox = [minX, minY, maxX, maxY];
    }
    window.dispatchEvent(new CustomEvent("scroll-to-spec", {
      detail: { page: annot.pageNumber, quote: quoteText, bbox }
    }));
  };

  const handleDismiss = (annot: Annotation) => {
    if (!documentId) return;
    removeAnnotation(documentId, annot.id);
  };

  const handleAccept = (annot: Annotation) => {
    if (!documentId) return;
    updateAnnotation(documentId, annot.id, { redlineAccepted: true });
  };

  const handleUnaccept = (annot: Annotation) => {
    if (!documentId) return;
    updateAnnotation(documentId, annot.id, { redlineAccepted: false });
  };

  if (!panelOpen) return null;

  return (
    <div
      className="flex flex-col h-full border-r bg-background overflow-hidden shrink-0"
      style={{ width: `${PANEL_WIDTH}px` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-red-500" />
          <h2 className="text-sm font-semibold">Contract Redlines</h2>
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
            {redlineAnnotations.length}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPanelOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter chips — clickable severity badges */}
      <div className="px-3 py-2.5 border-b bg-muted/20">
        {/* Risk score */}
        {riskScore !== null && (
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Risk Score</span>
            <span className={`text-sm font-bold ${riskScore <= 3 ? "text-emerald-600" : riskScore <= 6 ? "text-amber-600" : "text-red-600"}`}>
              {riskScore}/10
            </span>
          </div>
        )}
        {/* Filter row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* All chip */}
          <button
            onClick={() => setActiveFilter("all")}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all ${
              activeFilter === "all"
                ? "bg-gray-900 text-white shadow-sm"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All {redlineAnnotations.length}
          </button>
          {/* Severity chips — only show if count > 0 */}
          {SEVERITY_ORDER.map((sev) => {
            const count = severityCounts[sev] || 0;
            if (count === 0) return null;
            const style = SEVERITY_COLORS[sev];
            const isActive = activeFilter === sev;
            return (
              <button
                key={sev}
                onClick={() => setActiveFilter(isActive ? "all" : sev)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all ${
                  isActive
                    ? `${style.bgActive} ${style.text} ring-1 ${style.ring} shadow-sm`
                    : `${style.bg} ${style.text} hover:${style.bgActive}`
                }`}
              >
                {count} {sev}
              </button>
            );
          })}
        </div>
      </div>

      {/* Onboarding tooltip */}
      {showTooltip && (
        <div className="mx-3 mt-3 mb-1 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 p-3 relative">
          <button
            onClick={() => setShowTooltip(false)}
            className="absolute top-1.5 right-1.5 text-blue-400 hover:text-blue-600 dark:text-blue-500"
          >
            <X className="w-3.5 h-3.5" />
          </button>
          <div className="flex gap-2">
            <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
            <div className="text-xs text-blue-800 dark:text-blue-300 space-y-1 pr-3">
              <p className="font-semibold">AI-Generated Redline Drafts</p>
              <p>These are suggested redlines based on your contract analysis. Review each one:</p>
              <p><span className="font-medium text-emerald-700 dark:text-emerald-400">Accept</span> keeps the redline as a valid markup. <span className="font-medium text-red-700 dark:text-red-400">Dismiss</span> removes it.</p>
              <p>You can also add your own redlines using the button below. When you save, the redlined version will be available in your <span className="font-medium">Document Viewer</span> under the <span className="font-medium">Contracts</span> folder.</p>
            </div>
          </div>
        </div>
      )}

      {/* Add your own redline button */}
      <div className="px-3 pt-2 pb-1">
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7 text-xs gap-1.5"
          onClick={() => {
            setActiveTool("strikethrough");
            setPanelOpen(false);
          }}
        >
          <Plus className="w-3.5 h-3.5" />
          Add Your Own Redline
        </Button>
      </div>

      {/* Redline list */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {filteredAnnotations.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {activeFilter === "all" ? "No redline annotations" : `No ${activeFilter} items`}
            </p>
          )}
          {filteredAnnotations.map((annot: Annotation) => {
            const sev = normalizeSeverity(annot.redlineSeverity);
            const style = SEVERITY_COLORS[sev];
            const isFocused = focusedRedlineId === annot.id;

            return (
              <div
                key={annot.id}
                className={`rounded-lg border bg-card ${annot.redlineAccepted ? "border-l-emerald-500" : style.border} border-l-4 p-3 cursor-pointer transition-all ${
                  annot.redlineAccepted ? "bg-emerald-50/50 opacity-75" : ""
                } ${isFocused ? "ring-2 ring-blue-400 ring-offset-1" : "hover:bg-muted/50"}`}
                onClick={() => handleScrollTo(annot)}
              >
                {/* Header row */}
                <div className="flex items-center justify-between gap-1 mb-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground">p.{annot.pageNumber + 1}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${style.bgActive} ${style.text}`}>
                      {sev}
                    </span>
                    {annot.redlineCategory && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[140px]">{annot.redlineCategory}</span>
                    )}
                  </div>
                </div>

                {/* Struck-through original text */}
                {annot.selectedText && (
                  <p className="text-xs text-muted-foreground line-through line-clamp-2 mt-1">
                    {annot.selectedText}
                  </p>
                )}

                {/* Comment / suggestion */}
                {annot.commentContent && (
                  <p className="text-xs text-foreground mt-1.5 line-clamp-3">{annot.commentContent}</p>
                )}

                {/* Suggested replacement */}
                {annot.redlineSuggestion && (
                  <div className="mt-1.5 rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 px-2 py-1">
                    <p className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase">Suggested:</p>
                    <p className="text-xs text-emerald-900 dark:text-emerald-300 line-clamp-3">{annot.redlineSuggestion}</p>
                  </div>
                )}

                {/* Accept/Dismiss buttons */}
                <div className="flex items-center gap-2 mt-2">
                  {annot.redlineAccepted ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-emerald-700 bg-emerald-100 hover:bg-emerald-50"
                      onClick={(e) => { e.stopPropagation(); handleUnaccept(annot); }}
                    >
                      <Check className="w-3 h-3 mr-1" />
                      Accepted
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                      onClick={(e) => { e.stopPropagation(); handleAccept(annot); }}
                    >
                      <Check className="w-3 h-3 mr-1" />
                      Accept
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={(e) => { e.stopPropagation(); handleDismiss(annot); }}
                  >
                    <XCircle className="w-3 h-3 mr-1" />
                    Dismiss
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
