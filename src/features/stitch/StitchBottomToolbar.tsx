/**
 * Stitch view bottom toolbar: canvas size, zoom, center, hide canvas.
 */

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, EyeOff, Focus, Lock, Magnet, Unlock, ZoomIn, ZoomOut } from "lucide-react";
import { useStitchStore, CANVAS_PRESETS } from "@/shared/stores/stitchStore";
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "./stitchConstants";

export interface StitchBottomToolbarProps {
  onRecenter?: () => void;
  canvasVisible: boolean;
  onCanvasVisibleChange: (visible: boolean) => void;
}

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
        className="absolute left-1/2 bottom-full -translate-x-1/2 mb-1 px-2 py-0.5 rounded bg-popover border border-border text-popover-foreground text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow"
        role="tooltip"
      >
        {label}
      </span>
    </div>
  );
}

export function StitchBottomToolbar({
  onRecenter,
  canvasVisible,
  onCanvasVisibleChange,
}: StitchBottomToolbarProps) {
  const {
    canvasWidth,
    canvasHeight,
    setCanvasSize,
    setZoomLevel,
    zoomLevel,
    snapToEdges,
    setSnapToEdges,
    selectedTileIds,
    tiles,
    updateTiles,
  } = useStitchStore();

  const hasSelection = selectedTileIds.length > 0;
  const allSelectedLocked =
    hasSelection &&
    selectedTileIds.every((id) => tiles.find((t) => t.id === id)?.locked);
  const handleToggleLockSelected = () => {
    if (!hasSelection) return;
    updateTiles(
      selectedTileIds.map((id) => ({
        id,
        patch: { locked: !allSelectedLocked },
      }))
    );
  };

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

  return (
    <footer className="flex items-center justify-center gap-3 border-t shrink-0 px-3 py-2 bg-muted/30">
      <div className="flex items-center gap-2 flex-wrap justify-center text-xs">
        <div className="flex items-center gap-1.5" role="group" aria-label="Canvas size">
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
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-0.5 border rounded-md h-7 bg-background" role="group" aria-label="Zoom">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Zoom out"
            onClick={() => setZoomLevel(Math.max(MIN_ZOOM, zoomLevel - ZOOM_STEP))}
          >
            <ZoomOut className="h-3 w-3" />
          </Button>
          <span className="text-xs tabular-nums w-8 text-center" title="Zoom level">
            {Math.round(zoomLevel * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="Zoom in"
            onClick={() => setZoomLevel(Math.min(MAX_ZOOM, zoomLevel + ZOOM_STEP))}
          >
            <ZoomIn className="h-3 w-3" />
          </Button>
        </div>
        {onRecenter && (
          <>
            <div className="h-5 w-px bg-border" aria-hidden />
            <IconButtonWithTooltip
              variant="outline"
              title="Center the canvas in the viewport"
              label="Center"
              onClick={onRecenter}
            >
              <Focus className="h-3.5 w-3.5 shrink-0" />
            </IconButtonWithTooltip>
          </>
        )}
        <div className="h-5 w-px bg-border" aria-hidden />
        <IconButtonWithTooltip
          variant={canvasVisible ? "outline" : "secondary"}
          title={canvasVisible ? "Hide canvas (PDFs stay visible)" : "Show canvas"}
          label={canvasVisible ? "Hide canvas" : "Show canvas"}
          onClick={() => onCanvasVisibleChange(!canvasVisible)}
        >
          {canvasVisible ? (
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Eye className="h-3.5 w-3.5 shrink-0" />
          )}
        </IconButtonWithTooltip>
        <div className="h-5 w-px bg-border" aria-hidden />
        <IconButtonWithTooltip
          variant={snapToEdges ? "secondary" : "outline"}
          title="Snap tiles to edges when moving or resizing"
          label="Snap"
          onClick={() => setSnapToEdges(!snapToEdges)}
        >
          <Magnet className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        <IconButtonWithTooltip
          variant="outline"
          disabled={!hasSelection}
          title={allSelectedLocked ? "Unlock so tiles can be moved again" : "Lock position so tiles cannot be moved"}
          label={allSelectedLocked ? "Unlock" : "Lock"}
          onClick={handleToggleLockSelected}
        >
          {allSelectedLocked ? (
            <Lock className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Unlock className="h-3.5 w-3.5 shrink-0" />
          )}
        </IconButtonWithTooltip>
      </div>
    </footer>
  );
}
