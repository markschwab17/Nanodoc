/**
 * Print Settings Dialog
 * 
 * Provides comprehensive print configuration UI for PDF printing.
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
import { Slider } from "@/components/ui/slider";
import { 
  usePrintStore, 
  type PrintSettings,
  type PageOrientation,
  type PageSize,
  type MarginPreset,
  type ScalingMode,
  type PagesPerSheet,
  type PageOrder,
  type PrintRange,
  DEFAULT_SETTINGS,
  // PAGE_SIZES, // Reserved for future use
} from "@/shared/stores/printStore";
import { PDFDocument } from "@/core/pdf/PDFDocument";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { Printer } from "lucide-react";
import { PrintPreview } from "./PrintPreview";

interface PrintSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: PDFDocument | null;
  onPrint: (settings: PrintSettings, startPage: number, endPage: number) => void;
  currentPage: number;
}

export function PrintSettingsDialog({
  open,
  onOpenChange,
  document,
  onPrint,
  currentPage,
}: PrintSettingsDialogProps) {
  const { getSettings, updateSettings } = usePrintStore();
  const documentId = document?.getId() || "";
  const settings = documentId ? getSettings(documentId) : DEFAULT_SETTINGS;
  const [localSettings, setLocalSettings] = useState<PrintSettings>(settings);
  const [renderer, setRenderer] = useState<PDFRenderer | null>(null);

  // Initialize renderer when dialog opens
  useEffect(() => {
    if (open && !renderer) {
      const initRenderer = async () => {
        try {
          const mupdfModule = await import("mupdf");
          const newRenderer = new PDFRenderer(mupdfModule.default);
          setRenderer(newRenderer);
        } catch (error) {
          console.error("Error initializing renderer for print preview:", error);
        }
      };
      initRenderer();
    }
  }, [open, renderer]);

  // Update local settings when dialog opens or document changes
  useEffect(() => {
    if (open && documentId) {
      const currentSettings = getSettings(documentId);
      setLocalSettings(currentSettings);
    }
  }, [open, documentId, getSettings]);

  // Update local settings when dialog opens
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen && documentId) {
      const currentSettings = getSettings(documentId);
      setLocalSettings(currentSettings);
    }
    onOpenChange(newOpen);
  };

  const updateLocalSetting = <K extends keyof PrintSettings>(
    key: K,
    value: PrintSettings[K]
  ) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handlePrint = () => {
    // Save settings to store for this document
    if (documentId) {
      updateSettings(documentId, localSettings);
    }

    // Calculate page range
    const totalPages = document?.getPageCount() || 0;
    let startPage = 0;
    let endPage = totalPages - 1;

    if (localSettings.printRange === "current") {
      startPage = currentPage;
      endPage = currentPage;
    } else if (localSettings.printRange === "custom") {
      // Parse custom range (e.g., "1-5, 8, 11-13")
      // For now, we'll use the simple approach
      // TODO: Implement proper range parsing
      const ranges = parsePageRange(localSettings.customRange, totalPages);
      if (ranges.length > 0) {
        startPage = ranges[0];
        endPage = ranges[ranges.length - 1];
      }
    }

    onPrint(localSettings, startPage, endPage);
    onOpenChange(false);
  };

  // Helper to parse page ranges like "1-5, 8, 11-13"
  const parsePageRange = (rangeStr: string, totalPages: number): number[] => {
    const pages: number[] = [];
    const parts = rangeStr.split(",").map((s) => s.trim());

    for (const part of parts) {
      if (part.includes("-")) {
        const [startStr, endStr] = part.split("-").map((s) => s.trim());
        const start = Math.max(1, parseInt(startStr) || 1) - 1; // Convert to 0-based
        const end = Math.min(totalPages, parseInt(endStr) || totalPages) - 1;
        for (let i = start; i <= end; i++) {
          if (!pages.includes(i)) pages.push(i);
        }
      } else {
        const pageNum = parseInt(part);
        if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
          const idx = pageNum - 1; // Convert to 0-based
          if (!pages.includes(idx)) pages.push(idx);
        }
      }
    }

    return pages.sort((a, b) => a - b);
  };

  const totalPages = document?.getPageCount() || 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            Print Settings
          </DialogTitle>
          <DialogDescription>
            Configure print layout, orientation, and page settings
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-4">
          {/* Print Range Section */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Print Range</Label>
            <RadioGroup
              value={localSettings.printRange}
              onValueChange={(value) =>
                updateLocalSetting("printRange", value as PrintRange)
              }
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="range-all" />
                <Label htmlFor="range-all" className="font-normal cursor-pointer">
                  All pages ({totalPages} {totalPages === 1 ? "page" : "pages"})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="current" id="range-current" />
                <Label htmlFor="range-current" className="font-normal cursor-pointer">
                  Current page (Page {currentPage + 1})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="custom" id="range-custom" />
                <Label htmlFor="range-custom" className="font-normal cursor-pointer">
                  Custom range
                </Label>
              </div>
            </RadioGroup>
            {localSettings.printRange === "custom" && (
              <Input
                placeholder="e.g., 1-5, 8, 11-13"
                value={localSettings.customRange}
                onChange={(e) =>
                  updateLocalSetting("customRange", e.target.value)
                }
                className="ml-6"
              />
            )}
          </div>

          {/* Page Setup Section */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Page Setup</Label>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="orientation">Orientation</Label>
                <Select
                  value={localSettings.orientation}
                  onValueChange={(value) =>
                    updateLocalSetting("orientation", value as PageOrientation)
                  }
                >
                  <SelectTrigger id="orientation">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (Respect Original)</SelectItem>
                    <SelectItem value="portrait">Portrait</SelectItem>
                    <SelectItem value="landscape">Landscape</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pageSize">Page Size</Label>
                <Select
                  value={localSettings.pageSize}
                  onValueChange={(value) =>
                    updateLocalSetting("pageSize", value as PageSize)
                  }
                >
                  <SelectTrigger id="pageSize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="letter">Letter (8.5" × 11")</SelectItem>
                    <SelectItem value="a4">A4 (8.27" × 11.69")</SelectItem>
                    <SelectItem value="legal">Legal (8.5" × 14")</SelectItem>
                    <SelectItem value="tabloid">Tabloid (11" × 17")</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {localSettings.pageSize === "custom" && (
              <div className="grid grid-cols-2 gap-4 ml-0">
                <div className="space-y-2">
                  <Label htmlFor="customWidth">Width (inches)</Label>
                  <Input
                    id="customWidth"
                    type="number"
                    step="0.1"
                    min="1"
                    max="100"
                    value={localSettings.customPageSize.width}
                    onChange={(e) =>
                      updateLocalSetting("customPageSize", {
                        ...localSettings.customPageSize,
                        width: parseFloat(e.target.value) || 8.5,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="customHeight">Height (inches)</Label>
                  <Input
                    id="customHeight"
                    type="number"
                    step="0.1"
                    min="1"
                    max="100"
                    value={localSettings.customPageSize.height}
                    onChange={(e) =>
                      updateLocalSetting("customPageSize", {
                        ...localSettings.customPageSize,
                        height: parseFloat(e.target.value) || 11,
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>

          {/* Layout Section */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Multiple Pages per Sheet</Label>
            <p className="text-sm text-muted-foreground">
              Print multiple PDF pages on a single sheet of paper to save paper and create handouts
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pagesPerSheet">PDF Pages per Physical Sheet</Label>
                <Select
                  value={localSettings.pagesPerSheet.toString()}
                  onValueChange={(value) =>
                    updateLocalSetting(
                      "pagesPerSheet",
                      parseInt(value) as PagesPerSheet
                    )
                  }
                >
                  <SelectTrigger id="pagesPerSheet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 page per sheet (Normal)</SelectItem>
                    <SelectItem value="2">2 pages per sheet</SelectItem>
                    <SelectItem value="4">4 pages per sheet</SelectItem>
                    <SelectItem value="6">6 pages per sheet</SelectItem>
                    <SelectItem value="9">9 pages per sheet</SelectItem>
                    <SelectItem value="16">16 pages per sheet</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {localSettings.pagesPerSheet > 1 && (
                <div className="space-y-2">
                  <Label htmlFor="pageOrder">Page Arrangement</Label>
                  <Select
                    value={localSettings.pageOrder}
                    onValueChange={(value) =>
                      updateLocalSetting("pageOrder", value as PageOrder)
                    }
                  >
                    <SelectTrigger id="pageOrder">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="horizontal">Across then Down</SelectItem>
                      <SelectItem value="vertical">Down then Across</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>

          {/* Margins Section */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Margins</Label>
            <Select
              value={localSettings.marginPreset}
              onValueChange={(value) =>
                updateLocalSetting("marginPreset", value as MarginPreset)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (0")</SelectItem>
                <SelectItem value="narrow">Narrow (0.25")</SelectItem>
                <SelectItem value="normal">Normal (0.5")</SelectItem>
                <SelectItem value="wide">Wide (1")</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            {localSettings.marginPreset === "custom" && (
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="marginTop" className="text-xs">
                    Top
                  </Label>
                  <Input
                    id="marginTop"
                    type="number"
                    step="0.1"
                    min="0"
                    max="5"
                    value={localSettings.customMargins.top}
                    onChange={(e) =>
                      updateLocalSetting("customMargins", {
                        ...localSettings.customMargins,
                        top: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="marginRight" className="text-xs">
                    Right
                  </Label>
                  <Input
                    id="marginRight"
                    type="number"
                    step="0.1"
                    min="0"
                    max="5"
                    value={localSettings.customMargins.right}
                    onChange={(e) =>
                      updateLocalSetting("customMargins", {
                        ...localSettings.customMargins,
                        right: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="marginBottom" className="text-xs">
                    Bottom
                  </Label>
                  <Input
                    id="marginBottom"
                    type="number"
                    step="0.1"
                    min="0"
                    max="5"
                    value={localSettings.customMargins.bottom}
                    onChange={(e) =>
                      updateLocalSetting("customMargins", {
                        ...localSettings.customMargins,
                        bottom: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="marginLeft" className="text-xs">
                    Left
                  </Label>
                  <Input
                    id="marginLeft"
                    type="number"
                    step="0.1"
                    min="0"
                    max="5"
                    value={localSettings.customMargins.left}
                    onChange={(e) =>
                      updateLocalSetting("customMargins", {
                        ...localSettings.customMargins,
                        left: parseFloat(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>

          {/* Scaling Section */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Scaling</Label>
            <RadioGroup
              value={localSettings.scalingMode}
              onValueChange={(value) =>
                updateLocalSetting("scalingMode", value as ScalingMode)
              }
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="fit" id="scale-fit" />
                <Label htmlFor="scale-fit" className="font-normal cursor-pointer">
                  Fit to page
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="actual" id="scale-actual" />
                <Label htmlFor="scale-actual" className="font-normal cursor-pointer">
                  Actual size (100%)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="custom" id="scale-custom" />
                <Label htmlFor="scale-custom" className="font-normal cursor-pointer">
                  Custom scale
                </Label>
              </div>
            </RadioGroup>
            {localSettings.scalingMode === "custom" && (
              <div className="space-y-2 ml-6">
                <div className="flex items-center gap-4">
                  <Slider
                    value={[localSettings.customScale]}
                    onValueChange={([value]) =>
                      updateLocalSetting("customScale", value)
                    }
                    min={25}
                    max={400}
                    step={5}
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    min="25"
                    max="400"
                    value={localSettings.customScale}
                    onChange={(e) =>
                      updateLocalSetting(
                        "customScale",
                        Math.max(25, Math.min(400, parseInt(e.target.value) || 100))
                      )
                    }
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
            )}
          </div>

          {/* Visual Print Preview */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Print Preview</Label>
            <div className="rounded-lg border bg-muted p-6">
              <PrintPreview 
                settings={localSettings} 
                totalPages={totalPages}
                document={document}
                renderer={renderer}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handlePrint} disabled={!document}>
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

