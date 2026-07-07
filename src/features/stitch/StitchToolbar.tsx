/**
 * Stitch view toolbar: back, undo/redo, canvas size, zoom, selection actions, save.
 */

import type { ComponentProps } from "react";
import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
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
  GraduationCap,
  Hand,
  Maximize2,
  MousePointer2,
  MousePointerClick,
  Redo2,
  RotateCcw,
  Ruler,
  Expand,
  Save,
  Shrink,
  Sparkles,
  Stamp,
  Trash2,
  Undo2,
  Upload,
  X,
  HelpCircle,
} from "lucide-react";
import { startTour } from "@/features/tour/useTourLauncher";
import { useTourStore } from "@/shared/stores/tourStore";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { useShallow } from "zustand/react/shallow";
import { MIN_SCALE, MAX_SCALE, SCALE_STEP } from "./stitchConstants";
import { generateScaleStampDataUrl, getScaleStampDimensions } from "./scaleStamp";

export interface StitchToolbarProps {
  onAddPdf: () => void;
  /** When false, Add PDF is shown large in main area; when true, show small icon here. */
  hasTiles: boolean;
  contentDeleteMode: boolean;
  setContentDeleteMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  deleteElementMode: boolean;
  setDeleteElementMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  onCropCanvas: () => void;
  onClearCrop: () => void;
  onSaveAndFlatten: (openInEditor: boolean) => void;
  isSaving: boolean;
  /** When true, show "Save to Civiltakeoff" button (CTO session). */
  showSaveToCto?: boolean;
  onSaveToCto?: () => void;
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
  panMode: boolean;
  onPanModeChange: (active: boolean) => void;
  onSelectToolActivate: () => void;
  onClearSession?: () => void;
  /** Clean-Composite: detect + review title-block/match-margin hide-regions. */
  onCleanup?: () => void;
  /** True while the clean-up review overlay is active. */
  cleanupActive?: boolean;
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

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Wraps an icon button and shows a label (or description) below on hover. */
function IconButtonWithTooltip({
  title,
  label,
  tooltipDescription,
  children,
  ...buttonProps
}: ComponentProps<typeof Button> & { title: string; label: string; tooltipDescription?: string }) {
  const tooltipText = tooltipDescription ?? label;
  return (
    <div className="relative group inline-flex">
      <Button size="icon" className="h-7 w-7 shrink-0" title={title} {...buttonProps}>
        {children}
      </Button>
      <span
        className={`absolute left-1/2 top-full -translate-x-1/2 mt-1 px-2 py-1 rounded bg-popover border border-border text-popover-foreground text-xs opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow ${tooltipDescription ? "whitespace-pre-line min-w-[280px] max-w-[320px] text-left" : "whitespace-nowrap"}`}
        role="tooltip"
      >
        {tooltipText}
      </span>
    </div>
  );
}

export function StitchToolbar({
  onAddPdf,
  hasTiles,
  contentDeleteMode,
  setContentDeleteMode,
  deleteElementMode,
  setDeleteElementMode,
  onCropCanvas,
  onClearCrop,
  onSaveAndFlatten,
  isSaving,
  showSaveToCto,
  onSaveToCto,
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
  panMode,
  onPanModeChange,
  onSelectToolActivate,
  onClearSession,
  onCleanup,
  cleanupActive,
}: StitchToolbarProps) {
  // Shallow-picked subscription: avoids re-rendering the whole toolbar on
  // store changes it doesn't use (e.g. panOffset during panning). Tile
  // CONTENT is deliberately not selected — only the count.
  const {
    canvasWidth,
    canvasHeight,
    setResizeLocked,
    resizeLocked,
    referenceScaleFeetPerInch,
    setReferenceScaleFeetPerInch,
    compositionScaleFactor,
    scaleComposition,
    addTiles,
    sendTilesToBack,
    bringTilesToFront,
    removeTiles,
    undo,
    redo,
    selectedTileIds,
    setSelectedTileIds,
  } = useStitchStore(
    useShallow((s) => ({
      canvasWidth: s.canvasWidth,
      canvasHeight: s.canvasHeight,
      setResizeLocked: s.setResizeLocked,
      resizeLocked: s.resizeLocked,
      referenceScaleFeetPerInch: s.referenceScaleFeetPerInch,
      setReferenceScaleFeetPerInch: s.setReferenceScaleFeetPerInch,
      compositionScaleFactor: s.compositionScaleFactor,
      scaleComposition: s.scaleComposition,
      addTiles: s.addTiles,
      sendTilesToBack: s.sendTilesToBack,
      bringTilesToFront: s.bringTilesToFront,
      removeTiles: s.removeTiles,
      undo: s.undo,
      redo: s.redo,
      selectedTileIds: s.selectedTileIds,
      setSelectedTileIds: s.setSelectedTileIds,
    }))
  );
  const tileCount = useStitchStore((s) => s.tiles.length);
  const canUndoFlag = useStitchStore((s) => s.undoStack.length > 0);
  const canRedoFlag = useStitchStore((s) => s.redoStack.length > 0);

  const effectiveScaleFeetPerInch =
    referenceScaleFeetPerInch != null ? referenceScaleFeetPerInch / compositionScaleFactor : null;

  const [scaleInputValue, setScaleInputValue] = useState(
    referenceScaleFeetPerInch != null ? String(referenceScaleFeetPerInch) : ""
  );
  const [scaleInputFocused, setScaleInputFocused] = useState(false);
  const [effectiveScaleInputValue, setEffectiveScaleInputValue] = useState("");
  const [effectiveScaleInputFocused, setEffectiveScaleInputFocused] = useState(false);
  useEffect(() => {
    if (!scaleInputFocused && referenceScaleFeetPerInch != null) {
      setScaleInputValue(String(referenceScaleFeetPerInch));
    } else if (!scaleInputFocused && referenceScaleFeetPerInch == null) {
      setScaleInputValue("");
    }
  }, [referenceScaleFeetPerInch, scaleInputFocused]);
  useEffect(() => {
    if (!effectiveScaleInputFocused && effectiveScaleFeetPerInch != null) {
      setEffectiveScaleInputValue(String(Math.round(effectiveScaleFeetPerInch)));
    } else if (!effectiveScaleInputFocused && effectiveScaleFeetPerInch == null) {
      setEffectiveScaleInputValue("");
    }
  }, [effectiveScaleFeetPerInch, effectiveScaleInputFocused]);

  const commitScaleInput = () => {
    const trimmed = scaleInputValue.trim();
    if (trimmed === "") {
      setReferenceScaleFeetPerInch(null);
      setScaleInputValue("");
      return;
    }
    const num = parseFloat(trimmed);
    if (Number.isFinite(num) && num > 0) {
      setReferenceScaleFeetPerInch(num);
      setScaleInputValue(String(num));
    } else {
      setScaleInputValue(referenceScaleFeetPerInch != null ? String(referenceScaleFeetPerInch) : "");
    }
  };

  const commitEffectiveScaleInput = () => {
    const trimmed = effectiveScaleInputValue.trim();
    if (trimmed === "" || referenceScaleFeetPerInch == null) return;
    const num = parseFloat(trimmed);
    if (Number.isFinite(num) && num >= 1) {
      setEffectiveScaleTo(Math.round(num));
      setEffectiveScaleInputValue(String(Math.round(num)));
    } else {
      setEffectiveScaleInputValue(effectiveScaleFeetPerInch != null ? String(Math.round(effectiveScaleFeetPerInch)) : "");
    }
  };

  const handleScaleComposition = (factor: number) => {
    const ox = cropRect ? cropRect.x + cropRect.w / 2 : canvasWidth / 2;
    const oy = cropRect ? cropRect.y + cropRect.h / 2 : canvasHeight / 2;
    scaleComposition(factor, ox, oy);
  };

  /** When reference scale is set, step to next whole-number effective scale (1"=k'). Otherwise step composition by SCALE_STEP. */
  const handleScaleStep = (delta: number) => {
    if (referenceScaleFeetPerInch != null && referenceScaleFeetPerInch > 0) {
      const currentEffective = referenceScaleFeetPerInch / compositionScaleFactor;
      const k = Math.floor(currentEffective);
      if (delta < 0) {
        const newEffective = k + 1;
        const newComp = referenceScaleFeetPerInch / newEffective;
        const target = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newComp));
        if (Math.abs(target - compositionScaleFactor) < 1e-6) return;
        handleScaleComposition(target / compositionScaleFactor);
      } else {
        const newEffective = Math.max(1, k - (Number.isInteger(currentEffective) ? 1 : 0));
        const newComp = referenceScaleFeetPerInch / newEffective;
        const target = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newComp));
        if (Math.abs(target - compositionScaleFactor) < 1e-6) return;
        handleScaleComposition(target / compositionScaleFactor);
      }
    } else {
      const target = Math.max(MIN_SCALE, Math.min(MAX_SCALE, roundToStep(compositionScaleFactor + delta, SCALE_STEP)));
      if (Math.abs(target - compositionScaleFactor) < 1e-6) return;
      handleScaleComposition(target / compositionScaleFactor);
    }
  };

  /** Set composition so effective scale is exactly targetEffective (e.g. 80 for 1"=80'). Requires reference scale. */
  const setEffectiveScaleTo = (targetEffective: number) => {
    if (referenceScaleFeetPerInch == null || !Number.isFinite(targetEffective) || targetEffective < 1) return;
    const newComp = referenceScaleFeetPerInch / targetEffective;
    const target = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newComp));
    if (Math.abs(target - compositionScaleFactor) < 1e-6) return;
    handleScaleComposition(target / compositionScaleFactor);
  };

  const handleAddScaleStamp = () => {
    if (effectiveScaleFeetPerInch == null) return;
    const effectiveWhole = Math.round(effectiveScaleFeetPerInch);
    const imageDataUrl = generateScaleStampDataUrl(effectiveWhole);
    if (!imageDataUrl) return;
    const { widthPt, heightPt } = getScaleStampDimensions(effectiveWhole);
    const margin = 12;
    const cx = cropRect ? cropRect.x + cropRect.w : canvasWidth;
    const cy = cropRect ? cropRect.y + cropRect.h : canvasHeight;
    const x = cx - widthPt - margin;
    const y = cy - heightPt - margin;
    addTiles([
      {
        sourcePdfBytes: new Uint8Array(0),
        sourcePageIndex: -1,
        isScaleStamp: true,
        scaleStampFeetPerInch: effectiveWhole,
        x,
        y,
        width: widthPt,
        height: heightPt,
        imageDataUrl,
      },
    ]);
  };

  const hasSelection = selectedTileIds.length > 0;
  const canUndo = canUndoFlag;
  const canRedo = canRedoFlag;
  const activeTourId = useTourStore((s) => s.activeTourId);

  // Show a nudge pointing at the Help button if the user has tiles loaded
  // but hasn't interacted with any tool for 15 seconds
  const [showHelpNudge, setShowHelpNudge] = useState(false);
  const nudgeDismissedRef = useRef(false);
  const anyToolActive = panMode || contentDeleteMode || deleteElementMode || pointAlignMode || scaleAlignMode || hasSelection || Boolean(cleanupActive);

  useEffect(() => {
    // Don't show if: no tiles, user already interacted, nudge was dismissed, or tour is running
    if (!hasTiles || anyToolActive || nudgeDismissedRef.current || activeTourId) {
      setShowHelpNudge(false);
      return;
    }
    const timer = setTimeout(() => setShowHelpNudge(true), 15000);
    return () => clearTimeout(timer);
  }, [hasTiles, anyToolActive, activeTourId]);

  // Dismiss nudge permanently once any tool is used or tour starts
  useEffect(() => {
    if (anyToolActive || activeTourId) {
      nudgeDismissedRef.current = true;
      setShowHelpNudge(false);
    }
  }, [anyToolActive, activeTourId]);

  const handleDeleteSelected = () => {
    removeTiles(selectedTileIds);
  };

  const deleteContentTip =
    "Delete content: Draw a rectangle on the canvas to erase everything inside that area. Use this to clear a whole region.";
  const deleteElementTip =
    "Delete element: Click a spot or drag over lines/shapes to remove only those drawn elements (e.g. one line or one shape), not a whole region.";

  return (
    <header className="flex flex-col gap-1.5 border-b shrink-0 px-2.5 py-2 bg-muted/30">
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <div className="flex items-center gap-1.5">
          <Link to="/editor" title="Back to editor" className={buttonVariants({ variant: "ghost", size: "icon", className: "h-7 w-7 shrink-0" })}>
            <ArrowLeft className="h-3.5 w-3.5" />
          </Link>
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
        <div className="flex items-center gap-1.5" role="group" aria-label="Tools" data-tour="stitch-tools">
          <IconButtonWithTooltip
            variant={!panMode && !contentDeleteMode && !deleteElementMode && !pointAlignMode && !scaleAlignMode ? "default" : "outline"}
            title="Select and move tiles (Ctrl+A: select all)"
            label="Select"
            onClick={onSelectToolActivate}
          >
            <MousePointer2 className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip variant={panMode ? "secondary" : "outline"} title="Pan canvas (Space: hold to pan)" label="Pan" onClick={() => onPanModeChange(!panMode)}>
            <Hand className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip
            variant={resizeLocked ? "secondary" : "outline"}
            title={resizeLocked
              ? "Resize locked — move only. If you resize tiles, the scale stamp cannot be used correctly."
              : "Resize unlocked — you can resize and rotate tiles. Resizing may make the scale stamp incorrect."}
            label={resizeLocked ? "Resize locked" : "Resize unlocked"}
            onClick={() => setResizeLocked(!resizeLocked)}
          >
            {resizeLocked ? (
              <span className="relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <X className="h-2.5 w-2.5 stroke-[2.5] text-destructive" strokeWidth={2.5} />
                </span>
              </span>
            ) : (
              <Maximize2 className="h-3.5 w-3.5 shrink-0" />
            )}
          </IconButtonWithTooltip>
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        {hasTiles && (
          <IconButtonWithTooltip variant="outline" title="Add PDF pages to the canvas" label="Add PDF" onClick={onAddPdf} data-tour="stitch-add-pdf">
            <FilePlus className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        )}
        {onClearSession && (
          <IconButtonWithTooltip variant="outline" title="Clear session and start fresh (removes all tiles, resets canvas)" label="Clear session" onClick={onClearSession}>
            <RotateCcw className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        )}
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-0.5" data-tour="stitch-delete-tools">
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
        </div>
        <div className="flex items-center gap-0.5" data-tour="stitch-align-tools">
        <IconButtonWithTooltip
          variant={pointAlignMode ? "secondary" : "outline"}
          title={canEnterPointAlign
            ? "One PDF is locked as reference. Align another PDF to it by selecting two point pairs (ref point 1 → target point 1, then ref point 2 → target point 2)."
            : "Point align is only available once you have locked a PDF in place. To lock a PDF: select the PDF — there is a LOCK icon in the top right of the PDF."}
          label="Point align"
          tooltipDescription={canEnterPointAlign
            ? "One PDF is locked. Align another by picking two point pairs (ref 1→target 1, ref 2→target 2)."
            : "Point align is only available once you have \"locked\" a PDF in place.\nTo lock a PDF: select the PDF — there is a LOCK icon in the top right of the PDF."}
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
          title={canEnterScaleAlign
            ? "One PDF is locked as reference. Resize another PDF to match its scale by drawing the same distance on both."
            : "Scale align is only available once you have locked a PDF in place. To lock a PDF: select the PDF — there is a LOCK icon in the top right of the PDF."}
          label="Scale align"
          tooltipDescription={canEnterScaleAlign
            ? "One PDF is locked. Resize another to match scale by drawing the same distance on both."
            : "Scale align is only available once you have \"locked\" a PDF in place.\nTo lock a PDF: select the PDF — there is a LOCK icon in the top right of the PDF."}
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
        </div>
        {onCleanup && (
          <IconButtonWithTooltip
            variant={cleanupActive ? "secondary" : "outline"}
            disabled={!hasTiles}
            title="Clean up: auto-detect title blocks and match-line margins to hide so the sheets read as one continuous drawing. Review the boxes, toggle any off, or draw your own, then Apply."
            label={cleanupActive ? "Reviewing…" : "Clean up"}
            tooltipDescription="Auto-detect title blocks & match-line margins to hide, so the sheets read as one continuous drawing. Review, toggle, or draw your own boxes, then Apply."
            onClick={onCleanup}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        )}
        <IconButtonWithTooltip variant="outline" title="Crop output to the bounding box of all tiles" label="Crop to content" onClick={onCropCanvas}>
          <Crop className="h-3.5 w-3.5 shrink-0" />
        </IconButtonWithTooltip>
        {cropRect && (
          <IconButtonWithTooltip variant="ghost" title="Remove crop" label="Clear crop" onClick={onClearCrop}>
            <X className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        )}
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-1" role="group" aria-label="Scale" data-tour="stitch-scale">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="Decrease scale (smaller)"
            aria-label="Decrease scale"
            onClick={() => handleScaleStep(-SCALE_STEP)}
          >
            <Shrink className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="Increase scale (bigger)"
            aria-label="Increase scale"
            onClick={() => handleScaleStep(SCALE_STEP)}
          >
            <Expand className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs tabular-nums w-10 text-center shrink-0" title="Current scale factor">
            {parseFloat(compositionScaleFactor.toFixed(2))}×
          </span>
          <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0" title="Reference scale: 1 inch = X feet">
            1&quot;=
          </span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="20"
            value={scaleInputValue}
            onChange={(e) => setScaleInputValue(e.target.value)}
            onFocus={() => setScaleInputFocused(true)}
            onBlur={() => {
              setScaleInputFocused(false);
              commitScaleInput();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            className="h-7 w-10 rounded border border-input bg-background px-1.5 text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Reference scale feet per inch (e.g. 20 for 1 inch = 20 feet)"
          />
          <span className="text-xs text-muted-foreground shrink-0">&#39;</span>
          {referenceScaleFeetPerInch != null && (
            <>
              <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0" title="Adjust composition so effective scale is 1 inch = X feet">
                Adjusted 1&quot;=
              </span>
              <input
                type="text"
                inputMode="numeric"
                placeholder={effectiveScaleFeetPerInch != null ? String(Math.round(effectiveScaleFeetPerInch)) : "20"}
                value={effectiveScaleInputValue}
                onChange={(e) => setEffectiveScaleInputValue(e.target.value)}
                onFocus={() => setEffectiveScaleInputFocused(true)}
                onBlur={() => {
                  setEffectiveScaleInputFocused(false);
                  commitEffectiveScaleInput();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                className="h-7 w-10 rounded border border-input bg-background px-1.5 text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label="Adjusted effective scale (e.g. 80 for 1 inch = 80 feet); scales the composition to match"
              />
              <span className="text-xs text-muted-foreground shrink-0">&#39;</span>
            </>
          )}
          <IconButtonWithTooltip
            variant="outline"
            disabled={referenceScaleFeetPerInch == null}
            title={referenceScaleFeetPerInch != null ? "Add scale bar stamp (current effective scale)" : "Set reference scale above first"}
            label="Scale stamp"
            onClick={handleAddScaleStamp}
          >
            <Stamp className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="flex items-center gap-0.5" role="group" aria-label="Selection" data-tour="stitch-selection-actions">
          <IconButtonWithTooltip variant="outline" disabled={tileCount === 0} title={tileCount === 0 ? "No pages on canvas" : "Select all pages (Ctrl+A)"} label="Select all" onClick={() => setSelectedTileIds(useStitchStore.getState().tiles.map((t) => t.id))}>
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
        </div>
        <div className="flex-1 min-w-2" />
        <div className="flex items-center gap-0.5" role="group" aria-label="Export" data-tour="stitch-export">
          <IconButtonWithTooltip variant="outline" disabled={isSaving || tileCount === 0} title="Download stitched PDF" label={isSaving ? "Saving…" : "Download"} onClick={() => onSaveAndFlatten(false)}>
            <Download className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          <IconButtonWithTooltip disabled={isSaving || tileCount === 0} title="Save PDF and open in editor" label={isSaving ? "Saving…" : "Save & open"} onClick={() => onSaveAndFlatten(true)}>
            <Save className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          {showSaveToCto && onSaveToCto && (
            <IconButtonWithTooltip variant="outline" disabled={isSaving || tileCount === 0} title="Save stitched PDF to Civiltakeoff" label="Save to Civiltakeoff" onClick={onSaveToCto}>
              <Upload className="h-3.5 w-3.5 shrink-0" />
            </IconButtonWithTooltip>
          )}
          {onDownloadForTraining && (
            <IconButtonWithTooltip
              variant="outline"
              disabled={isExportingTraining || tileCount === 0}
              title="Download training bundle (ZIP: controls JSON, tile PNGs, stitched PDF and PNG)"
              label={isExportingTraining ? "Exporting…" : "For training"}
              onClick={onDownloadForTraining}
            >
              <GraduationCap className="h-3.5 w-3.5 shrink-0" />
            </IconButtonWithTooltip>
          )}
        </div>
        <div className="h-5 w-px bg-border" aria-hidden />
        <div className="relative inline-flex">
          <IconButtonWithTooltip variant="outline" title="Need help? Take a guided tour of the stitch tools" label="Help" onClick={() => { nudgeDismissedRef.current = true; setShowHelpNudge(false); startTour("stitch"); }}>
            <HelpCircle className="h-3.5 w-3.5 shrink-0" />
          </IconButtonWithTooltip>
          {showHelpNudge && (
            <div className="absolute right-0 top-full mt-2 z-50 animate-in fade-in-0 slide-in-from-top-2 duration-300">
              <div className="relative bg-popover border border-border rounded-lg shadow-lg px-3 py-2 text-xs text-popover-foreground w-52">
                <div className="absolute -top-1.5 right-3 w-3 h-3 bg-popover border-l border-t border-border rotate-45" />
                <p className="font-medium mb-1">Need help getting started?</p>
                <p className="text-muted-foreground">Click here for a quick tour of all the stitch tools.</p>
                <button type="button" className="mt-1.5 text-primary hover:underline text-xs" onClick={() => { nudgeDismissedRef.current = true; setShowHelpNudge(false); }}>Dismiss</button>
              </div>
            </div>
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
