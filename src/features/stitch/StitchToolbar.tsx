/**
 * Stitch view toolbar: back, undo/redo, canvas size, zoom, selection actions, save.
 */

import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpToLine,
  CheckSquare,
  Crosshair,
  Crop,
  Download,
  Eraser,
  FilePlus,
  Focus,
  GraduationCap,
  Hand,
  Lock,
  Magnet,
  MousePointer2,
  MousePointerClick,
  Redo2,
  RotateCcw,
  Ruler,
  Save,
  Trash2,
  Undo2,
  Unlock,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useStitchStore, CANVAS_PRESETS } from "@/shared/stores/stitchStore";
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "./stitchConstants";

export interface StitchToolbarProps {
  onAddPdf: () => void;
  contentDeleteMode: boolean;
  setContentDeleteMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  deleteElementMode: boolean;
  setDeleteElementMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  onCropCanvas: () => void;
  onClearCrop: () => void;
  onSaveAndFlatten: (openInEditor: boolean) => void;
  isSaving: boolean;
  onDownloadForTraining?: () => void;
  isExportingTraining?: boolean;
  cropRect: { x: number; y: number; w: number; h: number } | null;
  pointAlignMode: boolean;
  canEnterPointAlign: boolean;
  onPointAlignModeChange: (active: boolean) => void;
  onPointAlignCancel: () => void;
  pointAlignStep: 0 | 1 | 2 | 3;
  scaleAlignMode: boolean;
  canEnterScaleAlign: boolean;
  onScaleAlignModeChange: (active: boolean) => void;
  onScaleAlignCancel: () => void;
  scaleAlignStep: 0 | 1 | 2 | 3;
  onRecenter?: () => void;
  panMode: boolean;
  onPanModeChange: (active: boolean) => void;
  onSelectToolActivate: () => void;
  onClearSession?: () => void;
}

const POINT_ALIGN_STEP_LABELS = [
  "Click point 1 on reference (PDF A)",
  "Click point 1 on target (PDF B)",
  "Click point 2 on reference (PDF A)",
  "Click point 2 on target (PDF B)",
];

const SCALE_ALIGN_STEP_LABELS = [
  "Click first point on reference (PDF A) to start the line",
  "Click second point on reference (PDF A) to set reference distance",
  "Click first point on target (PDF B) to start the line",
  "Click second point on target (PDF B) — PDF B will resize to match scale",
];

/** Wraps an icon button and shows a label below on hover. */
function IconButtonWithTooltip({
  title,
  label,
  children,
  ...buttonProps
}: ComponentProps<typeof Button> & { title: string; label: string }) {
  return (
    <div className="relative group inline-flex">
      <Button size="icon" className="h-7 w-7 shrink-0" title={title} {...buttonProps}>
        {children}
      </Button>
      <span
        className="absolute left-1/2 top-full -translate-x-1/2 mt-1 px-2 py-0.5 rounded bg-popover border border-border text-popover-foreground text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow"
        role="tooltip"
      >
        {label}
      </span>
    </div>
  );
}

