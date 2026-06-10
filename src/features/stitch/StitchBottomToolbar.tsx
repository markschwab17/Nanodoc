/**
 * Stitch view bottom toolbar: canvas size, zoom, center, hide canvas,
 * and — when a single tile is selected — editable X / Y / W / H fields
 * for pixel-perfect positioning.
 */

import { useState, useEffect, useCallback } from "react";
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
import { useShallow } from "zustand/react/shallow";
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

// ─── Small numeric input with label ──────────────────────────────────────────

function CoordInput({
  label,
  value,
  onChange,
  title,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  title?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(formatPt(value));
  const [focused, setFocused] = useState(false);

  // Sync external value → display text when not focused
  useEffect(() => {
    if (!focused) setText(formatPt(value));
  }, [value, focused]);

  const commit = useCallback(() => {
    const num = parseFloat(text);
    if (Number.isFinite(num)) {
      onChange(num);
    } else {
      setText(formatPt(value));
    }
  }, [text, value, onChange]);

  return (
    <label className="flex items-center gap-0.5" title={title}>
      <span className="text-[10px] font-medium text-muted-foreground uppercase select-none">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          // Up/down arrow inside the field: nudge by ±0.1
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const step = e.shiftKey ? 1 : 0.1;
            const delta = e.key === "ArrowUp" ? step : -step;
            const next = Math.round((value + delta) * 100) / 100;
            onChange(next);
          }
        }}
        className="h-6 w-[52px] rounded border border-input bg-background px-1 text-[11px] tabular-nums text-center focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </label>
  );
}

/** Format a pt value: show up to 2 decimals, but trim trailing zeros. */
function formatPt(v: number): string {
  // Round to 2 decimals to avoid floating-point noise
  const r = Math.round(v * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function StitchBottomToolbar({
  onRecenter,
  canvasVisible,
  onCanvasVisibleChange,
}: StitchBottomToolbarProps) {
  // Shallow-picked subscription — skips re-renders from store fields this
  // toolbar doesn't use (e.g. panOffset during panning). `tiles` stays
  // selected: the coordinate inputs live-track the selected tile during drags.
  const {
    canvasWidth,
    canvasHeight,
    setCanvasSize,
    setZoomLevel,
    zoomLevel,
    snapToEdges,
    setSnapToEdges,
    resizeLocked,
    selectedTileIds,
    tiles,
    updateTile,
    updateTiles,
  } = useStitchStore(
    useShallow((s) => ({
      canvasWidth: s.canvasWidth,
      canvasHeight: s.canvasHeight,
      setCanvasSize: s.setCanvasSize,
      setZoomLevel: s.setZoomLevel,
      zoomLevel: s.zoomLevel,
      snapToEdges: s.snapToEdges,
      setSnapToEdges: s.setSnapToEdges,
      resizeLocked: s.resizeLocked,
      selectedTileIds: s.selectedTileIds,
      tiles: s.tiles,
      updateTile: s.updateTile,
      updateTiles: s.updateTiles,
    }))
  );

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

  // ─── Selected tile for coordinate inputs ─────────────────────────────────
  const singleSelectedTile =
    selectedTileIds.length === 1
      ? tiles.find((t) => t.id === selectedTileIds[0])
      : null;

  const handleCoordChange = useCallback(
    (field: "x" | "y" | "width" | "height", value: number) => {
      if (!singleSelectedTile) return;
      // Respect the same locks the drag/resize handles honor: locked tiles
      // don't move, and W/H is off while resize is locked.
      if (singleSelectedTile.locked) return;
      if (field === "width" || field === "height") {
        if (useStitchStore.getState().resizeLocked) return;
        // Clamp width/height to a minimum
        value = Math.max(1, value);
      }
      // No-op edits (focus/blur without change) must not pollute the undo stack
      if (singleSelectedTile[field] === value) return;
      updateTile(singleSelectedTile.id, { [field]: value });
    },
    [singleSelectedTile, updateTile]
  );

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
    <footer className="flex items-center justify-center gap-3 border-t shrink-0 px-3 py-2 bg-muted/30" data-tour="stitch-canvas-controls">
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
        {/* ── Tile position / size inputs (single selection only) ── */}
        {singleSelectedTile && (
          <>
            <div className="h-5 w-px bg-border" aria-hidden />
            <div className="flex items-center gap-1.5" role="group" aria-label="Tile position and size">
              <CoordInput label="X" value={singleSelectedTile.x} disabled={Boolean(singleSelectedTile.locked)} onChange={(v) => handleCoordChange("x", v)} title={singleSelectedTile.locked ? "Tile is locked" : "X position (pt). Up/Down arrow: ±0.1pt, Shift: ±1pt"} />
              <CoordInput label="Y" value={singleSelectedTile.y} disabled={Boolean(singleSelectedTile.locked)} onChange={(v) => handleCoordChange("y", v)} title={singleSelectedTile.locked ? "Tile is locked" : "Y position (pt). Up/Down arrow: ±0.1pt, Shift: ±1pt"} />
              <CoordInput label="W" value={singleSelectedTile.width} disabled={Boolean(singleSelectedTile.locked) || resizeLocked} onChange={(v) => handleCoordChange("width", v)} title={resizeLocked ? "Resize locked" : "Width (pt)"} />
              <CoordInput label="H" value={singleSelectedTile.height} disabled={Boolean(singleSelectedTile.locked) || resizeLocked} onChange={(v) => handleCoordChange("height", v)} title={resizeLocked ? "Resize locked" : "Height (pt)"} />
            </div>
          </>
        )}
      </div>
    </footer>
  );
}
