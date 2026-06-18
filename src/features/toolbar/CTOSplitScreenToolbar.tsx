/**
 * Minimal toolbar for the CTO split-screen embed: activates the "Select text" tool.
 * Once text is selected, the floating SelectionToolbar offers Ask AI / Highlight /
 * Copy / Add to table. See CTO docs/NANODOC_EMBED.md.
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { Button } from "@/components/ui/button";
import { TextSelect } from "lucide-react";

export function CTOSplitScreenToolbar() {
  const setActiveTool = useUIStore((s) => s.setActiveTool);
  const activeTool = useUIStore((s) => s.activeTool);

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-background/95 border-b border-border shrink-0">
      <Button
        variant={activeTool === "selectText" ? "default" : "outline"}
        size="sm"
        onClick={() => setActiveTool("selectText")}
        className="gap-1.5"
        title="Select text in the PDF, then choose an action"
      >
        <TextSelect className="h-4 w-4" />
        Select text
      </Button>
    </div>
  );
}