export function StitchToolbar({
  onAddPdf,
  contentDeleteMode,
  setContentDeleteMode,
  deleteElementMode,
  setDeleteElementMode,
  onCropCanvas,
  onClearCrop,
  onSaveAndFlatten,
  isSaving,
  onDownloadForTraining,
  isExportingTraining,
  cropRect,
  pointAlignMode,
  canEnterPointAlign,
  onPointAlignModeChange,
  onPointAlignCancel,
  pointAlignStep,
  scaleAlignMode,
  canEnterScaleAlign,
  onScaleAlignModeChange,
  onScaleAlignCancel,
  scaleAlignStep,
  onRecenter,
  panMode,
  onPanModeChange,
  onSelectToolActivate,
  onClearSession,
}: StitchToolbarProps) {
  const {
    canvasWidth,
    canvasHeight,
    setCanvasSize,
    setZoomLevel,
    setSnapToEdges,
    snapToEdges,
    sendTilesToBack,
    bringTilesToFront,
    removeTile,
    updateTiles,
    undo,
    redo,
    undoStack,
    redoStack,
    zoomLevel,
    selectedTileIds,
    setSelectedTileIds,
    tiles,
  } = useStitchStore();

  const hasSelection = selectedTileIds.length > 0;
  const allSelectedLocked =
    hasSelection &&
    selectedTileIds.every((id) => tiles.find((t) => t.id === id)?.locked);
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  const currentPresetIndex = CANVAS_PRESETS.findIndex(
    (p) =>
      (p.width === canvasWidth && p.height === canvasHeight) ||
      (p.width === canvasHeight && p.height === canvasWidth)
  );
  const currentOrientation =
    canvasWidth <= canvasHeight ? "portrait" : "landscape";
  const currentSizeKey =
    currentPresetIndex >= 0
      ? `${CANVAS_PRESETS[currentPresetIndex].width}x${CANVAS_PRESETS[currentPresetIndex].height}-${currentOrientation}`
      : undefined;

  const handleCanvasSizeChange = (value: string) => {
    const [presetKey, orient] = value.split("-");
    const preset = CANVAS_PRESETS.find(
      (p) => `${p.width}x${p.height}` === presetKey
    );
    if (preset) {
      const [w, h] =
        orient === "landscape"
          ? [preset.height, preset.width]
          : [preset.width, preset.height];
      setCanvasSize(w, h);
    }
  };

  const handleDeleteSelected = () => {
    selectedTileIds.forEach((id) => removeTile(id));
  };

  const handleToggleLockSelected = () => {
    if (!hasSelection) return;
    updateTiles(
      selectedTileIds.map((id) => ({
        id,
        patch: { locked: !allSelectedLocked },
      }))
    );
  };

  const deleteContentTip =
    "Delete content: Draw a rectangle on the canvas to erase everything inside that area. Use this to clear a whole region.";
  const deleteElementTip =
    "Delete element: Click a spot or drag over lines/shapes to remove only those drawn elements (e.g. one line or one shape), not a whole region.";

  return (
    <header className="flex flex-col gap-1.5 border-b shrink-0 px-2.5 py-2 bg-muted/30">
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
            <Link to="/editor" title="Back to editor">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <span className="font-semibold text-sm">Stitch PDFs</span>
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-0.5" role="group" aria-label="History">
          <Button variant="outline" size="icon" className="h-7 w-7 shrink-0" disabled={!canUndo} title="Undo (Ctrl+Z)" onClick={undo}>
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7 shrink-0" disabled={!canRedo} title="Redo (Ctrl+Y)" onClick={redo}>
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-1.5" role="group" aria-label="Canvas">
          <Select value={currentSizeKey} onValueChange={handleCanvasSizeChange}>
            <SelectTrigger className="w-[100px] h-7 text-xs" title="Canvas size (e.g. 11×17, 17×22)">
              <SelectValue placeholder="Size" />
            </SelectTrigger>
            <SelectContent>
              {CANVAS_PRESETS.flatMap((p) => [
                <SelectItem key={`${p.width}x${p.height}-portrait`} value={`${p.width}x${p.height}-portrait`}>
                  {p.label} Portrait
                </SelectItem>,
                <SelectItem key={`${p.width}x${p.height}-landscape`} value={`${p.width}x${p.height}-landscape`}>
                  {p.label} Landscape
                </SelectItem>,
              ])}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-0.5 border rounded-md h-7 bg-background">
            <Button variant="ghost" size="icon" className="h-6 w-6" title="Zoom out" onClick={() => setZoomLevel(Math.max(MIN_ZOOM, zoomLevel - ZOOM_STEP))}>
              <ZoomOut className="h-3 w-3" />
            </Button>
            <span className="text-xs tabular-nums w-8 text-center" title="Zoom level">{Math.round(zoomLevel * 100)}%</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" title="Zoom in" onClick={() => setZoomLevel(Math.min(MAX_ZOOM, zoomLevel + ZOOM_STEP))}>
              <ZoomIn className="h-3 w-3" />
            </Button>
          </div>
          <IconButtonWithTooltip variant="outline" title="Center the canvas in the viewport" label="Center" onClick={onRecenter}>
            <Focus className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip
            variant={!panMode && !contentDeleteMode && !deleteElementMode && !pointAlignMode && !scaleAlignMode ? "secondary" : "outline"}
            title="Select and move tiles (Ctrl+A: select all)"
            label="Select"
            onClick={onSelectToolActivate}
          >
            <MousePointer2 className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip variant={panMode ? "secondary" : "outline"} title="Pan canvas (Space: hold to pan)" label="Pan" onClick={() => onPanModeChange(!panMode)}>
            <Hand className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip variant={snapToEdges ? "secondary" : "outline"} title="Snap tiles to edges when moving or resizing" label="Snap" onClick={() => setSnapToEdges(!snapToEdges)}>
            <Magnet className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        <IconButtonWithTooltip variant="outline" title="Add PDF pages to the canvas" label="Add PDF" onClick={onAddPdf}>
          <FilePlus className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        {onClearSession && (
          <IconButtonWithTooltip variant="outline" title="Clear session and start fresh (removes all tiles, resets canvas)" label="Clear session" onClick={onClearSession}>
            <RotateCcw className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        )}
        <div className="h-5 w-px bg-border" aria-hidden />
        <IconButtonWithTooltip
          variant={contentDeleteMode ? "secondary" : "outline"}
          title={deleteContentTip}
          label="Delete content"
          onClick={() => {
            onPanModeChange(false);
            setContentDeleteMode((v) => !v);
            setDeleteElementMode(false);
          }}
        >
          <Eraser className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        <IconButtonWithTooltip
          variant={deleteElementMode ? "secondary" : "outline"}
          title={deleteElementTip}
          label="Delete element"
          onClick={() => {
            onPanModeChange(false);
            setDeleteElementMode((v) => !v);
            setContentDeleteMode(false);
          }}
        >
          <MousePointerClick className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        <IconButtonWithTooltip
          variant={pointAlignMode ? "secondary" : "outline"}
          title={canEnterPointAlign ? "Align a PDF to the locked reference by selecting two point pairs" : "Lock exactly one tile as reference (PDF A) first"}
          label="Point align"
          disabled={!canEnterPointAlign && !pointAlignMode}
          onClick={() => {
            if (pointAlignMode) onPointAlignModeChange(false);
            else {
              onPanModeChange(false);
              onScaleAlignModeChange(false);
              onPointAlignModeChange(true);
            }
          }}
        >
          <Crosshair className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        <IconButtonWithTooltip
          variant={scaleAlignMode ? "secondary" : "outline"}
          title={canEnterScaleAlign ? "Resize a PDF to match the locked reference scale by drawing the same distance on both" : "Lock exactly one tile as reference (PDF A) first"}
          label="Scale align"
          disabled={!canEnterScaleAlign && !scaleAlignMode}
          onClick={() => {
            if (scaleAlignMode) onScaleAlignModeChange(false);
            else {
              onPanModeChange(false);
              onPointAlignModeChange(false);
              onScaleAlignModeChange(true);
            }
          }}
        >
          <Ruler className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        <IconButtonWithTooltip variant="outline" title="Crop output to the bounding box of all tiles" label="Crop to content" onClick={onCropCanvas}>
          <Crop className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        {cropRect && (
          <IconButtonWithTooltip variant="ghost" title="Remove crop" label="Clear crop" onClick={onClearCrop}>
            <X className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        )}
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-0.5" role="group" aria-label="Selection">
          <IconButtonWithTooltip variant="outline" disabled={tiles.length === 0} title={tiles.length === 0 ? "No pages on canvas" : "Select all pages (Ctrl+A)"} label="Select all" onClick={() => tiles.length > 0 && setSelectedTileIds(tiles.map((t) => t.id))}>
            <CheckSquare className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Arrange selection">
          <IconButtonWithTooltip variant="outline" disabled={!hasSelection} title={hasSelection ? "Send selected to back" : "Select a page first"} label="Back" onClick={() => hasSelection && sendTilesToBack(selectedTileIds)}>
            <ArrowDownToLine className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip variant="outline" disabled={!hasSelection} title={hasSelection ? "Bring selected to front" : "Select a page first"} label="Front" onClick={() => hasSelection && bringTilesToFront(selectedTileIds)}>
            <ArrowUpToLine className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip variant="outline" disabled={!hasSelection} title={hasSelection ? "Remove selected pages (Delete key)" : "Select a page first"} label="Delete" onClick={handleDeleteSelected}>
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip variant="outline" disabled={!hasSelection} title={allSelectedLocked ? "Unlock so tiles can be moved again" : "Lock position so tiles cannot be moved"} label={allSelectedLocked ? "Unlock" : "Lock"} onClick={handleToggleLockSelected}>
            {allSelectedLocked ? <Lock className="h-3.5 w-3.5 shrink-0" /> : <Unlock className="h-3.5 w-3.5 shrink-0" />}
          </IconButtonWithTooltip>
        </div>
        <div className="flex-1 min-w-2" />
        <div className="flex items-center gap-0.5" role="group" aria-label="Export">
          <IconButtonWithTooltip variant="outline" disabled={isSaving || tiles.length === 0} title="Download stitched PDF" label={isSaving ? "Saving…" : "Download"} onClick={() => onSaveAndFlatten(false)}>
            <Download className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip disabled={isSaving || tiles.length === 0} title="Save PDF and open in editor" label={isSaving ? "Saving…" : "Save & open"} onClick={() => onSaveAndFlatten(true)}>
            <Save className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          {onDownloadForTraining && (
            <IconButtonWithTooltip
              variant="outline"
              disabled={isExportingTraining || tiles.length === 0}
              title="Download training bundle (ZIP: controls JSON, tile PNGs, stitched PDF and PNG)"
              label={isExportingTraining ? "Exporting…" : "For training"}
              onClick={onDownloadForTraining}
            >
              <GraduationCap className="h-3.5 w-3.5 shrink-0" />
            </IconButtonWithTooltip>
          )}
        </div>
      </div>
      {/* Inline hints when a tool is active */}
      {(contentDeleteMode || deleteElementMode) && (
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-primary/10 text-primary-foreground/90 text-xs border border-primary/20"
          role="status"
          aria-live="polite"
        >
          <span className="font-medium shrink-0">
            {contentDeleteMode ? "Delete content" : "Delete element"}:
          </span>
          <span className="text-muted-foreground">
            {contentDeleteMode ? deleteContentTip.replace(/^Delete content: /, "") : deleteElementTip.replace(/^Delete element: /, "")}
          </span>
        </div>
      )}
      {/* Point align instruction strip */}
      {pointAlignMode && (
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-primary/10 text-primary-foreground/90 text-xs border border-primary/20"
          role="status"
          aria-live="polite"
        >
          <span className="font-medium shrink-0">Point align:</span>
          <span className="text-muted-foreground">{POINT_ALIGN_STEP_LABELS[pointAlignStep]}</span>
          <Button variant="ghost" size="sm" className="h-6 ml-1 shrink-0" onClick={onPointAlignCancel}>
            Cancel
          </Button>
        </div>
      )}
      {/* Scale align instruction strip */}
      {scaleAlignMode && (
        <div
          className="flex items-center gap-2 py-1.5 px-2 rounded-md bg-primary/10 text-primary-foreground/90 text-xs border border-primary/20"
          role="status"
          aria-live="polite"
        >
          <span className="font-medium shrink-0">Scale align:</span>
          <span className="text-muted-foreground">{SCALE_ALIGN_STEP_LABELS[scaleAlignStep]}</span>
          <Button variant="ghost" size="sm" className="h-6 ml-1 shrink-0" onClick={onScaleAlignCancel}>
            Cancel
          </Button>
        </div>
      )}
    </header>
  );
}
