/**
 * Stamp Toolbar Component
 * 
 * Toolbar for stamp tool
 */

import { Button } from "@/components/ui/button";
import { Stamp as StampIcon } from "lucide-react";
import { useStampStore } from "@/shared/stores/stampStore";
import { getSelectedStamp } from "@/features/tools/StampTool";

interface StampToolbarProps {
  onOpenGallery: () => void;
}

export function StampToolbar({ onOpenGallery }: StampToolbarProps) {
  const selectedStampId = getSelectedStamp();
  const stamp = selectedStampId ? useStampStore.getState().getStamp(selectedStampId) : null;

  return (
    <div className="flex items-center gap-2 p-2">
      <span className="text-sm font-medium">Stamp:</span>
      
      {stamp ? (
        <>
          <span className="text-xs text-muted-foreground">
            Selected: <span className="font-medium">{stamp.name}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            - Click on PDF to place
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">
          Select a stamp from the gallery first
        </span>
      )}
      
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenGallery}
        className="ml-auto"
      >
        <StampIcon className="h-4 w-4 mr-1" />
        Gallery
      </Button>
    </div>
  );
}

