/**
 * Draft Recovery Modal
 *
 * Shown on startup when crash-recovery drafts exist (auto-saved copies of
 * documents that had no file path to save to). Lets the user recover a draft
 * into a new tab or discard it.
 */

import { useEffect, useState } from "react";
import { usePDF } from "@/shared/hooks/usePDF";
import { cleanupDrafts, deleteDraft, type DraftRecord } from "@/shared/browserDraftStorage";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, X, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

function formatDate(timestamp: number) {
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function DraftRecoveryModal() {
  const { loadPDF } = usePDF();
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // One-shot startup check (also GCs expired drafts).
  useEffect(() => {
    let cancelled = false;
    cleanupDrafts()
      .then((found) => {
        if (!cancelled && found.length > 0) {
          setDrafts(found);
          setOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!open || drafts.length === 0) return null;

  const handleRecover = async (draft: DraftRecord) => {
    setBusyKey(draft.key);
    try {
      const mupdfModule = await import("mupdf");
      const recoveredName = draft.name.replace(/\.pdf$/i, "") + " (recovered).pdf";
      await loadPDF(draft.bytes, recoveredName, mupdfModule.default, null);
      await deleteDraft(draft.key);
      setDrafts((prev) => {
        const next = prev.filter((d) => d.key !== draft.key);
        if (next.length === 0) setOpen(false);
        return next;
      });
    } catch (e) {
      console.error("[DraftRecovery] Failed to recover draft:", e);
    } finally {
      setBusyKey(null);
    }
  };

  const handleDiscard = async (draft: DraftRecord) => {
    await deleteDraft(draft.key);
    setDrafts((prev) => {
      const next = prev.filter((d) => d.key !== draft.key);
      if (next.length === 0) setOpen(false);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[26rem] bg-background border rounded-lg shadow-xl flex flex-col max-h-[calc(100vh-2rem)]">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-sm font-semibold">Recover unsaved work?</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              We found auto-saved copies of documents that were never saved.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(false)} title="Decide later">
            <X className="h-3 w-3" />
          </Button>
        </div>
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-3 space-y-2">
            {drafts.map((draft) => (
              <div
                key={draft.key}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-md border min-w-0",
                  busyKey === draft.key && "opacity-50 pointer-events-none"
                )}
              >
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{draft.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">{formatDate(draft.updatedAt)}</p>
                  </div>
                </div>
                <Button size="sm" className="h-7 px-2 text-xs flex-shrink-0" onClick={() => handleRecover(draft)}>
                  Recover
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground flex-shrink-0"
                  onClick={() => handleDiscard(draft)}
                >
                  Discard
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
