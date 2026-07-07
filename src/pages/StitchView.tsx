/**
 * Stitch View – combine multiple PDF pages into one stitched page.
 * Toolbar + pan/zoom canvas with tiles; Add PDF modal and save/open.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useStitchStore, type StitchTile, type CropRect } from "@/shared/stores/stitchStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useCtoStitchInitialStore } from "@/shared/stores/ctoStitchInitialStore";
import { StitchCanvas } from "@/features/stitch/StitchCanvas";
import { StitchToolbar } from "@/features/stitch/StitchToolbar";
import { StitchBottomToolbar } from "@/features/stitch/StitchBottomToolbar";
import { AddPdfModal } from "@/features/stitch/AddPdfModal";
import { useStitchKeyboard } from "@/features/stitch/useStitchKeyboard";
import { useStitchContentDelete } from "@/features/stitch/useStitchContentDelete";
import { usePointAlignMode } from "@/features/stitch/usePointAlignMode";
import { useScaleAlignMode } from "@/features/stitch/useScaleAlignMode";
import { exportStitchToPdf } from "@/features/stitch/stitchExport";
import { exportTrainingBundle } from "@/features/stitch/stitchTrainingExport";
import { detectCleanupForTiles } from "@/features/stitch/cleanup/cleanupRun";
import type { TileProposalUI } from "@/features/stitch/cleanup/CleanupReview";
import { hitTestTileAtPoint, canvasToTileLocal } from "@/features/stitch/stitchGeometry";
import type { CanvasRect } from "@/features/stitch/imageUtils";
import { usePDF } from "@/shared/hooks/usePDF";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePlus, Loader2 } from "lucide-react";
import { TourOverlay } from "@/features/tour/TourOverlay";
import { useTourStore } from "@/shared/stores/tourStore";

/** Shallow rect-list equality (order-sensitive) — used to skip a no-op store
 *  write for tiles whose hidden regions didn't actually change. */
function rectsEqual(
  a: Array<{ x: number; y: number; w: number; h: number }>,
  b: Array<{ x: number; y: number; w: number; h: number }> | undefined
): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h);
}

/** Render a tile-fraction sub-rect of a tile's image to a standalone PNG data URL
 *  (at the source image's resolution) — used to promote a relocated region into
 *  its own tile. Returns null if the tile has no image or the crop is empty. */
