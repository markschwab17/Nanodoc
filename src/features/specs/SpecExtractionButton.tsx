/**
 * Spec Extraction Button
 *
 * Toolbar button that toggles the AI Extraction & Questions side panel.
 */

import { Button } from "@/components/ui/button";
import { Sparkles, Loader2 } from "lucide-react";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import type { GeotechnicalScope } from "@/core/ai/types";

export type ExtractionType = "specs" | "geotechnical";

export const GEOTECHNICAL_SCOPES: GeotechnicalScope[] = [
  "Earthwork Grading Contractor",
  "Site Development",
  "Underground Utilities",
  "Paving & Concrete",
  "Demolition",
  "Land Development",
  "Highway Construction",
  "Commercial Site work",
  "Residential Development",
];

interface SpecExtractionButtonProps {
  buttonClassName?: string;
  iconClassName?: string;
}

export function SpecExtractionButton({ buttonClassName, iconClassName }: SpecExtractionButtonProps = {}) {
  const isExtracting = useSpecExtractionStore((s) => s.isExtracting);
  const getCurrentDocument = usePDFStore((s) => s.getCurrentDocument);
  const aiPanelOpen = useUIStore((s) => s.aiPanelOpen);
  const toggleAIPanel = useUIStore((s) => s.toggleAIPanel);

  const currentDocument = getCurrentDocument();

  if (!currentDocument) return null;

  return (
    <Button
      variant={aiPanelOpen ? "default" : "outline"}
      size="icon"
      disabled={isExtracting}
      title={isExtracting ? "Extracting..." : "AI Extraction & Questions"}
      className={`relative ${buttonClassName ?? ""}`}
      onClick={toggleAIPanel}
    >
      {isExtracting ? (
        <Loader2 className={`animate-spin ${iconClassName ?? "h-4 w-4"}`} />
      ) : (
        <Sparkles className={iconClassName ?? "h-4 w-4"} />
      )}
    </Button>
  );
}
