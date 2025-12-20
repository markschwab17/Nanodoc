/**
 * Document Settings Dialog
 * 
 * Allows users to adjust canvas size and orientation for all pages in the document.
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PAGE_PRESETS, pointsToInches, inchesToPoints } from "@/shared/stores/documentSettingsStore";
import type { PDFDocument } from "@/core/pdf/PDFDocument";

interface DocumentSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: PDFDocument | null;
  currentPage: number;
  onApply: (width: number, height: number, applyToAll: boolean) => Promise<void>;
}

type PresetKey = keyof typeof PAGE_PRESETS | "custom";

export function DocumentSettingsDialog({
  open,
  onOpenChange,
  document,
  currentPage,
  onApply,
}: DocumentSettingsDialogProps) {
  const [preset, setPreset] = useState<PresetKey>("letter");
  const [width, setWidth] = useState("8.5");
  const [height, setHeight] = useState("11");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [applyToAll, setApplyToAll] = useState(true);
  const [isApplying, setIsApplying] = useState(false);

  // Initialize with current page dimensions when dialog opens
  useEffect(() => {
    if (open && document) {
      const pageMetadata = document.getPageMetadata(currentPage);
      if (pageMetadata) {
        const widthInches = pointsToInches(pageMetadata.width);
        const heightInches = pointsToInches(pageMetadata.height);
        
        setWidth(widthInches.toFixed(2));
        setHeight(heightInches.toFixed(2));
        
        // Determine orientation
        if (pageMetadata.width < pageMetadata.height) {
          setOrientation("portrait");
        } else {
          setOrientation("landscape");
        }
        
        // Try to match to a preset
        let matchedPreset: PresetKey = "custom";
        for (const [key, presetValue] of Object.entries(PAGE_PRESETS)) {
          const presetWidth = pointsToInches(presetValue.width);
          const presetHeight = pointsToInches(presetValue.height);
          
          if (
            Math.abs(widthInches - presetWidth) < 0.1 &&
            Math.abs(heightInches - presetHeight) < 0.1
          ) {
            matchedPreset = key as keyof typeof PAGE_PRESETS;
            break;
          }
        }
        setPreset(matchedPreset);
      }
    }
  }, [open, document, currentPage]);

  const handlePresetChange = (value: string) => {
    const presetKey = value as PresetKey;
    setPreset(presetKey);
    
    if (presetKey !== "custom") {
      const presetValue = PAGE_PRESETS[presetKey];
      const presetWidth = pointsToInches(presetValue.width);
      const presetHeight = pointsToInches(presetValue.height);
      
      if (orientation === "portrait") {
        setWidth(presetWidth.toFixed(2));
        setHeight(presetHeight.toFixed(2));
      } else {
        setWidth(presetHeight.toFixed(2));
        setHeight(presetWidth.toFixed(2));
      }
    }
  };

  const handleOrientationChange = (value: string) => {
    const newOrientation = value as "portrait" | "landscape";
    setOrientation(newOrientation);
    
    // Swap width and height
    const temp = width;
    setWidth(height);
    setHeight(temp);
  };

  const handleWidthChange = (value: string) => {
    setWidth(value);
    setPreset("custom"); // Switch to custom when manually editing
  };

  const handleHeightChange = (value: string) => {
    setHeight(value);
    setPreset("custom"); // Switch to custom when manually editing
  };

  const handleApply = async () => {
    const widthInches = parseFloat(width);
    const heightInches = parseFloat(height);
    
    if (isNaN(widthInches) || isNaN(heightInches) || widthInches <= 0 || heightInches <= 0) {
      alert("Please enter valid dimensions");
      return;
    }

    const widthPoints = inchesToPoints(widthInches);
    const heightPoints = inchesToPoints(heightInches);

    setIsApplying(true);
    try {
      await onApply(widthPoints, heightPoints, applyToAll);
      onOpenChange(false);
    } catch (error) {
      console.error("Error applying document settings:", error);
      alert("Failed to apply settings: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Document Settings</DialogTitle>
          <DialogDescription>
            Adjust canvas size and orientation for your document
          </DialogDescription>
        </DialogHeader>
        
        <div className="grid gap-6 py-4">
          {/* Preset Selection */}
          <div className="grid gap-2">
            <Label htmlFor="preset">Page Size Preset</Label>
            <Select value={preset} onValueChange={handlePresetChange}>
              <SelectTrigger id="preset">
                <SelectValue placeholder="Select a preset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="letter">{PAGE_PRESETS.letter.name}</SelectItem>
                <SelectItem value="legal">{PAGE_PRESETS.legal.name}</SelectItem>
                <SelectItem value="a4">{PAGE_PRESETS.a4.name}</SelectItem>
                <SelectItem value="tabloid">{PAGE_PRESETS.tabloid.name}</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Orientation */}
          <div className="grid gap-2">
            <Label>Orientation</Label>
            <RadioGroup value={orientation} onValueChange={handleOrientationChange}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="portrait" id="portrait" />
                <Label htmlFor="portrait" className="font-normal cursor-pointer">
                  Portrait (Vertical)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="landscape" id="landscape" />
                <Label htmlFor="landscape" className="font-normal cursor-pointer">
                  Landscape (Horizontal)
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Custom Dimensions */}
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="width">Width (inches)</Label>
              <Input
                id="width"
                type="number"
                step="0.1"
                min="1"
                value={width}
                onChange={(e) => handleWidthChange(e.target.value)}
                placeholder="8.5"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="height">Height (inches)</Label>
              <Input
                id="height"
                type="number"
                step="0.1"
                min="1"
                value={height}
                onChange={(e) => handleHeightChange(e.target.value)}
                placeholder="11"
              />
            </div>
          </div>

          {/* Apply To */}
          <div className="grid gap-2">
            <Label>Apply To</Label>
            <RadioGroup value={applyToAll ? "all" : "current"} onValueChange={(v) => setApplyToAll(v === "all")}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="all-pages" />
                <Label htmlFor="all-pages" className="font-normal cursor-pointer">
                  All pages in document
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="current" id="current-page" />
                <Label htmlFor="current-page" className="font-normal cursor-pointer">
                  Current page only
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Preview */}
          <div className="rounded-lg border bg-muted p-4">
            <div className="text-sm text-muted-foreground mb-2">Preview</div>
            <div className="flex items-center justify-center h-32">
              <div
                className="border-2 border-primary bg-background shadow-sm"
                style={{
                  width: orientation === "portrait" ? "60px" : "90px",
                  height: orientation === "portrait" ? "90px" : "60px",
                }}
              >
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                  {width}" × {height}"
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isApplying}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={isApplying}>
            {isApplying ? "Applying..." : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}