async function cropRegionToDataUrl(tile: StitchTile, rect: CropRect): Promise<string | null> {
  if (!tile.imageDataUrl) return null;
  const img = new Image();
  img.src = tile.imageDataUrl;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) return null;
  const sx = rect.x * iw, sy = rect.y * ih, sw = rect.w * iw, sh = rect.h * ih;
  if (sw < 1 || sh < 1) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export default function StitchView() {
  // Subscribe to the count only — tile content changes every drag frame and
  // would re-render the whole page (toolbars included) per frame.
  const tileCount = useStitchStore((s) => s.tiles.length);
  const setCropRect = useStitchStore((s) => s.setCropRect);
  const setCropToContent = useStitchStore((s) => s.setCropToContent);
  const setSelectedTileIds = useStitchStore((s) => s.setSelectedTileIds);
  const prevTileCountRef = useRef(0);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const handleRecenter = useCallback(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { canvasWidth, canvasHeight, zoomLevel, setPanOffset } = useStitchStore.getState();
    setPanOffset({
      x: (rect.width - canvasWidth * zoomLevel) / 2,
      y: (rect.height - canvasHeight * zoomLevel) / 2,
    });
  }, []);

  // Center the canvas in the viewport when first opening stitch mode
  useEffect(() => {
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) handleRecenter();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [handleRecenter]);

  // CTO stitch preload: when opened from CTO with stitch=1, open Add PDF modal with the initial PDF
  // so the user can choose which pages to add (instead of auto-adding all).
  const [ctoInitialPdf, setCtoInitialPdf] = useState<{ pdfBytes: Uint8Array; fileName: string } | null>(null);
  useEffect(() => {
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    const initial = useCtoStitchInitialStore.getState().takeInitial();
    if (ctx && initial) {
      setCtoInitialPdf({ pdfBytes: initial.pdfBytes, fileName: initial.fileName });
      setShowAddPdf(true);
    }
  }, []);

  const navigate = useNavigate();
  const { loadPDF } = usePDF();
  const { showNotification } = useNotificationStore();

  useStitchKeyboard();

  const [showAddPdf, setShowAddPdf] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveDialogIntent, setSaveDialogIntent] = useState<"download" | "open">("download");
  const [saveDialogFilename, setSaveDialogFilename] = useState("Stitched.pdf");
  const [showSaveToCtoDialog, setShowSaveToCtoDialog] = useState(false);
  const [saveToCtoNewFileName, setSaveToCtoNewFileName] = useState("Stitched.pdf");
  const [isSaving, setIsSaving] = useState(false);
  const [isExportingTraining, setIsExportingTraining] = useState(false);
  const [contentDeleteMode, setContentDeleteMode] = useState(false);
  const [deleteElementMode, setDeleteElementMode] = useState(false);
  const [panMode, setPanMode] = useState(false);
  const [canvasVisible, setCanvasVisible] = useState(true);
  const [cleanupReviewMode, setCleanupReviewMode] = useState(false);
  const [cleanupProposals, setCleanupProposals] = useState<TileProposalUI[]>([]);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  /** Leave clean-up review (no-op re-render when not in review). */
  const exitCleanupReview = useCallback(() => {
    setCleanupReviewMode(false);
    setCleanupProposals((p) => (p.length ? [] : p));
  }, []);

  // Entering the content/element erase tools exits clean-up review first.
  const handleContentDeleteModeChange = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      exitCleanupReview();
      setContentDeleteMode(v);
    },
    [exitCleanupReview]
  );
  const handleDeleteElementModeChange = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      exitCleanupReview();
      setDeleteElementMode(v);
    },
    [exitCleanupReview]
  );

  const ctoContext = useCiviltakeoffContextStore((s) => s.context);

  // Auto-launch the guided tour the first time a user imports a PDF into stitch mode
  useEffect(() => {
    const hadNoTiles = prevTileCountRef.current === 0;
    prevTileCountRef.current = tileCount;
    if (hadNoTiles && tileCount > 0 && !useTourStore.getState().hasCompletedTour("stitch")) {
      // Small delay so the canvas renders before the tour spotlight targets elements
      const timer = setTimeout(() => useTourStore.getState().startTour("stitch"), 500);
      return () => clearTimeout(timer);
    }
  }, [tileCount]);

  const pointAlign = usePointAlignMode();
  const scaleAlign = useScaleAlignMode();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pointAlign.pointAlignMode) pointAlign.cancelPointAlign();
      if (scaleAlign.scaleAlignMode) scaleAlign.cancelScaleAlign();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [pointAlign.pointAlignMode, pointAlign.cancelPointAlign, scaleAlign.scaleAlignMode, scaleAlign.cancelScaleAlign]);

  const {
    handleContentDeleteRect,
    handleDeleteElementAlongPath,
    erasedRegionFeedback,
    isDeletingAlongPath,
  } = useStitchContentDelete(showNotification);

  const handleCropCanvas = () => setCropToContent(10);
  const handleClearCrop = () => setCropRect(null);

  const handleClearSession = useCallback(() => {
    useStitchStore.getState().reset();
    setContentDeleteMode(false);
    setDeleteElementMode(false);
    setPanMode(false);
    pointAlign.setPointAlignMode(false);
    scaleAlign.setScaleAlignMode(false);
    exitCleanupReview();
  }, [pointAlign, scaleAlign, exitCleanupReview]);

  const handlePointAlignModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      setPanMode(false);
      scaleAlign.setScaleAlignMode(false);
      exitCleanupReview();
    }
    pointAlign.setPointAlignMode(active);
  };

  const handleScaleAlignModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      setPanMode(false);
      pointAlign.setPointAlignMode(false);
      exitCleanupReview();
    }
    scaleAlign.setScaleAlignMode(active);
  };

  const handlePanModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      pointAlign.setPointAlignMode(false);
      scaleAlign.setScaleAlignMode(false);
      exitCleanupReview();
    }
    setPanMode(active);
  };

  const handleSelectToolActivate = useCallback(() => {
    setPanMode(false);
    setContentDeleteMode(false);
    setDeleteElementMode(false);
    pointAlign.setPointAlignMode(false);
    scaleAlign.setScaleAlignMode(false);
    exitCleanupReview();
    setSelectedTileIds(useStitchStore.getState().tiles.map((t) => t.id));
  }, [setSelectedTileIds, exitCleanupReview]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        const target = document.activeElement as HTMLElement | null;
        const inInput =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.isContentEditable === true;
        if (inInput) return;
        e.preventDefault();
        e.stopPropagation();
        handleSelectToolActivate();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [handleSelectToolActivate]);

  // --- Clean-Composite (hide title blocks / match margins) ---
  const handleCleanup = useCallback(async () => {
    // Toolbar button toggles: a second click while reviewing cancels.
    if (cleanupReviewMode) {
      exitCleanupReview();
      return;
    }
    const reviewable = useStitchStore.getState().tiles.filter((t) => !t.isScaleStamp && !(t.rotation ?? 0));
    if (reviewable.length === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    // Clean-up is its own mode — turn the other tools off.
    setContentDeleteMode(false);
    setDeleteElementMode(false);
    setPanMode(false);
    pointAlign.setPointAlignMode(false);
    scaleAlign.setScaleAlignMode(false);
    setSelectedTileIds([]);
    setCleanupBusy(true);
    showNotification("Analyzing sheets for title blocks and match margins…", "info");
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      const proposals = await detectCleanupForTiles(mupdf, reviewable);
      // Fresh detections default to enabled — the user confirms by Applying,
      // toggling off any false positives. Merge in each tile's already-hidden
      // regions so a re-run never drops prior work (a manual box, or regions
      // applied from an earlier Clean-up pass), but skip any existing rect
      // that a fresh detection already covers so re-running doesn't duplicate
      // an already-applied region.
      const currentTiles = useStitchStore.getState().tiles;
      const ui: TileProposalUI[] = proposals.map((p) => {
        const fresh = p.regions.map((r) => ({ ...r, enabled: true }));
        const tile = currentTiles.find((t) => t.id === p.tileId);
        const existing = (tile?.hiddenRegions ?? [])
          .filter((rect) => !fresh.some((f) => rectsEqual([f.rect], [rect])))
          .map((rect) => ({
            rect: { ...rect },
            kind: "manual" as const,
            confidence: "high" as const,
            enabled: true,
          }));
        // Carry forward already-relocated regions so a re-run + Apply doesn't wipe them.
        const relocated = (tile?.relocatedRegions ?? []).map((r) => ({
          rect: { ...r.rect },
          kind: "manual" as const,
          confidence: "high" as const,
          enabled: true,
          move: { dx: r.dx, dy: r.dy },
        }));
        return { tileId: p.tileId, regions: [...fresh, ...existing, ...relocated] };
      });
      const freshTotal = proposals.reduce((s, p) => s + p.regions.length, 0);
      setCleanupProposals(ui);
      setCleanupReviewMode(true);
      showNotification(
        freshTotal > 0
          ? `Found ${freshTotal} region${freshTotal === 1 ? "" : "s"} to clean up. Toggle any off, draw a box to add, then Apply.`
          : "No title blocks or match margins detected. Draw a box to hide a region manually, then Apply.",
        "info"
      );
    } catch (e) {
      console.error(e);
      showNotification("Clean up couldn't analyze the sheets.", "error");
    } finally {
      setCleanupBusy(false);
    }
  }, [cleanupReviewMode, exitCleanupReview, showNotification, pointAlign, scaleAlign, setSelectedTileIds]);

  const handleToggleCleanupRegion = useCallback((tileId: string, index: number) => {
    setCleanupProposals((prev) =>
      prev.map((p) =>
        p.tileId === tileId
          ? { ...p, regions: p.regions.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)) }
          : p
      )
    );
  }, []);

  // Move/resize a proposed region (rect in tile-size fractions, 0..1).
  const handleUpdateCleanupRegion = useCallback(
    (tileId: string, index: number, rect: { x: number; y: number; w: number; h: number }) => {
      setCleanupProposals((prev) =>
        prev.map((p) =>
          p.tileId === tileId
            ? { ...p, regions: p.regions.map((r, i) => (i === index ? { ...r, rect } : r)) }
            : p
        )
      );
    },
    []
  );

  // Remove a proposed region entirely.
  const handleDeleteCleanupRegion = useCallback((tileId: string, index: number) => {
    setCleanupProposals((prev) =>
      prev.map((p) =>
        p.tileId === tileId ? { ...p, regions: p.regions.filter((_, i) => i !== index) } : p
      )
    );
  }, []);

  // Relocate a region's content (offset in tile fractions), or null to un-relocate.
  const handleRelocateCleanupRegion = useCallback(
    (tileId: string, index: number, move: { dx: number; dy: number } | null) => {
      setCleanupProposals((prev) =>
        prev.map((p) =>
          p.tileId === tileId
            ? { ...p, regions: p.regions.map((r, i) => (i === index ? { ...r, move: move ?? undefined } : r)) }
            : p
        )
      );
    },
    []
  );

  const handleCleanupManualBox = useCallback(
    (rect: CanvasRect) => {
      const tiles = useStitchStore.getState().tiles;
      const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const hit = hitTestTileAtPoint(center, tiles, true);
      if (!hit || hit.tile.isScaleStamp) {
        showNotification("Draw the box over a page to hide part of it.", "info");
        return;
      }
      const tile = hit.tile;
      // v1 does not clip rotated tiles (both preview and export skip them), so a
      // manual box on a rotated sheet would be stored but never take effect.
      // Refuse it up front instead of silently dropping a dead region.
      if ((tile.rotation ?? 0) !== 0) {
        useNotificationStore
          .getState()
          .showNotification("Rotate the sheet upright before cleaning it up", "info");
        return;
      }
      // Canvas rect → tile-local (rotation-aware); clamp inside the tile.
      const a = canvasToTileLocal({ x: rect.x, y: rect.y }, tile);
      const b = canvasToTileLocal({ x: rect.x + rect.w, y: rect.y + rect.h }, tile);
      if (!a || !b) return;
      const lx = Math.max(0, Math.min(a.u, b.u));
      const ly = Math.max(0, Math.min(a.v, b.v));
      const rx = Math.min(tile.width, Math.max(a.u, b.u));
      const ry = Math.min(tile.height, Math.max(a.v, b.v));
      if (rx - lx < 2 || ry - ly < 2) return;
      setCleanupProposals((prev) => {
        // Store as fractions (0..1) of the tile so the region survives resize /
        // composition-scale without recomputation.
        const region = {
          rect: {
            x: lx / tile.width,
            y: ly / tile.height,
            w: (rx - lx) / tile.width,
            h: (ry - ly) / tile.height,
          },
          kind: "manual" as const,
          confidence: "high" as const,
          enabled: true,
        };
        const idx = prev.findIndex((p) => p.tileId === tile.id);
        if (idx === -1) return [...prev, { tileId: tile.id, regions: [region] }];
        return prev.map((p, i) => (i === idx ? { ...p, regions: [...p.regions, region] } : p));
      });
    },
    [showNotification]
  );

  const handleCleanupApply = useCallback(async () => {
    const { applyCleanupPromotion, tiles } = useStitchStore.getState();
    const updates: { id: string; hiddenRegions: CropRect[] }[] = [];
    const newTiles: Omit<StitchTile, "id">[] = [];
    let hiddenTotal = 0, movedTotal = 0;
    for (const p of cleanupProposals) {
      const tile = tiles.find((t) => t.id === p.tileId);
      if (!tile) continue;
      const hiddenRects = p.regions.filter((r) => r.enabled && !r.move).map((r) => ({ ...r.rect }));
      const moved = p.regions.filter((r) => r.move);
      hiddenTotal += hiddenRects.length;
      // Promote each moved region to its own tile (raster crop at the destination)
      // and hide its source on the original sheet.
      for (const r of moved) {
        const crop = await cropRegionToDataUrl(tile, r.rect);
        if (!crop) continue;
        newTiles.push({
          sourcePdfBytes: new Uint8Array(0),
          sourcePageIndex: -1,
          x: tile.x + (r.rect.x + r.move!.dx) * tile.width,
          y: tile.y + (r.rect.y + r.move!.dy) * tile.height,
          width: r.rect.w * tile.width,
          height: r.rect.h * tile.height,
          imageDataUrl: crop,
          imageModified: true, // raster export path (no PDF source)
          rotation: 0,
        });
        movedTotal++;
      }
      const hidden = [...hiddenRects, ...moved.map((r) => ({ ...r.rect }))];
      const hiddenSame = rectsEqual(hidden, tile.hiddenRegions ?? []);
      if (!hiddenSame || (tile.relocatedRegions?.length ?? 0) > 0) {
        updates.push({ id: p.tileId, hiddenRegions: hidden });
      }
    }
    applyCleanupPromotion(updates, newTiles);
    setCleanupReviewMode(false);
    setCleanupProposals([]);
    const parts: string[] = [];
    if (hiddenTotal) parts.push(`hid ${hiddenTotal}`);
    if (movedTotal) parts.push(`relocated ${movedTotal} as movable ${movedTotal === 1 ? "object" : "objects"}`);
    showNotification(parts.length ? `Clean up: ${parts.join(" · ")}.` : "No changes applied.", "success");
  }, [cleanupProposals, showNotification]);

  // Escape cancels clean-up review.
  useEffect(() => {
    if (!cleanupReviewMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitCleanupReview();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [cleanupReviewMode, exitCleanupReview]);

  const cleanupHideCount = cleanupProposals.reduce(
    (s, p) => s + p.regions.filter((r) => r.enabled && !r.move).length,
    0
  );
  const cleanupMoveCount = cleanupProposals.reduce(
    (s, p) => s + p.regions.filter((r) => r.move).length,
    0
  );

  const handleSaveAndFlatten = (openInEditor: boolean) => {
    if (tileCount === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    setSaveDialogIntent(openInEditor ? "open" : "download");
    setSaveDialogFilename("Stitched.pdf");
    setSaveDialogOpen(true);
  };

  const ensurePdfExtension = (name: string) =>
    name.trim().toLowerCase().endsWith(".pdf") ? name.trim() : `${name.trim()}.pdf`;

  const doSaveAndFlatten = useCallback(
    async (openInEditor: boolean, filename: string) => {
      const name = ensurePdfExtension(filename) || "Stitched.pdf";
      setSaveDialogOpen(false);
      setIsSaving(true);
      try {
        const buffer = await exportStitchToPdf();
        if (!buffer) {
          showNotification("Export failed.", "error");
          return;
        }
        if (openInEditor) {
          const mupdf = await import("mupdf").then((m) => m.default);
          await loadPDF(buffer, name, mupdf, null);
          showNotification("Stitched PDF opened in editor.", "success");
          navigate("/editor");
        } else {
          const blob = new Blob([buffer as BlobPart], {
            type: "application/pdf",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
          URL.revokeObjectURL(url);
          showNotification("Stitched PDF downloaded.", "success");
        }
      } catch (e) {
        console.error(e);
        showNotification("Failed to export PDF.", "error");
      } finally {
        setIsSaving(false);
      }
    },
    [loadPDF, navigate, showNotification]
  );

  const handleSaveToCto = useCallback(() => {
    if (tileCount === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    const defaultName = ctx?.project_name?.trim()
      ? `${ctx.project_name.trim()} - Stitched`
      : "Stitched";
    setSaveToCtoNewFileName(defaultName);
    setShowSaveToCtoDialog(true);
  }, [tileCount, showNotification]);

  const doSaveToCto = useCallback(
    async (
      destination: "overwrite" | "new_file" | "project_page",
      displayName?: string
    ) => {
      const ctx = useCiviltakeoffContextStore.getState().getContext();
      if (!ctx) return;
      setShowSaveToCtoDialog(false);
      setIsSaving(true);
      try {
        const buffer = await exportStitchToPdf();
        if (!buffer) {
          showNotification("Export failed.", "error");
          return;
        }
        const copy = new Uint8Array(buffer.length);
        copy.set(buffer);
        const blob = new Blob([copy], { type: "application/pdf" });
        const formData = new FormData();
        formData.append("token", ctx.token);
        formData.append("file", blob, "stitched.pdf");
        formData.append("save_destination", destination);
        if (destination === "new_file" && displayName?.trim()) {
          formData.append("display_name", displayName.trim());
        }
        const res = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Save failed (${res.status})`);
        }
        showNotification("Saved to Civiltakeoff.", "success");
        if (typeof window !== "undefined" && window.opener) {
          try {
            window.opener.postMessage(
              { type: "nanodoc-stitch-saved", success: true },
              ctx.api_origin
            );
          } catch {
            // ignore
          }
        }
      } catch (e) {
        console.error(e);
        showNotification(
          e instanceof Error ? e.message : "Failed to save to Civiltakeoff.",
          "error"
        );
      } finally {
        setIsSaving(false);
      }
    },
    [showNotification]
  );

  const handleDownloadForTraining = async () => {
    if (tileCount === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    setIsExportingTraining(true);
    try {
      const zipBlob = await exportTrainingBundle();
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stitch-training-${ts}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification("Training bundle downloaded.", "success");
    } catch (e) {
      console.error(e);
      showNotification(e instanceof Error ? e.message : "Failed to export training bundle.", "error");
    } finally {
      setIsExportingTraining(false);
    }
  };

  const cropRect = useStitchStore((s) => s.cropRect);

  return (
    <div className="flex flex-col h-screen bg-background">
      <StitchToolbar
        onAddPdf={() => setShowAddPdf(true)}
        hasTiles={tileCount > 0}
        contentDeleteMode={contentDeleteMode}
        setContentDeleteMode={handleContentDeleteModeChange}
        deleteElementMode={deleteElementMode}
        setDeleteElementMode={handleDeleteElementModeChange}
        onCropCanvas={handleCropCanvas}
        onClearCrop={handleClearCrop}
        onSaveAndFlatten={handleSaveAndFlatten}
        isSaving={isSaving}
        onDownloadForTraining={handleDownloadForTraining}
        isExportingTraining={isExportingTraining}
        showSaveToCto={!!ctoContext}
        onSaveToCto={handleSaveToCto}
        cropRect={cropRect}
        pointAlignMode={pointAlign.pointAlignMode}
        canEnterPointAlign={pointAlign.canEnterPointAlign}
        onPointAlignModeChange={handlePointAlignModeChange}
        onPointAlignCancel={pointAlign.cancelPointAlign}
        pointAlignStep={pointAlign.step}
        scaleAlignMode={scaleAlign.scaleAlignMode}
        canEnterScaleAlign={scaleAlign.canEnterScaleAlign}
        onScaleAlignModeChange={handleScaleAlignModeChange}
        onScaleAlignCancel={scaleAlign.cancelScaleAlign}
        scaleAlignStep={scaleAlign.step}
        panMode={panMode}
        onPanModeChange={handlePanModeChange}
        onSelectToolActivate={handleSelectToolActivate}
        onClearSession={handleClearSession}
        onCleanup={handleCleanup}
        cleanupActive={cleanupReviewMode}
        cleanupBusy={cleanupBusy}
      />
      <main className="flex-1 min-h-0 overflow-hidden outline-none relative" tabIndex={0}>
        {tileCount === 0 && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-muted/50">
            <FilePlus className="h-16 w-16 text-muted-foreground mb-4" />
            <h2 className="text-2xl font-bold mb-2 text-foreground">Stitch PDFs Together</h2>
            <p className="text-sm text-muted-foreground mb-6 text-center max-w-md">
              Arrange multiple PDF pages onto one canvas — remove white backgrounds,
              resize, rotate, and export as a single PDF. Get started by selecting
              a PDF and choosing the pages you want to stitch.
            </p>
            <Button
              size="lg"
              className="h-14 px-8 text-lg gap-3 shadow-lg"
              onClick={() => setShowAddPdf(true)}
              data-tour="stitch-add-pdf"
            >
              <FilePlus className="h-7 w-7" />
              Add PDF
            </Button>
          </div>
        )}
        <StitchCanvas
          contentDeleteMode={contentDeleteMode}
          onContentDeleteRect={handleContentDeleteRect}
          deleteElementMode={deleteElementMode}
          onDeleteElementAlongPath={handleDeleteElementAlongPath}
          erasedRegionFeedback={erasedRegionFeedback}
          isDeletingAlongPath={isDeletingAlongPath}
          pointAlignMode={pointAlign.pointAlignMode}
          pointAlignReferenceId={pointAlign.referenceTileId}
          pointAlignTargetId={pointAlign.targetTileId}
          pointAlignStep={pointAlign.step}
          pointAlignPoints={pointAlign.points}
          onPointAlignClick={pointAlign.recordPoint}
          scaleAlignMode={scaleAlign.scaleAlignMode}
          scaleAlignReferenceId={scaleAlign.referenceTileId}
          scaleAlignTargetId={scaleAlign.targetTileId}
          scaleAlignStep={scaleAlign.step}
          scaleAlignPoints={scaleAlign.points}
          onScaleAlignClick={scaleAlign.recordPoint}
          panMode={panMode}
          canvasVisible={canvasVisible}
          forwardedContainerRef={canvasContainerRef}
          cleanupReviewMode={cleanupReviewMode}
          cleanupProposals={cleanupProposals}
          onToggleCleanupRegion={handleToggleCleanupRegion}
          onUpdateCleanupRegion={handleUpdateCleanupRegion}
          onDeleteCleanupRegion={handleDeleteCleanupRegion}
          onRelocateCleanupRegion={handleRelocateCleanupRegion}
          onCleanupManualBox={handleCleanupManualBox}
        />
        {cleanupBusy && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-[2px]" aria-live="polite" aria-busy="true">
            <div className="flex flex-col items-center gap-3 rounded-lg border bg-background px-5 py-4 shadow-lg">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-sm font-medium text-muted-foreground">Analyzing sheets…</span>
            </div>
          </div>
        )}
        {cleanupReviewMode && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium text-popover-foreground">
              Clean up: {cleanupHideCount} to hide{cleanupMoveCount ? ` · ${cleanupMoveCount} to relocate` : ""}
            </span>
            <span className="hidden sm:inline text-xs text-muted-foreground">Drag a box to relocate · click hide/keep · handles resize · ✕ delete · drag empty to add</span>
            <Button variant="ghost" size="sm" className="h-7" onClick={exitCleanupReview}>
              Cancel
            </Button>
            <Button size="sm" className="h-7" onClick={handleCleanupApply}>
              Apply
            </Button>
          </div>
        )}
      </main>
      <StitchBottomToolbar
        onRecenter={handleRecenter}
        canvasVisible={canvasVisible}
        onCanvasVisibleChange={setCanvasVisible}
      />
      <AddPdfModal
        open={showAddPdf}
        onClose={() => setShowAddPdf(false)}
        initialPdf={ctoInitialPdf}
        onInitialConsumed={() => setCtoInitialPdf(null)}
      />
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>
              {saveDialogIntent === "download" ? "Download PDF" : "Save & open in editor"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <label htmlFor="save-pdf-filename" className="text-sm font-medium">
              File name
            </label>
            <Input
              id="save-pdf-filename"
              value={saveDialogFilename}
              onChange={(e) => setSaveDialogFilename(e.target.value)}
              placeholder="Stitched.pdf"
              className="font-mono"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!saveDialogFilename.trim()}
              onClick={() => doSaveAndFlatten(saveDialogIntent === "open", saveDialogFilename)}
            >
              {saveDialogIntent === "download" ? "Download" : "Save & open"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showSaveToCtoDialog} onOpenChange={setShowSaveToCtoDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save to Civiltakeoff</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground pb-3">
            Choose how to save the stitched PDF in your project.
          </p>
          <div className="grid gap-2">
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => doSaveToCto("overwrite")}
            >
              Overwrite current file
            </Button>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => {
                  const name = saveToCtoNewFileName.trim() || "Stitched.pdf";
                  const finalName = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
                  doSaveToCto("new_file", finalName);
                }}
              >
                Save as new document
              </Button>
              <label className="text-xs text-muted-foreground pl-2">
                File name (you can edit)
              </label>
              <Input
                value={saveToCtoNewFileName}
                onChange={(e) => setSaveToCtoNewFileName(e.target.value)}
                placeholder="Project name - Stitched"
                className="font-mono text-sm"
              />
            </div>
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => doSaveToCto("project_page")}
            >
              Add as project page
            </Button>
          </div>
          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button variant="outline" onClick={() => setShowSaveToCtoDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TourOverlay tourId="stitch" />
    </div>
  );
}
