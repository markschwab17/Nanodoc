/**
 * Floating toolbar shown when the user selects text in the PDF (CTO embed).
 * Offers: Ask AI (quick-action menu), Highlight, Copy, and — in the soils
 * split-screen context — Add to table. Replaces the old CTOSplitScreenToolbar.
 */

import { useEffect, useRef, useState } from "react";
import { Sparkles, Highlighter, Copy, ListPlus, ChevronDown } from "lucide-react";
import { useCtoTextSelectionStore } from "@/shared/stores/ctoTextSelectionStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { parseCiviltakeoffViewParams } from "@/shared/civiltakeoffViewParams";
import { hasConfiguredAPIKey } from "@/core/ai/AIService";
import { QUICK_ACTION_MODEL } from "@/core/ai/modelSelection";
import { QUICK_ACTIONS, buildQuickActionRequest } from "./askActions";

const TOOLBAR_WIDTH = 320;

export function SelectionToolbar() {
  const selection = useCtoTextSelectionStore((s) => s.selection);
  const clearSelection = useCtoTextSelectionStore((s) => s.clearSelection);
  const getCurrentDocument = usePDFStore((s) => s.getCurrentDocument);
  const showNotification = useNotificationStore((s) => s.showNotification);
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Hide the toolbar on scroll / resize / Escape so it never floats stale.
  useEffect(() => {
    if (!selection) return;
    const hide = () => clearSelection();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [selection, clearSelection]);

  useEffect(() => {
    setMenuOpen(false);
  }, [selection]);

  if (!selection || !selection.anchor) return null;

  const doc = getCurrentDocument();
  const documentId = doc?.getId() ?? null;
  const params = parseCiviltakeoffViewParams(typeof window !== "undefined" ? window.location.search : "");
  const canAskAi = hasConfiguredAPIKey();
  const showAddToTable = params.split_screen === "1";

  // Position above the cursor-release point, clamped to the viewport.
  const left = Math.max(
    8 + TOOLBAR_WIDTH / 2,
    Math.min(window.innerWidth - 8 - TOOLBAR_WIDTH / 2, selection.anchor.x),
  );
  const top = Math.max(8, selection.anchor.y - 56);

  const runQuickAction = (actionId: (typeof QUICK_ACTIONS)[number]["id"]) => {
    if (!documentId) return;
    const { question, customPrompt } = buildQuickActionRequest(actionId, {
      page: selection.page,
      quote: selection.quote,
    });
    window.dispatchEvent(
      new CustomEvent("ask-document-request", {
        detail: { documentId, question, customPrompt, model: QUICK_ACTION_MODEL },
      }),
    );
    clearSelection();
  };

  const askSomethingElse = () => {
    if (!documentId) return;
    window.dispatchEvent(
      new CustomEvent("open-question-panel", {
        detail: { documentId, pinnedSelection: { page: selection.page, quote: selection.quote } },
      }),
    );
    clearSelection();
  };

  const onHighlight = () => {
    window.dispatchEvent(new CustomEvent("highlight-selected-text"));
    // PageCanvas clears the selection store after creating the highlight.
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(selection.quote);
      showNotification("Copied", "success");
    } catch {
      showNotification("Could not copy", "error");
    }
    clearSelection();
  };

  const onAddToTable = () => {
    const targetOrigin = params.api_origin ?? "*";
    try {
      window.parent.postMessage(
        { type: "nanodoc-text-selection", page: selection.page, quote: selection.quote },
        targetOrigin,
      );
      showNotification("Sent to table", "success");
    } catch {
      showNotification("Failed to send to table", "error");
    }
    clearSelection();
  };

  return (
    <div
      ref={ref}
      className="fixed z-[120] flex items-center gap-1 rounded-xl border border-border bg-background/95 px-1.5 py-1 shadow-xl backdrop-blur"
      style={{ left: `${left}px`, top: `${top}px`, transform: "translateX(-50%)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {canAskAi && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
            title="Ask AI about the selected text"
          >
            <Sparkles className="h-4 w-4" />
            Ask AI
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-full z-[121] mt-1 w-52 rounded-lg border border-border bg-background py-1 shadow-lg">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => runQuickAction(a.id)}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
                >
                  {a.label}
                </button>
              ))}
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={askSomethingElse}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
              >
                Ask something else…
              </button>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onHighlight}
        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
        title="Highlight the selected text"
      >
        <Highlighter className="h-4 w-4" />
        Highlight
      </button>

      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
        title="Copy the selected text"
      >
        <Copy className="h-4 w-4" />
        Copy
      </button>

      {showAddToTable && (
        <button
          type="button"
          onClick={onAddToTable}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
          title="Add the selected text to the soils table"
        >
          <ListPlus className="h-4 w-4" />
          Add to table
        </button>
      )}
    </div>
  );
}
