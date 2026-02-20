/**
 * Minimal toolbar for CTO split-screen embed: "Select text" and "Add to table".
 * When user selects text in the PDF, "Add to table" sends nanodoc-text-selection to the CTO parent.
 * See CTO docs/NANODOC_EMBED.md.
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { useCtoTextSelectionStore } from "@/shared/stores/ctoTextSelectionStore";
import { parseCiviltakeoffViewParams } from "@/shared/civiltakeoffViewParams";
import { Button } from "@/components/ui/button";
import { TextSelect, ListPlus } from "lucide-react";
import { useNotificationStore } from "@/shared/stores/notificationStore";

export function CTOSplitScreenToolbar() {
  const setActiveTool = useUIStore((s) => s.setActiveTool);
  const activeTool = useUIStore((s) => s.activeTool);
  const selection = useCtoTextSelectionStore((s) => s.selection);
  const clearSelection = useCtoTextSelectionStore((s) => s.clearSelection);
  const showNotification = useNotificationStore((s) => s.showNotification);

  const handleAddToTable = () => {
    if (!selection) return;
    const params = parseCiviltakeoffViewParams(typeof window !== "undefined" ? window.location.search : "");
    const targetOrigin = params.api_origin ?? "*";
    try {
      window.parent.postMessage(
        { type: "nanodoc-text-selection", page: selection.page, quote: selection.quote },
        targetOrigin
      );
      clearSelection();
      showNotification("Sent to table", "success");
    } catch (e) {
      showNotification("Failed to send to table", "error");
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-background/95 border-b border-border shrink-0">
      <Button
        variant={activeTool === "selectText" ? "default" : "outline"}
        size="sm"
        onClick={() => setActiveTool("selectText")}
        className="gap-1.5"
        title="Select text in the PDF, then click Add to table"
      >
        <TextSelect className="h-4 w-4" />
        Select text
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={handleAddToTable}
        disabled={!selection?.quote?.trim()}
        className="gap-1.5"
        title={selection ? "Add selected text to the soils table" : "Select text first, then click here"}
      >
        <ListPlus className="h-4 w-4" />
        Add to table
      </Button>
    </div>
  );
}
