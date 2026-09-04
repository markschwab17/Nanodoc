/**
 * Stitch View – combine multiple PDF pages into one stitched page.
 * Toolbar + pan/zoom canvas with tiles; Add PDF modal and save/open.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useStitchStore, selectEffectiveMinZoom, tileRasterUrl, type StitchTile, type CropRect } from "@/shared/stores/stitchStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useCtoStitchInitialStore } from "@/shared/stores/ctoStitchInitialStore";
import { postToCto } from "@/shared/ctoBridge";
import { StitchCanvas } from "@/features/stitch/StitchCanvas";
import { StitchToolbar } from "@/features/stitch/StitchToolbar";
import { StitchBottomToolbar } from "@/features/stitch/StitchBottomToolbar";
import { AddPdfModal } from "@/features/stitch/AddPdfModal";
import { commitPlainAdd, type CommitResult } from "@/features/stitch/commitPages";
import { parseStitchPlan } from "@/features/stitch/stitchPlan";
import { autoAlignExplanation } from "@/features/stitch/addToProjectCopy";
import { TakeoffModeStrip } from "@/features/stitch/TakeoffModeStrip";
import { useEarnedAutoAlign } from "@/features/stitch/useEarnedAutoAlign";
import { AlignCoachMark } from "@/features/stitch/AlignCoachMark";
import { AddToProjectDialog } from "@/features/stitch/AddToProjectDialog";
import { planEntriesForTiles } from "@/features/stitch/addToProjectCopy";
import { STITCH_SESSION_LOST, isStitchSessionLost } from "@/features/stitch/ctoSessionSource";
import { shutdownOcr } from "@/features/stitch/autostitch/ocrService";
import { disposeRasterEncoder } from "@/features/stitch/rasterEncode";
import { AutoStitchAborted } from "@/features/stitch/autostitch/autoStitch";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { isTypingTarget, useStitchKeyboard } from "@/features/stitch/useStitchKeyboard";
import { useStitchContentDelete } from "@/features/stitch/useStitchContentDelete";
import { usePointAlignMode } from "@/features/stitch/usePointAlignMode";
import { useScaleAlignMode } from "@/features/stitch/useScaleAlignMode";
import { useAlignToNeighbour } from "@/features/stitch/useAlignToNeighbour";
import { exportStitchToPdf } from "@/features/stitch/stitchExport";
import { buildStitchManifest } from "@/features/stitch/stitchManifest";
import { exportTrainingBundle } from "@/features/stitch/stitchTrainingExport";
import { detectCleanupForTiles } from "@/features/stitch/cleanup/cleanupRun";
import type { TileProposalUI } from "@/features/stitch/cleanup/CleanupReview";
import { hitTestTileAtPoint, canvasToTileLocal, contentBounds, fitZoomFor } from "@/features/stitch/stitchGeometry";
import { MAX_ZOOM, RULER_SIZE } from "@/features/stitch/stitchConstants";
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
import { AlertTriangle, FilePlus, Loader2, X } from "lucide-react";
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
  const src = tileRasterUrl(tile);
  if (!src) return null;
  const img = new Image();
  img.src = src;
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

  /**
   * Zoom-to-fit: pick the zoom at which the whole composition (page rect UNION every tile,
   * placed sheets outside the page included) fits the viewport, then centre it. It used to
   * only centre at the CURRENT zoom, which on a plan set spilling off an 8.5×11 default left
   * most of the sheets off screen with no obvious way back to them.
   */
  const handleRecenter = useCallback(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const state = useStitchStore.getState();
    const bounds = contentBounds(state.tiles, state.canvasWidth, state.canvasHeight);
    // Work in the scaled layer's own coordinates, where a canvas point sits at
    // point + RULER_SIZE and screen = panOffset + inner * zoom. The rulers occupy
    // inner [0, RULER_SIZE] above and left of the page, so they must be inside the fitted
    // extent too — otherwise a fit that hugs the content clips them off the edge.
    const innerMinX = Math.min(0, bounds.x + RULER_SIZE);
    const innerMinY = Math.min(0, bounds.y + RULER_SIZE);
    const innerBounds = {
      x: innerMinX,
      y: innerMinY,
      width: bounds.x + bounds.width + RULER_SIZE - innerMinX,
      height: bounds.y + bounds.height + RULER_SIZE - innerMinY,
    };
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(selectEffectiveMinZoom(state), fitZoomFor(innerBounds, rect.width, rect.height))
    );
    state.setZoomLevel(zoom);
    state.setPanOffset({
      x: rect.width / 2 - (innerBounds.x + innerBounds.width / 2) * zoom,
      y: rect.height / 2 - (innerBounds.y + innerBounds.height / 2) * zoom,
    });
  }, []);

  /**
   * Zoom-to-fit as soon as the viewport HAS a size.
   *
   * `handleRecenter` measures the container and gives up when it is 0x0, and twice in
   * the browser the editor opened at 100% on a 4-sheet plan because that is exactly
   * what happened: the two-frame wait after the commit fired while the CTO panel (an
   * iframe that animates in) was still unmeasured, the fit bailed, and nothing tried
   * again — leaving the zoom the empty-canvas fit had set on mount.
   *
   * So the fit RETRIES: up to `maxFrames` animation frames waiting for a measurable
   * container, then a one-shot ResizeObserver for the case where the panel takes
   * longer than that (a slow animation, a tab opened in the background). Returns a
   * cancel function; calling it twice is safe.
   */
  const fitWhenMeasured = useCallback((maxFrames = 10) => {
    let raf = 0;
    let frames = 0;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    const measured = () => {
      const rect = canvasContainerRef.current?.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.height > 0;
    };
    const stop = () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      observer?.disconnect();
      observer = null;
    };
    const attempt = () => {
      if (cancelled) return;
      if (measured()) {
        handleRecenter();
        stop();
        return;
      }
      if (++frames <= maxFrames) {
        raf = requestAnimationFrame(attempt);
        return;
      }
      // Out of frames and still unmeasured: wait for the size to arrive instead of
      // spinning. One shot — the fit is a first-paint decision, not a live behaviour.
      const el = canvasContainerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      observer = new ResizeObserver(() => {
        if (!measured()) return;
        handleRecenter();
        stop();
      });
      observer.observe(el);
    };
    raf = requestAnimationFrame(attempt);
    return stop;
  }, [handleRecenter]);

  // Leaving stitch ends the session's worker budget: the PNG encode worker and
  // tesseract's scheduler both survive individual commits on purpose (they are
  // reused across them) and both rebuild lazily, so releasing them here costs
  // the next session one spawn and frees 160-240 MB plus a worker realm now.
  useEffect(() => () => {
    disposeRasterEncoder();
    void shutdownOcr();
  }, []);

  // Center the canvas in the viewport when first opening stitch mode
  useEffect(() => fitWhenMeasured(), [fitWhenMeasured]);

  // CTO stitch preload: when opened from CTO with stitch=1, either commit the sheets
  // straight onto the canvas (CTO sent a stitch plan) or open the Add PDF modal on the
  // initial PDF so the user picks the pages themselves (no plan / the plan failed).
  const [ctoInitialPdf, setCtoInitialPdf] = useState<{ pdfBytes: Uint8Array; fileName: string } | null>(null);
  // Kept for the life of the stitch session (unlike ctoInitialPdf, which is consumed once the
  // modal loads it) so "From Civiltakeoff" can still offer the site-sheet source after the user
  // switches tabs and loads a different project document.
  const [sessionSourcePdf, setSessionSourcePdf] = useState<{ pdfBytes: Uint8Array; fileName: string } | null>(null);
  /** The RAW stitch plan CTO sent, kept for the whole session (the initial store
   *  hands it over exactly once). The Add-to-project dialog reads each entry's
   *  label and page number out of it to preview what the save will create —
   *  see `planEntriesForTiles`. Unparsed here for the same reason the store
   *  keeps it unparsed: only the commit path validates it against a document. */
  const [stitchPlanRaw, setStitchPlanRaw] = useState<unknown>(null);
  /** Sheets the last auto-align run could not place. Drives the step strip's
   *  "· K need placing" and the coach mark; zeroed when the mark is dismissed. */
  const [unplacedCount, setUnplacedCount] = useState(0);
  const [alignExplanation, setAlignExplanation] = useState<string | null>(null);
  const [coachDismissed, setCoachDismissed] = useState(false);
  const [showAddToProject, setShowAddToProject] = useState(false);
  /** Persistent "Add to project" failure. A toast alone left the user back on the
   *  canvas with the dialog gone and no surviving explanation, so the reason also
   *  stays pinned under the step strip until they retry or dismiss it. */
  const [addToProjectError, setAddToProjectError] = useState<string | null>(null);
  /** Non-null while a CTO stitch plan is being committed — drives the entry
   *  overlay. `done/total` is the commit's own page progress. The plan path always
   *  PLACES (a grid) now; aligning is the earned button's job and has its own
   *  overlay, so there is no longer a mode to say. */
  const [planRun, setPlanRun] = useState<{
    done: number;
    total: number;
    cancelling: boolean;
  } | null>(null);
  /** Flipped by the overlay's Cancel button; the commit polls it between page
   *  renders (and hands it to the solver) and throws AutoStitchAborted. */
  const planAbortRef = useRef(false);
  /** True when this embedded session has no handoff to work from — the iframe was
   *  reloaded and the source PDF, which only ever lived in memory, is gone. */
  const [sessionLost, setSessionLost] = useState(false);
  /** Set the instant a handoff is taken, so StrictMode's second effect pass (which
   *  finds the store already drained) does not read the first pass's work as a lost
   *  session. */
  const receivedInitialRef = useRef(false);

  /**
   * What an auto-align run — the earned button's, or the Add PDF modal's — leaves
   * behind: the strip's "needs placing" count and the coach mark's explanation of WHY
   * anything was held back. Shared so both paths describe the LAST run identically.
   */
  const handleAlignResult = useCallback(
    (result: CommitResult) => {
      setUnplacedCount(result.unalignedIds.length);
      // Nothing to explain when the run was clean AND nothing was held back — the mark
      // would then be pure noise on a successful align. Page numbers are 1-based.
      const worthExplaining = result.reason && (result.reason !== "ok" || result.unalignedIds.length > 0);
      setAlignExplanation(
        autoAlignExplanation(
          worthExplaining
            ? {
                reason: result.reason!,
                pagesWithoutRefs: (result.pagesWithoutRefs ?? []).map((i) => i + 1),
                skipped: (result.skipped ?? []).map((s) => ({ pageNumber: s.pageIndex + 1, role: s.role })),
                worstAlongUncertaintyFt: result.worstAlongUncertaintyFt,
                // Without the SOURCE the copy cannot tell a measured slide from the
                // geometric bound, and would read "up to 720 ft" of an unknown.
                worstAlongUncertaintySource: result.worstAlongUncertaintySource,
                // From the commit, which knows which pages it actually PLACED —
                // subtracting the anchored set from the whole plan named pages the run
                // never touched as "meeting the matchline".
                alongUnresolvedPages: result.alongUnresolvedPages?.map((i) => i + 1),
              }
            : null,
        ),
      );
      setCoachDismissed(false);
      if (result.message) {
        useNotificationStore
          .getState()
          .showNotification(result.message, result.unalignedIds.length > 0 ? "info" : "success");
      }
      fitWhenMeasured();
    },
    [fitWhenMeasured],
  );

  /** The background feasibility check behind the step strip's Auto-align offer. */
  const earned = useEarnedAutoAlign({
    onAligned: handleAlignResult,
    onError: (message) => useNotificationStore.getState().showNotification(message, "error"),
  });
  const earnedCheck = earned.check;

  /** The revamped manual align. Owns its own overlay, loupe and keyboard. */
  const alignNeighbour = useAlignToNeighbour();
  const alignNeighbourExit = alignNeighbour.exit;
  /** Read by the select-all listener, which is installed once. */
  const alignNeighbourActiveRef = useRef(alignNeighbour.active);
  alignNeighbourActiveRef.current = alignNeighbour.active;
  const earnedReset = earned.reset;
  useEffect(() => {
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    const initial = useCtoStitchInitialStore.getState().takeInitial();
    if (!ctx || !initial) {
      // Nothing was handed over. Inside the CTO panel that is a RELOADED IFRAME, not a
      // fresh standalone visit: the source PDF lived in memory and went with it, so the
      // "Stitch PDFs Together / Add PDF" hero would invite a session CTO can never save
      // back. Say what happened instead.
      const tiles = useStitchStore.getState().tiles.filter((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
      setSessionLost(
        isStitchSessionLost({
          embed: !!ctx?.embed,
          hasInitial: receivedInitialRef.current,
          tileCount: tiles.length,
          busy: false,
        }),
      );
      return;
    }
    receivedInitialRef.current = true;
    setSessionLost(false);
    const source = { pdfBytes: initial.pdfBytes, fileName: initial.fileName };
    setSessionSourcePdf(source);
    // Retained even when the plan turns out to be unusable and the picker opens
    // instead: `planEntriesForTiles` re-validates it and yields nothing for a
    // plan it can't read, so the dialog degrades to its count-only copy.
    setStitchPlanRaw(initial.plan ?? null);

    // No plan — an older CTO build, or a source it can't describe. Unchanged
    // behaviour: the page picker opens on the source PDF and the user chooses.
    if (initial.plan == null) {
      setCtoInitialPdf(source);
      setShowAddPdf(true);
      return;
    }

    // Re-entry guard. Browser Back inside the CTO iframe re-runs CiviltakeoffView
    // with the same token, which re-seeds the store and remounts this view — but
    // the stitch store outlives that, so committing again would duplicate every
    // sheet on top of the ones already placed. Sheets on the canvas means this
    // plan has already run: keep the canvas exactly as the user left it (the
    // session source is set above, so "From Civiltakeoff" still offers it).
    const alreadyStitched = useStitchStore
      .getState()
      .tiles.some((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
    if (alreadyStitched) return;

    /** Hand the source to the picker — exactly what a planless open does. Used
     *  for an unusable plan, for a cancelled run, and for a commit that threw. */
    const fallBackToPicker = () => {
      setPlanRun(null);
      setCtoInitialPdf(source);
      setShowAddPdf(true);
    };

    // Deliberately NO cancellation token / cleanup: under StrictMode this effect
    // mounts twice, and a cleanup that aborted the first run would abort the ONLY
    // run — the second pass finds `takeInitial()` already drained and returns early
    // (which is also what stops a double commit). A real unmount mid-run is safe
    // instead: the tiles land in the global stitch store either way, the setState
    // calls below are no-ops on an unmounted tree, and `handleRecenter` bails when
    // its container ref is gone.

    (async () => {
      let doc: any = null;
      let renderer: PDFRenderer | null = null;
      try {
        // Inside the try: a chunk-load failure here is as recoverable as any
        // other — toast, then the picker.
        const mupdf = await import("mupdf").then((m) => m.default);
        // ONE document for the whole run: the plan is validated against this
        // doc's real page count and the commit renders from the same handle.
        doc = mupdf.Document.openDocument(source.pdfBytes, "application/pdf");
        const parsed = parseStitchPlan(initial.plan, doc.countPages());
        if (!parsed) {
          fallBackToPicker();
          return;
        }
        planAbortRef.current = false;
        setPlanRun({ done: 0, total: parsed.pageIndices.length, cancelling: false });
        renderer = new PDFRenderer(mupdf);
        const input = {
          mupdf,
          doc,
          pdfBytes: source.pdfBytes,
          fileName: source.fileName || undefined,
          selected: parsed.pageIndices,
          pageScales: parsed.pageScales,
          uniformScale: parsed.uniformScale,
          // The Add PDF modal's own default, so a plan-driven open and a
          // hand-picked one produce identical tiles.
          removeWhiteBackground: true,
          renderer,
          // Monotonic: the callback is fed from more than one phase, so a raw
          // assignment would visibly restart the counter halfway through.
          onProgress: (done: number, total: number) =>
            setPlanRun((p) => (p ? { ...p, done: Math.max(p.done, done), total } : p)),
          shouldAbort: () => planAbortRef.current,
        };
        // ALWAYS the grid, whatever the plan says. Auto-align is EARNED: the sheets
        // have to be on screen and draggable within a frame of the commit, and the
        // probe that decides whether they CAN be aligned runs behind them. A legacy
        // plan carrying `mode: 'auto'` takes this path too — a plan is not allowed to
        // skip the gate, only the gate can.
        const result = await commitPlainAdd(input);
        setPlanRun(null);
        // A grid placement holds nothing back and has nothing to explain; the coach
        // mark speaks only for an ALIGN run (see handleAlignResult).
        setUnplacedCount(0);
        setAlignExplanation(null);
        useNotificationStore
          .getState()
          .showNotification(`Placed ${result.added} sheet${result.added === 1 ? "" : "s"}.`, "success");
        // A plan commit always re-fits the paper to the sheets it just placed — that is
        // the whole point of the plan path, and it is what stops a plan set from landing
        // mostly off an 8.5×11 default. (commitPages already does this when the user has
        // not chosen a size; this call covers the case where they have. It is idempotent.)
        useStitchStore.getState().fitCanvasToTiles();
        // The first paint of a plan open MUST be zoom-to-fit. The tiles are already in
        // the store (the fit reads them from there, not from the DOM), so the only
        // thing to wait for is a measurable viewport — which in the CTO panel can be a
        // few frames away. `fitWhenMeasured` waits for it instead of giving up.
        fitWhenMeasured();
        // Start the background check. It reads the sheets straight off the canvas and
        // runs in the probe worker, so the canvas above stays interactive the whole
        // time; the strip shows a chip and, if the check clears the gate, an Auto-align
        // button. All the check needs from HERE is what the canvas cannot tell it:
        // CTO's sheet identity for these pages. Only in the embedded takeoff flow — the
        // step strip is the only surface the offer has, and a probe nobody can see is
        // pure cost.
        if (!ctx.embed) return;
        earnedCheck({ pageCodes: parsed.pageCodes, removeWhiteBackground: true });
      } catch (e) {
        // Cancelled by the user: the commit threw before writing anything, so
        // the canvas is untouched. No error copy — just hand them the picker.
        if (e instanceof AutoStitchAborted) {
          fallBackToPicker();
          return;
        }
        console.error(e);
        useNotificationStore
          .getState()
          .showNotification("Could not place the sheets automatically — pick them below.", "error");
        fallBackToPicker();
      } finally {
        renderer?.dispose();
        // NO shutdownOcr here any more: the grid placement never OCRs, and the
        // background check started just above is about to need the scheduler. The
        // check hands tesseract back itself when it finishes or is superseded.
        try {
          doc?.destroy?.();
        } catch {
          // already freed
        }
      }
    })();
  }, [fitWhenMeasured, earnedCheck]);

  const navigate = useNavigate();
  const { loadPDF } = usePDF();
  const { showNotification } = useNotificationStore();

  // While Align to neighbour is up the moving sheet is the selection, so Delete would
  // delete the sheet being aligned and Ctrl+A would select all of them out from under
  // the mode. Nudges stay — they are the mode's own fine adjustment.
  useStitchKeyboard({ selectionEditsDisabled: alignNeighbour.active });

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
      alignNeighbourExit();
      setContentDeleteMode(v);
    },
    [exitCleanupReview, alignNeighbourExit]
  );
  const handleDeleteElementModeChange = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      exitCleanupReview();
      alignNeighbourExit();
      setDeleteElementMode(v);
    },
    [exitCleanupReview, alignNeighbourExit]
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
    disposeRasterEncoder();
    setContentDeleteMode(false);
    setDeleteElementMode(false);
    setPanMode(false);
    pointAlign.setPointAlignMode(false);
    scaleAlign.setScaleAlignMode(false);
    alignNeighbourExit();
    exitCleanupReview();
    // The canvas the offer described is gone.
    earnedReset();
  }, [pointAlign, scaleAlign, exitCleanupReview, alignNeighbourExit, earnedReset]);

  /** Every auto-align run reports here, whether it came from the CTO plan or
   *  from the Add PDF modal, so the strip and the coach mark always describe the
   *  LAST run rather than only the one that opened the session. */
  const handleAutoAlignResult = useCallback((unalignedCount: number) => {
    setUnplacedCount(unalignedCount);
    setCoachDismissed(false);
    // The modal aligned these sheets itself, so whatever the strip was offering is
    // spent — it described a canvas that no longer exists.
    earnedReset();
  }, [earnedReset]);

  /**
   * A PLAIN add from the Add PDF modal. The new sheets are on the canvas and nothing
   * has decided whether they can be auto-aligned, so re-probe: the strip's offer, if
   * any, was about the sheets that were there before. Only in takeoff mode — the
   * strip is the only place the offer appears.
   */
  const handlePagesAdded = useCallback(() => {
    if (!useCiviltakeoffContextStore.getState().context?.embed) return;
    setUnplacedCount(0);
    setAlignExplanation(null);
    // Over the WHOLE canvas, plan sheets and new ones together. Probing only the
    // pages just added would offer a button that lays a second composite at the
    // origin, on top of the grid the plan left behind.
    earnedCheck();
  }, [earnedCheck]);

  const handlePointAlignModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      setPanMode(false);
      scaleAlign.setScaleAlignMode(false);
      alignNeighbourExit();
      exitCleanupReview();
    }
    pointAlign.setPointAlignMode(active);
  };

  /** "Align to neighbour" is a mode like any other: entering it clears the rest. */
  const handleAlignNeighbourModeChange = (active: boolean) => {
    if (!active) {
      alignNeighbourExit();
      return;
    }
    setContentDeleteMode(false);
    setDeleteElementMode(false);
    setPanMode(false);
    pointAlign.setPointAlignMode(false);
    scaleAlign.setScaleAlignMode(false);
    exitCleanupReview();
    alignNeighbour.enter();
  };

  const handleScaleAlignModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      setPanMode(false);
      pointAlign.setPointAlignMode(false);
      alignNeighbourExit();
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
      alignNeighbourExit();
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
    alignNeighbourExit();
    exitCleanupReview();
    setSelectedTileIds(useStitchStore.getState().tiles.map((t) => t.id));
  }, [setSelectedTileIds, exitCleanupReview, alignNeighbourExit]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (isTypingTarget()) return;
        // Select-all would drop the mode's own selection (the sheet being moved) and
        // switch tools out from under it.
        if (alignNeighbourActiveRef.current) return;
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
    // Only sheets with a PDF source get analyzed — skip scale stamps, rotated
    // tiles (v1), and promoted note tiles (no source, would fail to capture).
    const reviewable = useStitchStore
      .getState()
      .tiles.filter((t) => !t.isScaleStamp && !(t.rotation ?? 0) && t.sourcePdfBytes.length > 0);
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
    alignNeighbourExit();
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
  }, [cleanupReviewMode, exitCleanupReview, showNotification, pointAlign, scaleAlign, alignNeighbourExit, setSelectedTileIds]);

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

  const handleCancel = useCallback(() => {
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    postToCto({ type: "nanodoc-stitch-cancel" }, ctx?.api_origin);
  }, []);

  const handleSaveToCto = useCallback(() => {
    if (tileCount === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    // Takeoff-v2 mode has exactly one destination — a new project page — so it
    // skips the where-to-save dialog and confirms WHAT will be created instead.
    if (ctx?.embed) {
      // Re-entering the flow retires the previous failure notice.
      setAddToProjectError(null);
      setShowAddToProject(true);
      return;
    }
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
    ): Promise<{ ok: boolean; message?: string }> => {
      const ctx = useCiviltakeoffContextStore.getState().getContext();
      if (!ctx) return { ok: false, message: "Not connected to Civiltakeoff." };
      setShowSaveToCtoDialog(false);
      setIsSaving(true);
      try {
        const buffer = await exportStitchToPdf();
        if (!buffer) {
          showNotification("Export failed.", "error");
          return { ok: false, message: "Export failed." };
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
        const manifest = buildStitchManifest();
        if (destination === "project_page") {
          formData.append("stitch_manifest", JSON.stringify(manifest));
        }
        const res = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Save failed (${res.status})`);
        }
        const resultJson = await res.json().catch(() => null);
        const pageUuid =
          resultJson && typeof resultJson === "object" && typeof (resultJson as { pageUuid?: unknown }).pageUuid === "string"
            ? (resultJson as { pageUuid: string }).pageUuid
            : null;
        showNotification("Saved to Civiltakeoff.", "success");
        postToCto(
          { type: "nanodoc-stitch-saved", success: true, destination, manifest, pageUuid },
          ctx.api_origin
        );
        return { ok: true };
      } catch (e) {
        console.error(e);
        const message =
          e instanceof Error && e.message ? e.message : "Failed to save to Civiltakeoff.";
        showNotification(message, "error");
        return { ok: false, message };
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
  const referenceScaleFeetPerInch = useStitchStore((s) => s.referenceScaleFeetPerInch);
  const compositionScaleFactor = useStitchStore((s) => s.compositionScaleFactor);

  /** Takeoff-v2 mode: this view is the middle step of CTO's site-sheet builder
   *  rather than a standalone stitch session. */
  const takeoffMode = !!ctoContext?.embed;

  /** SHEETS on the canvas — what the user counts, and what CTO's manifest counts
   *  (`buildStitchManifest` uses this exact filter). Scale stamps and promoted
   *  clean-up crops carry `sourcePageIndex === -1` and are not sheets, so the
   *  raw tile count would over-report and would keep "Add to project" live on a
   *  canvas holding nothing but a stamp. `tileCount` is the trigger: the
   *  filtered count can only move when the tile array does. */
  const sheetTileCount = useMemo(
    () => useStitchStore.getState().tiles.filter((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp).length,
    [tileCount]
  );

  /** The scale the composed sheet actually reads at. Tile poses are POST-
   *  composition while `referenceScaleFeetPerInch` is the raw as-imported value,
   *  so a composite squeezed to 0.5 shows 1"=20' as 1"=40' — quoting the raw
   *  number here would contradict the sheet the user is about to create. Same
   *  derivation and rounding as the toolbar's "Adjusted 1"=" field. */
  const effectiveScaleFeetPerInch = useMemo(() => {
    if (referenceScaleFeetPerInch == null) return null;
    const factor =
      Number.isFinite(compositionScaleFactor) && compositionScaleFactor > 0 ? compositionScaleFactor : 1;
    const effective = Math.round(referenceScaleFeetPerInch / factor);
    return Number.isFinite(effective) && effective > 0 ? effective : null;
  }, [referenceScaleFeetPerInch, compositionScaleFactor]);

  /** What the Add-to-project dialog previews. Read straight from the store (not
   *  a subscription) and only while the dialog is open: the tiles change on
   *  every drag frame, and none of this needs to follow them — it is a snapshot
   *  of the moment the user asked to save. */
  const addToProjectSummary = useMemo(() => {
    const empty = { labels: [] as (string | null)[], hiddenPageNumbers: [] as number[] };
    if (!showAddToProject) return empty;
    const sheets = useStitchStore
      .getState()
      .tiles.filter((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
    // Only the plan's OWN sheets are described by the plan — a page the user
    // added later from another PDF shares nothing but an index with entry i.
    const entries = planEntriesForTiles(stitchPlanRaw, sheets, sessionSourcePdf?.fileName);
    const takeoffEntries = entries.filter((e) => e.kind === "takeoff");
    return {
      labels: takeoffEntries.map((e) => e.label),
      hiddenPageNumbers: takeoffEntries
        .map((e) => e.pageNumber)
        .filter((n): n is number => n != null),
    };
    // tileCount: a sheet added or removed while the dialog is open must change
    // the preview.
  }, [showAddToProject, stitchPlanRaw, sessionSourcePdf, tileCount]);

  return (
    <div className="flex flex-col h-screen bg-background">
      {takeoffMode && (
        <TakeoffModeStrip
          sheetCount={sheetTileCount}
          unplacedCount={unplacedCount}
          canAdd={sheetTileCount > 0 && !isSaving}
          onAddToProject={handleSaveToCto}
          autoAlign={{
            status: earned.status,
            sheets: earned.sheets,
            reason: earned.reason,
            detail: earned.detail,
            onRun: () => void earned.run(),
            onRecheck: earned.recheck,
          }}
        />
      )}
      {takeoffMode && addToProjectError && (
        <div
          role="alert"
          className="flex items-start gap-2 shrink-0 px-4 py-2 border-b border-destructive/30 bg-destructive/10 text-destructive text-xs"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          <span className="flex-1 leading-relaxed">
            Couldn't add to project: {addToProjectError}. Fix the sheets and try again.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 opacity-70 hover:opacity-100"
            onClick={() => setAddToProjectError(null)}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
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
        alignNeighbourMode={alignNeighbour.active}
        onAlignNeighbourModeChange={handleAlignNeighbourModeChange}
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
        embed={!!ctoContext?.embed}
        onCancel={handleCancel}
        takeoffMode={takeoffMode}
      />
      <main className="flex-1 min-h-0 overflow-hidden outline-none relative" tabIndex={0}>
        {tileCount === 0 && sessionLost && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-muted/50 px-6">
            <div className="max-w-sm rounded-lg border bg-background px-5 py-4 text-center shadow-sm">
              <p className="text-sm font-medium text-foreground">{STITCH_SESSION_LOST}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {tileCount === 0 && !sessionLost && (
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
          alignToNeighbour={alignNeighbour}
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
        {takeoffMode && (unplacedCount > 0 || alignExplanation) && !coachDismissed && !showAddToProject && !cleanupReviewMode && (
          <AlignCoachMark
            count={unplacedCount}
            explanation={alignExplanation}
            onDismiss={() => {
              setCoachDismissed(true);
              setUnplacedCount(0);
              setAlignExplanation(null);
            }}
          />
        )}
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
      {planRun && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex flex-col items-center gap-3 rounded-lg border bg-background px-8 py-6 shadow-lg">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm font-medium text-foreground">
              {`Placing ${planRun.total} sheet${planRun.total === 1 ? "" : "s"}…`}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {planRun.done} of {planRun.total} done
            </span>
            <Button
              variant="outline"
              size="sm"
              className="mt-1 h-7"
              disabled={planRun.cancelling}
              onClick={() => {
                // The commit only notices at its next checkpoint (after the page
                // it is mid-render on), so say so rather than looking inert.
                planAbortRef.current = true;
                setPlanRun((p) => (p ? { ...p, cancelling: true } : p));
              }}
            >
              {planRun.cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          </div>
        </div>
      )}
      {earned.status === "aligning" && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex flex-col items-center gap-3 rounded-lg border bg-background px-8 py-6 shadow-lg">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm font-medium text-foreground">
              {`Aligning ${earned.sheets} sheet${earned.sheets === 1 ? "" : "s"}…`}
            </span>
            {earned.progress && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {earned.progress.done} of {earned.progress.total} done
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-1 h-7"
              disabled={earned.cancelling}
              onClick={earned.cancelRun}
            >
              {earned.cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          </div>
        </div>
      )}
      <AddPdfModal
        open={showAddPdf}
        onClose={() => setShowAddPdf(false)}
        initialPdf={ctoInitialPdf}
        onInitialConsumed={() => setCtoInitialPdf(null)}
        sessionSourcePdf={sessionSourcePdf}
        onAutoAlignResult={handleAutoAlignResult}
        onPagesAdded={handlePagesAdded}
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
      {/* The where-to-save dialog is the NON-takeoff CTO session's save. Takeoff-v2
          mode has one destination and confirms with AddToProjectDialog instead. */}
      {!takeoffMode && (
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
      )}
      {takeoffMode && (
        <AddToProjectDialog
          open={showAddToProject}
          onOpenChange={setShowAddToProject}
          projectName={ctoContext?.project_name}
          labels={addToProjectSummary.labels}
          sheetCount={sheetTileCount}
          hiddenPageNumbers={addToProjectSummary.hiddenPageNumbers}
          effectiveScaleFeetPerInch={effectiveScaleFeetPerInch}
          busy={isSaving}
          onConfirm={() => {
            // Stays open, reading "Adding…", until the upload settles — closing
            // first would drop the user back on the canvas with no sign that
            // anything was happening. `doSaveToCto` never rejects; it reports
            // through its result, which decides whether a failure bar stays up.
            // Retrying retires the last failure notice before a new one can land.
            setAddToProjectError(null);
            void doSaveToCto("project_page")
              .then((r) => {
                // The dialog is gone by now, so an unexplained close is the one
                // thing the user must not be left with: pin the reason instead.
                if (!r.ok) setAddToProjectError(r.message ?? "Something went wrong");
              })
              .finally(() => setShowAddToProject(false));
          }}
        />
      )}
      <TourOverlay tourId="stitch" />
    </div>
  );
}
