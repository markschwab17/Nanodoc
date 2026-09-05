/**
 * Modal to add PDF pages to the stitch canvas: file picker, page selector, Add to canvas.
 *
 * Thumbnails are generated progressively — the page grid appears immediately
 * with placeholders, and each thumbnail streams in as it renders.  A progress
 * bar shows how many pages have been processed.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { attachOcrRpc, recognize, shutdownOcr } from "./autostitch/ocrService";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { resolveCtoTarget } from "@/shared/ctoBridge";
import type { ProbeResult, ProbeMessage, ProbeRequest } from "@/features/stitch/autostitch/stitchProbe";
import { deriveFeasibility } from "@/features/stitch/autostitch/feasibility";
import { layoutPlacements } from "@/features/stitch/autostitch/layout";
import { parseScaleInput, isUniform, DEFAULT_SCALE_FT_PER_IN } from "./pageScales";
import { SESSION_SOURCE_DOC_TYPE, withSessionSource } from "./ctoSessionSource";
import { commitPlainAdd, commitAutoAlign, imageDataToDataUrl, yieldToMain, type CachedProbePlacement } from "./commitPages";

const THUMB_SCALE = 0.3;

/** How long a page selection must hold still before the probe walks it. Long
 *  enough that ticking six boxes in a row starts one probe, short enough that a
 *  settled selection feels immediate. */
const PROBE_DEBOUNCE_MS = 400;

type SourceTab = "device" | "cto";

export function AddPdfModal({
  open,
  onClose,
  initialPdf,
  onInitialConsumed,
  sessionSourcePdf,
  onAutoAlignResult,
  onPagesAdded,
}: {
  open: boolean;
  onClose: () => void;
  initialPdf?: { pdfBytes: Uint8Array; fileName: string } | null;
  onInitialConsumed?: () => void;
  /** How many sheets the auto-align run could not place, reported after every
   *  "Add and auto-align" from this modal. In takeoff-v2 mode that number is the
   *  step strip's "need placing" count and the coach mark's badge — a run
   *  started HERE has to move them just as a plan-driven run does, or the strip
   *  goes on claiming everything is placed. */
  onAutoAlignResult?: (unalignedCount: number) => void;
  /** A PLAIN add landed: the pages are on the canvas but nothing has decided whether
   *  they can be aligned. The takeoff strip re-probes the WHOLE canvas — auto-align is
   *  earned, and the sheets it was last offered about are no longer what is there. No
   *  payload: the check reads the canvas itself, which is the only way the offer can
   *  cover plan sheets and added sheets as one composite. */
  onPagesAdded?: () => void;
  /** The site-sheet source PDF for the life of the stitch session (unlike `initialPdf`,
   *  which is consumed once). Offered as an extra entry in the "From Pursuit" list
   *  so switching to a project document doesn't lose the user's selected takeoff sheets. */
  sessionSourcePdf?: { pdfBytes: Uint8Array; fileName: string } | null;
}) {
  const fileSystem = useFileSystem();
  const ctoContext = useCiviltakeoffContextStore((s) => s.context);
  const [sourceTab, setSourceTab] = useState<SourceTab>("device");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");
  const [mupdfDoc, setMupdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  /** How many thumbnail pages have been rendered so far (for progress). */
  const [thumbProgress, setThumbProgress] = useState(0);
  const [adding, setAdding] = useState(false);
  /** Progress while adding pages to canvas. */
  const [addingProgress, setAddingProgress] = useState({ done: 0, total: 0 });
  const [removeWhiteBackground, setRemoveWhiteBackground] = useState(true);
  /** Scale when adding: feet per inch (e.g. 20 for 1"=20'). A typed value always wins
   *  as the commit's reference scale. Empty = don't override: a canvas that already
   *  has sheets keeps its own reference scale, and only an empty canvas falls back to
   *  the selection's own resolved scale (see `referenceBaseline`). */
  const [scaleFeetPerInch, setScaleFeetPerInch] = useState<string>("");
  /** Per-page scale text, keyed by page index; empty/absent = use the set scale above. */
  const [pageScaleText, setPageScaleText] = useState<Map<number, string>>(new Map());
  const pageScales = useMemo(() => {
    const m = new Map<number, number>();
    for (const [i, t] of pageScaleText) { const n = parseScaleInput(t); if (n != null) m.set(i, n); }
    return m;
  }, [pageScaleText]);
  const uniformScale = useMemo(() => parseScaleInput(scaleFeetPerInch), [scaleFeetPerInch]);
  /** The ticked pages, ascending. Drives the commit AND the feasibility probe. */
  const selectedIndices = useMemo(() => Array.from(selectedPages).sort((a, b) => a - b), [selectedPages]);
  const [_ctoListening, setCtoListening] = useState(false);
  /** User-visible error for failed loads/adds (corrupt file, password, etc). */
  const [loadError, setLoadError] = useState<string | null>(null);
  type CtoDoc = { type: string; displayName: string; token: string; fileId?: string; doc?: string };
  const [ctoDocuments, setCtoDocuments] = useState<CtoDoc[]>([]);
  const [ctoDocumentsLoading, setCtoDocumentsLoading] = useState(false);
  const [ctoDocumentsError, setCtoDocumentsError] = useState<string | null>(null);
  const ctoDocumentsRespondedRef = useRef(false);
  // The site-sheet source, kept selectable as the first "From Pursuit" entry for the
  // life of the stitch session — never sent to the CTO document-list request.
  const ctoDocumentsWithSession = useMemo(
    () => withSessionSource(ctoDocuments, sessionSourcePdf),
    [ctoDocuments, sessionSourcePdf]
  );
  /** Prevents the file-picker / initial-PDF effect from re-triggering after
   *  the first run within a single modal session (open→close cycle). */
  const hasTriggeredFileOpenRef = useRef(false);
  /** Generation counter for thumbnail streaming. A stale loop sees a newer
   *  generation and stops — unlike a shared boolean, this can't race when an
   *  old loop is parked inside an await while a new one starts. */
  const thumbGenRef = useRef(0);
  /** One renderer per modal session (no worker — main-thread renders only). */
  const rendererRef = useRef<PDFRenderer | null>(null);
  /** Mirror of mupdfDoc for cleanup — destroy frees its WASM memory. */
  const mupdfDocRef = useRef<any>(null);
  /** Background stitch probe: runs the real aligner once per loaded doc so the
   *  auto-align button reflects the ACTUAL outcome (see stitchProbe.worker.ts). */
  const probeWorkerRef = useRef<Worker | null>(null);
  /** Monotonic id; a probe reply whose docId != current is stale and ignored. */
  const probeDocIdRef = useRef(0);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeState, setProbeState] = useState<"idle" | "running" | "done" | "error" | "skipped">("idle");
  /** True once the probe reports OCR is in play (outlined-text sheets) — used to
   *  explain the longer wait in the "Checking alignment…" copy. */
  const [probeOcr, setProbeOcr] = useState(false);

  /** Pending debounce timer for the selection-driven probe (see the probe effect). */
  const probeTimerRef = useRef<number | null>(null);
  /** True between posting a ProbeRequest and its terminal reply — the debounce
   *  window is NOT in flight, so aborting there has nothing to abort. */
  const probeInFlightRef = useRef(false);

  /**
   * Stop whatever the probe is doing — the debounced request that has not been
   * posted yet AND the run already in the worker.
   *
   * `"skip"`   the user chose not to wait (Skip check / plain add): the run is
   *            aborted and reported as skipped, either by the worker's
   *            `{aborted:true}` reply or — when nothing had been posted yet —
   *            synchronously here, because no reply is coming.
   * `"supersede"` a NEW probe is about to replace this one (selection changed,
   *            new document, modal closed): the docId is bumped so the old run's
   *            reply, abort or result, is stale and ignored.
   */
  const stopProbe = useCallback((mode: "skip" | "supersede") => {
    if (probeTimerRef.current != null) {
      window.clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
    const inFlight = probeInFlightRef.current;
    if (inFlight) probeWorkerRef.current?.postMessage({ kind: "abort", docId: probeDocIdRef.current });
    probeInFlightRef.current = false;
    if (mode === "supersede") probeDocIdRef.current++;
    else if (!inFlight) setProbeState("skipped");
  }, []);

  /** Skip the check and move on (Skip check button, plain add). */
  const abortProbe = useCallback(() => stopProbe("skip"), [stopProbe]);

  const releaseDoc = useCallback(() => {
    try {
      mupdfDocRef.current?.destroy?.();
    } catch {
      // already freed
    }
    mupdfDocRef.current = null;
  }, []);

  // Free WASM resources if the component unmounts while open
  useEffect(
    () => () => {
      thumbGenRef.current++;
      releaseDoc();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    },
    [releaseDoc]
  );

  // One probe worker per component lifetime (the Stitch view keeps this modal mounted across open/close); terminated on unmount.
  useEffect(() => {
    const w = new Worker(new URL("./autostitch/stitchProbe.worker.ts", import.meta.url), { type: "module" });
    attachOcrRpc(w);
    w.onmessage = (ev: MessageEvent<ProbeMessage>) => {
      const msg = ev.data;
      // OCR-phase notice: the probe started reading outlined text (slow). ocr-req
      // frames are handled by attachOcrRpc; both carry a `kind`.
      if ((ev.data as any)?.kind === "ocrPhase") {
        if ((ev.data as any).docId === probeDocIdRef.current) setProbeOcr(true);
        return;
      }
      if ((ev.data as any)?.kind) return; // ocr-req frames are handled by attachOcrRpc
      // Nothing running and nothing queued means tesseract's 160-240 MB has no
      // more work: hand it back. `ensurePool` rebuilds it lazily if a
      // later probe needs it.
      const ocrIdle = () => probeTimerRef.current == null && !probeInFlightRef.current;
      if (msg.docId !== probeDocIdRef.current) {
        // A SUPERSEDED probe finishing. Usually a replacement is already in
        // flight or debounced — but not when the selection that superseded it
        // fell below two pages, and then nothing else will ever release OCR.
        if (ocrIdle()) void shutdownOcr();
        return; // stale — superseded by a newer selection or load
      }
      probeInFlightRef.current = false;
      if (ocrIdle()) void shutdownOcr();
      if ("aborted" in msg) {
        // Superseded by a plain add / Skip check — treat as a skipped check, no toast.
        setProbe(null);
        setProbeState("skipped");
        return;
      }
      if ("error" in msg) {
        console.warn("[stitchProbe] failed:", msg.error);
        setProbe(null);
        setProbeState("error");
        return;
      }
      console.debug("[stitchProbe] method", msg.method, "aligned", msg.alignedPageIndices.length, "/", msg.placements.length);
      setProbe(msg);
      setProbeState("done");
    };
    probeWorkerRef.current = w;
    return () => { w.terminate(); probeWorkerRef.current = null; void shutdownOcr(); };
  }, []);

  /**
   * The feasibility probe runs over the TICKED PAGES ONLY, debounced.
   *
   * `autoStitch` retains one `PageExtract` per page for the whole solve (~54 MB
   * average, 115 MB worst on a dense 36x24 in civil sheet), so the page count it
   * walks is the probe worker's memory. Probing a 22-page document to answer a
   * question about the 5 sheets the user ticked was ~1.1 GB for ~267 MB of
   * useful work, plus every unticked page's band OCR.
   *
   * Ticking is a rapid-fire interaction, so each change supersedes the last:
   * the in-flight run is aborted, the pending one is re-timed, and only a
   * selection that has settled for PROBE_DEBOUNCE_MS is actually probed. The
   * strip says "checking" from the first tick, not from the post, so the debounce
   * is invisible.
   */
  useEffect(() => {
    if (!pdfBytes || !mupdfDoc || pageCount === 0) return;
    stopProbe("supersede");
    setProbe(null);
    setProbeOcr(false);
    if (selectedIndices.length < 2) {
      setProbeState("idle");
      return;
    }
    setProbeState("running");
    const bytes = pdfBytes;
    const pages = selectedIndices;
    probeTimerRef.current = window.setTimeout(() => {
      probeTimerRef.current = null;
      probeInFlightRef.current = true;
      // userScale is null: placements are scale-invariant for a uniform set, so
      // the probe outcome is unaffected and the effect needs no scale dep.
      const req: ProbeRequest = {
        docId: probeDocIdRef.current,
        pdfBytes: bytes,
        pageIndices: pages,
        userScale: null,
      };
      probeWorkerRef.current?.postMessage(req);
    }, PROBE_DEBOUNCE_MS);
    return () => {
      if (probeTimerRef.current != null) {
        window.clearTimeout(probeTimerRef.current);
        probeTimerRef.current = null;
      }
    };
  }, [pdfBytes, mupdfDoc, pageCount, selectedIndices, stopProbe]);

  const togglePage = useCallback((i: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedPages(new Set(Array.from({ length: pageCount }, (_, i) => i)));
  }, [pageCount]);

  const selectNone = useCallback(() => {
    setSelectedPages(new Set());
  }, []);

  /** Load PDF from bytes + name into modal state.
   *  Shows the page grid immediately, then streams thumbnails progressively. */
  const loadPdfFromResult = useCallback(
    async (data: Uint8Array, name: string) => {
      // New generation — any in-flight thumbnail loop stops at its next check
      const gen = ++thumbGenRef.current;

      setLoading(true);
      setLoadError(null);
      setThumbnails({});
      setThumbProgress(0);
      try {
        const mupdf = await import("mupdf").then((m) => m.default);
        const doc = mupdf.Document.openDocument(data, "application/pdf");
        if (doc.needsPassword?.()) {
          doc.destroy?.();
          setLoadError(
            "This PDF is password-protected and can't be added here. Remove the password and try again."
          );
          setLoading(false);
          return;
        }
        const count = doc.countPages();
        // Replace the previous document and drop renders cached for it
        releaseDoc();
        mupdfDocRef.current = doc;
        rendererRef.current?.clearCache();
        setPdfBytes(data);
        setPdfFileName(name);
        setMupdfDoc(doc);
        setPageCount(count);
        setSelectedPages(new Set());
        setPageScaleText(new Map());
        // NO probe here. The probe used to walk the WHOLE document the moment a
        // PDF loaded, before the user had ticked anything — on a 22-page set that
        // is ~1.1 GB of retained page geometry in the worker and minutes of band
        // OCR nobody asked for. It now runs over the ticked pages only, from the
        // selection effect below. Stop any probe still running for the previous
        // document (Change file / new load) so it can't keep the shared OCR
        // worker busy behind this one.
        stopProbe("supersede");
        setProbe(null);
        setProbeOcr(false);
        setProbeState("idle");
        // Show the page grid right away (loading = false), then generate thumbs in background
        setLoading(false);

        // Stream thumbnails progressively
        if (!rendererRef.current) rendererRef.current = new PDFRenderer(mupdf);
        const renderer = rendererRef.current;
        for (let i = 0; i < count; i++) {
          if (thumbGenRef.current !== gen) return;
          await yieldToMain();
          if (thumbGenRef.current !== gen) return;
          try {
            // noCache: each thumbnail is encoded to a data URL below and never
            // re-requested; caching all 22 pages costs ~35 MB for nothing.
            const rendered = await renderer.renderPage(doc, i, { scale: THUMB_SCALE, noCache: true });
            if (thumbGenRef.current !== gen) return;
            const id = rendered.imageData as ImageData;
            if (id?.data) {
              const url = imageDataToDataUrl(id);
              setThumbnails((prev) => ({ ...prev, [i]: url }));
            }
          } catch {
            // Skip failed thumbnails silently
          }
          setThumbProgress(i + 1);
        }
      } catch (e) {
        console.error(e);
        setLoadError("Could not open this PDF. The file may be corrupt or unsupported.");
        setLoading(false);
      }
    },
    [releaseDoc, stopProbe]
  );

  const handleChooseFile = useCallback(async () => {
    const result = await fileSystem.openFile();
    if (result) await loadPdfFromResult(result.data, result.name ?? "");
  }, [fileSystem, loadPdfFromResult]);

  useEffect(() => {
    if (!open) {
      thumbGenRef.current++;
      releaseDoc();
      rendererRef.current?.dispose();
      rendererRef.current = null;
      setPdfBytes(null);
      setPdfFileName("");
      setMupdfDoc(null);
      setPageCount(0);
      setSelectedPages(new Set());
      setPageScaleText(new Map());
      setThumbnails({});
      setThumbProgress(0);
      setProbe(null);
      setProbeState("idle");
      setProbeOcr(false);
      stopProbe("supersede"); // stop a probe still running for the just-closed doc
      void shutdownOcr();     // and release tesseract's workers with it
      setCtoListening(false);
      setLoadError(null);
      // Reset the guard so the next open triggers the file picker
      hasTriggeredFileOpenRef.current = false;
      return;
    }
    // Only trigger file-picker / initial-PDF once per modal session.
    if (hasTriggeredFileOpenRef.current) return;
    hasTriggeredFileOpenRef.current = true;

    // When opened from CTO stitch with initial PDF, load it into page selection instead of auto-adding all.
    if (initialPdf?.pdfBytes && initialPdf?.fileName) {
      loadPdfFromResult(initialPdf.pdfBytes, initialPdf.fileName);
      onInitialConsumed?.();
      return;
    }
    if (ctoContext) {
      setSourceTab("device");
      return;
    }
    // Don't auto-open file picker — let the user see the modal first
    // and click "Choose file" themselves for a clearer flow.
  }, [open, ctoContext, fileSystem, loadPdfFromResult, initialPdf, onInitialConsumed, releaseDoc, stopProbe]);

  // From Pursuit: request document list from opener and listen for nanodoc-cto-documents
  useEffect(() => {
    if (!open || !ctoContext || sourceTab !== "cto") {
      setCtoDocuments([]);
      setCtoDocumentsLoading(false);
      setCtoDocumentsError(null);
      return;
    }
    const projectId = ctoContext.project;
    if (!projectId) {
      setCtoDocumentsError("Project not set.");
      return;
    }
    const target = resolveCtoTarget({ parent: window.parent, opener: window.opener, self: window });
    if (!target) {
      setCtoDocumentsError("Open stitch from Pursuit to see project documents.");
      return;
    }
    setCtoDocumentsLoading(true);
    setCtoDocumentsError(null);
    setCtoDocuments([]);
    ctoDocumentsRespondedRef.current = false;
    target.postMessage({ type: "nanodoc-request-cto-documents", projectId }, ctoContext.api_origin);

    const timeoutId = window.setTimeout(() => {
      if (!ctoDocumentsRespondedRef.current) {
        setCtoDocumentsError("Request timed out. Open stitch from Pursuit project documents.");
        setCtoDocumentsLoading(false);
      }
    }, 12000);

    // Only accept document lists from the CTO origin we asked — any window
    // can post to this one otherwise.
    const allowedOrigin = ctoContext.api_origin?.replace(/\/+$/, "") ?? "";
    const handleMessage = (event: MessageEvent) => {
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      if (event.data?.type !== "nanodoc-cto-documents") return;
      ctoDocumentsRespondedRef.current = true;
      const list = Array.isArray(event.data?.documents) ? event.data.documents : [];
      setCtoDocuments(
        list.filter(
          (d: unknown) =>
            d &&
            typeof d === "object" &&
            typeof (d as { displayName?: unknown }).displayName === "string" &&
            typeof (d as { token?: unknown }).token === "string"
        ) as CtoDoc[]
      );
      setCtoDocumentsLoading(false);
      setCtoDocumentsError(null);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      setCtoDocumentsLoading(false);
    };
  }, [open, ctoContext, sourceTab]);

  const loadCtoDocument = useCallback(
    async (doc: CtoDoc) => {
      if (!ctoContext) return;
      setCtoDocumentsError(null);
      setLoading(true);
      try {
        const url = `${ctoContext.api_origin}/api/nanodoc/pdf?token=${encodeURIComponent(doc.token)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
        const json = await res.json();
        const pdfUrl = json?.pdfUrl;
        if (!pdfUrl || typeof pdfUrl !== "string") throw new Error("Invalid response");
        const pdfRes = await fetch(pdfUrl);
        if (!pdfRes.ok) throw new Error("Failed to fetch PDF");
        const ab = await pdfRes.arrayBuffer();
        await loadPdfFromResult(new Uint8Array(ab), doc.displayName);
      } catch (e) {
        console.error("CTO load document failed", e);
        setCtoDocumentsError(e instanceof Error ? e.message : "Failed to load document");
      } finally {
        setLoading(false);
      }
    },
    [ctoContext, loadPdfFromResult]
  );

  /** Selecting an entry from the merged "From Pursuit" list: the synthetic
   *  session-source entry loads its retained bytes directly (no network); any
   *  other entry is a real CTO document fetched by token as before. */
  const handleSelectCtoDoc = useCallback(
    (doc: CtoDoc) => {
      if (doc.type === SESSION_SOURCE_DOC_TYPE) {
        if (sessionSourcePdf) loadPdfFromResult(sessionSourcePdf.pdfBytes, sessionSourcePdf.fileName);
        return;
      }
      loadCtoDocument(doc);
    },
    [sessionSourcePdf, loadPdfFromResult, loadCtoDocument]
  );

  // From Pursuit: postMessage listener for nanodoc-add-cto-doc (legacy: CTO pushes one doc)
  useEffect(() => {
    if (!open || !ctoContext || sourceTab !== "cto") return;
    setCtoListening(true);
    const ctx = ctoContext;
    const allowedOrigin = ctx.api_origin?.replace(/\/+$/, "") ?? "";

    const handleMessage = async (event: MessageEvent) => {
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      const data = event.data;
      if (data?.type !== "nanodoc-add-cto-doc") return;
      const name = typeof data.name === "string" ? data.name : "document.pdf";
      try {
        if (typeof data.pdfUrl === "string" && data.pdfUrl) {
          const res = await fetch(data.pdfUrl);
          if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
          const ab = await res.arrayBuffer();
          await loadPdfFromResult(new Uint8Array(ab), name);
          return;
        }
        if (typeof data.token === "string" && data.token) {
          const url = `${ctx.api_origin}/api/nanodoc/pdf?token=${encodeURIComponent(data.token)}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
          const json = await res.json();
          const pdfUrl = json?.pdfUrl;
          if (!pdfUrl || typeof pdfUrl !== "string") throw new Error("Invalid response");
          const pdfRes = await fetch(pdfUrl);
          if (!pdfRes.ok) throw new Error("Failed to fetch PDF");
          const ab = await pdfRes.arrayBuffer();
          await loadPdfFromResult(new Uint8Array(ab), name);
        }
      } catch (e) {
        console.error("CTO add doc failed", e);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      setCtoListening(false);
    };
  }, [open, ctoContext, sourceTab, loadPdfFromResult]);

  const handleAddToCanvas = useCallback(async () => {
    if (!mupdfDoc || !pdfBytes || selectedPages.size === 0) return;
    // Plain add must never wait on the probe: abort it BEFORE the render loop so
    // it stops queuing NEW OCR work behind this add. Abort is cooperative — any
    // OCR job already in flight finishes first — but the probe stops at its next
    // checkpoint and replies {aborted:true} → probeState "skipped" (no toast).
    abortProbe();
    setAdding(true);
    setLoadError(null);
    const selected = Array.from(selectedPages).sort((a, b) => a - b);
    setAddingProgress({ done: 0, total: selected.length });
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      if (!rendererRef.current) rendererRef.current = new PDFRenderer(mupdf);
      await commitPlainAdd({
        mupdf,
        doc: mupdfDoc,
        pdfBytes,
        fileName: pdfFileName || undefined,
        selected,
        pageScales,
        uniformScale,
        removeWhiteBackground,
        renderer: rendererRef.current,
        onProgress: (done, total) => setAddingProgress({ done, total }),
      });
      onPagesAdded?.();
      onClose();
    } catch (e) {
      console.error(e);
      setLoadError("Could not add the selected pages to the canvas. Please try again.");
    } finally {
      setAdding(false);
    }
  }, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, onClose, removeWhiteBackground, abortProbe, pageScales, uniformScale, onPagesAdded]);

  const handleAddAndAutoAlign = useCallback(async () => {
    if (!mupdfDoc || !pdfBytes || selectedPages.size === 0) return;
    setAdding(true);
    setLoadError(null);
    const selected = Array.from(selectedPages).sort((a, b) => a - b);
    setAddingProgress({ done: 0, total: selected.length });
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      if (!rendererRef.current) rendererRef.current = new PDFRenderer(mupdf);
      // Prefer the cached probe (skips the second stitch); else the helper falls back
      // to running the aligner live (probe absent/errored/running).
      // The probe always ran with a uniform (null) scale, so its cached poses are
      // only valid when this selection turns out uniform too — a mixed selection
      // always takes the live path, which is per-page-scale aware.
      let cached: CachedProbePlacement | null = null;
      if (probe && probeState === "done" && isUniform(selected, pageScales, uniformScale)) {
        const sel = new Set(selected);
        // Re-run the (cheap) layout over just the selected sheets so the committed
        // tiles normalize to THIS selection's top-left (MARGIN), not the whole
        // document's. The probe laid out all pages, so filtering alone would leave a
        // partial selection offset off-canvas; the expensive stitch stays cached (poses).
        const subset = probe.poses.filter((p) => sel.has(p.pageIndex));
        cached = {
          placements: layoutPlacements(subset, probe.rootFtPerIn),
          rootFtPerIn: probe.rootFtPerIn,
          worstResidFt: probe.worstResidFt,
          // The honesty payload travels with the poses: without it the commit had no
          // seam report and its demotion silently did nothing on this path.
          method: probe.method,
          seamReport: probe.seamReport,
          alignmentVerdict: probe.alignmentVerdict,
          alongAnchored: probe.alongAnchored,
          worstAlongUncertaintyFt: probe.worstAlongUncertaintyFt,
          refPageIndices: probe.refPageIndices,
        };
      }
      const result = await commitAutoAlign({
        mupdf,
        doc: mupdfDoc,
        pdfBytes,
        fileName: pdfFileName || undefined,
        selected,
        pageScales,
        uniformScale,
        removeWhiteBackground,
        renderer: rendererRef.current,
        onProgress: (done, total) => setAddingProgress({ done, total }),
        ocr: recognize,
        cached,
      });
      if (result.message)
        useNotificationStore
          .getState()
          .showNotification(result.message, result.unalignedIds.length > 0 ? "info" : "success");
      onAutoAlignResult?.(result.unalignedIds.length);
      onClose();
    } catch (e) {
      console.error(e);
      setLoadError("Could not auto-align the selected pages. Try 'Add to canvas' and align manually.");
    } finally {
      setAdding(false);
    }
  }, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, onClose, removeWhiteBackground, probe, probeState, pageScales, uniformScale, onAutoAlignResult]);

  const feasibility = useMemo(
    () => (probe ? deriveFeasibility(probe, selectedIndices) : null),
    [probe, selectedIndices]
  );

  const thumbsStillLoading = pageCount > 0 && thumbProgress < pageCount;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Add PDF pages to canvas</DialogTitle>
        </DialogHeader>
        {ctoContext && (
          <div className="flex gap-2 border-b pb-2">
            <Button
              variant={sourceTab === "device" ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setSourceTab("device");
                thumbGenRef.current++;
                releaseDoc();
                setPdfBytes(null);
                setPdfFileName("");
                setMupdfDoc(null);
                setPageCount(0);
                setSelectedPages(new Set());
                setPageScaleText(new Map());
                setThumbnails({});
                setLoadError(null);
                stopProbe("supersede");
                setProbe(null);
                setProbeState("idle");
              }}
            >
              From device
            </Button>
            <Button
              variant={sourceTab === "cto" ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setSourceTab("cto");
                thumbGenRef.current++;
                releaseDoc();
                setPdfBytes(null);
                setPdfFileName("");
                setMupdfDoc(null);
                setPageCount(0);
                setSelectedPages(new Set());
                setPageScaleText(new Map());
                setThumbnails({});
                setLoadError(null);
                stopProbe("supersede");
                setProbe(null);
                setProbeState("idle");
              }}
            >
              From Pursuit
            </Button>
          </div>
        )}
        {loadError && (
          <p className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded px-3 py-2">
            {loadError}
          </p>
        )}
        {adding ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 className="h-10 w-10 animate-spin" />
            <p>Working… {addingProgress.done} of {addingProgress.total}</p>
            {addingProgress.total > 0 && (
              <div className="w-48 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-200"
                  style={{ width: `${(addingProgress.done / addingProgress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p>Loading PDF…</p>
          </div>
        ) : ctoContext && sourceTab === "device" && !pdfBytes && !loading ? (
          <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <p>Choose a PDF file from your device.</p>
            <Button onClick={handleChooseFile}>Choose file</Button>
          </div>
        ) : ctoContext && sourceTab === "cto" && !pdfBytes ? (
          <div className="py-8 flex flex-col items-stretch gap-4 text-muted-foreground">
            {ctoDocumentsWithSession.length > 0 ? (
              <>
                <p className="text-sm text-center">Choose a document to add pages from:</p>
                <ul className="space-y-2 max-h-64 overflow-auto">
                  {ctoDocumentsWithSession.map((doc, idx) => (
                    <li key={idx}>
                      <Button
                        variant="outline"
                        className="w-full justify-start font-normal"
                        onClick={() => handleSelectCtoDoc(doc)}
                        disabled={loading}
                      >
                        {doc.displayName}
                      </Button>
                    </li>
                  ))}
                </ul>
                {ctoDocumentsLoading && (
                  <p className="text-xs text-center">Loading more project documents…</p>
                )}
                {!ctoDocumentsLoading && ctoDocumentsError && (
                  <p className="text-destructive text-xs text-center">{ctoDocumentsError}</p>
                )}
              </>
            ) : ctoDocumentsLoading ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span>Loading project documents…</span>
              </div>
            ) : ctoDocumentsError ? (
              <p className="text-destructive text-center py-4">{ctoDocumentsError}</p>
            ) : (
              <p className="text-center py-4">No project PDFs found.</p>
            )}
          </div>
        ) : pdfBytes && pageCount > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Select all
                </Button>
                <Button variant="outline" size="sm" onClick={selectNone}>
                  Select none
                </Button>
                <Button variant="outline" size="sm" onClick={handleChooseFile}>
                  Change file
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {pageCount} page{pageCount !== 1 ? "s" : ""}
                {pdfFileName ? ` — ${pdfFileName}` : ""}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 pb-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={removeWhiteBackground}
                  onChange={(e) => setRemoveWhiteBackground(e.target.checked)}
                  className="rounded border-input"
                />
                Remove white background
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">Scale 1&quot;=</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="20"
                  value={scaleFeetPerInch}
                  onChange={(e) => setScaleFeetPerInch(e.target.value)}
                  className="w-14 rounded border border-input bg-background px-2 py-1 text-sm"
                />
                <span className="text-muted-foreground text-xs">ft</span>
              </label>
            </div>
            {/* Thumbnail progress bar */}
            {thumbsStillLoading && (
              <div className="flex items-center gap-2 pb-1">
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary/60 rounded-full transition-all duration-150"
                    style={{ width: `${(thumbProgress / pageCount) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                  {thumbProgress}/{pageCount}
                </span>
              </div>
            )}
            <div className="flex-1 overflow-auto grid grid-cols-4 gap-2 py-2 min-h-[200px]">
              {Array.from({ length: pageCount }, (_, i) => (
                <label
                  key={i}
                  className={`flex flex-col items-center p-2 border rounded cursor-pointer transition-colors ${
                    selectedPages.has(i)
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border hover:border-muted-foreground/40"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPages.has(i)}
                    onChange={() => togglePage(i)}
                    className="sr-only"
                  />
                  {thumbnails[i] ? (
                    <img
                      src={thumbnails[i]}
                      alt={`Page ${i + 1}`}
                      className="w-full h-auto object-contain max-h-32"
                    />
                  ) : (
                    <div className="w-full h-24 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                      {thumbProgress <= i ? (
                        <Loader2 className="h-4 w-4 animate-spin opacity-40" />
                      ) : (
                        `Page ${i + 1}`
                      )}
                    </div>
                  )}
                  <span className="text-xs mt-1">Page {i + 1}</span>
                  {selectedPages.has(i) && (
                    <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground" onClick={(e) => e.preventDefault()}>
                      1&quot;=
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`Scale for page ${i + 1}, feet per inch`}
                        placeholder={String(uniformScale ?? DEFAULT_SCALE_FT_PER_IN)}
                        value={pageScaleText.get(i) ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          setPageScaleText((prev) => {
                            const next = new Map(prev);
                            if (value.trim()) next.set(i, value); else next.delete(i);
                            return next;
                          });
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-10 rounded border border-input bg-background px-1 py-0.5 text-[10px]"
                      />
                      ft
                    </span>
                  )}
                </label>
              ))}
            </div>
          </>
        ) : !loading && !pdfBytes && !adding && !ctoContext ? (
          <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <p>Choose a PDF file to select pages from.</p>
            <Button onClick={handleChooseFile}>Choose file</Button>
          </div>
        ) : null}
        {probeState === "done" && feasibility && feasibility.status !== "unstitchable" && (() => {
          const report = probe?.seamReport ?? [];
          const nVer = report.filter((s) => s.status === "verified").length;
          // When the alignment is only PARTIALLY verified, say how many seams checked
          // out (auto-align stays enabled — the app is honest about the ones it can't
          // physically confirm).
          const partialSeams =
            probe?.alignmentVerdict === "partial" && report.length
              ? ` · ${nVer} of ${report.length} seams verified`
              : "";
          return (
            <p className="text-xs text-muted-foreground text-right px-1">
              {feasibility.status === "confident"
                ? `✓ Tiled sheet set detected — will auto-align${partialSeams}`
                : `${feasibility.alignedInSelection} of ${feasibility.selectedCount} will align · the rest are added below to place manually${partialSeams}`}
            </p>
          );
        })()}
        {probeState === "done" && feasibility?.status === "unstitchable" && feasibility.reason && (
          <p className="text-xs text-amber-600 dark:text-amber-500 text-right px-1">
            Can't verify alignment for this set — add pages and align manually
          </p>
        )}
        {probeState === "running" && (
          <p className="text-xs text-muted-foreground text-right px-1">
            Checking alignment…
            {probeOcr && " reading outlined text — this can take a few minutes"}
          </p>
        )}
        {/* Skipping the check is honest, not an error: unverified verdict, reason
            "check skipped" — plain add stays available, auto-align isn't offered. */}
        {probeState === "skipped" && (
          <p className="text-xs text-amber-600 dark:text-amber-500 text-right px-1">
            Alignment check skipped — add pages and align manually
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleAddToCanvas}
            disabled={!pdfBytes || selectedPages.size === 0 || adding}
          >
            {adding ? "Adding…" : `Add ${selectedPages.size} page${selectedPages.size !== 1 ? "s" : ""} to canvas`}
          </Button>
          {(() => {
            // Fail-open: a still-running probe only DISABLES with a "checking"
            // label; error/absent probe leaves the button enabled (clicking runs
            // the live pipeline, per handleAddAndAutoAlign's fallback).
            const tooFew = selectedPages.size < 2;
            const checking = probeState === "running";
            // A skipped check leaves the set unverified — auto-align isn't offered
            // (same honesty as cannot-verify); the plain add button stays enabled.
            const skipped = probeState === "skipped";
            const unstitchable = probeState === "done" && feasibility?.status === "unstitchable";
            // Reason-aware: a set that LOOKS tiled but whose seams can't be physically
            // verified gets the honest "can't verify" copy instead of the bare
            // "unavailable" (which reads as "these aren't tiles at all").
            const cannotVerify = unstitchable && !!feasibility?.reason;
            const disabled = adding || tooFew || checking || unstitchable || skipped;
            const label = adding
              ? "Aligning…"
              : checking
              ? "Checking alignment…"
              : skipped
              ? "Alignment check skipped"
              : cannotVerify
              ? "Can't verify alignment"
              : unstitchable
              ? "Auto-align unavailable"
              : `Add & auto-align ${selectedPages.size} page${selectedPages.size !== 1 ? "s" : ""}`;
            const title = tooFew
              ? "Select at least 2 pages to auto-align"
              : skipped
              ? "Alignment check skipped — add pages and align manually"
              : cannotVerify
              ? "Can't verify alignment for this set — add pages and align manually"
              : unstitchable
              ? "These pages don't look like one tiled plan set — add them and align manually"
              : undefined;
            return (
              <>
                {/* Skip check: abort the probe now and add/align manually instead of
                    waiting out a slow OCR-heavy check. */}
                {checking && (
                  <Button variant="link" size="sm" className="px-1" onClick={abortProbe}>
                    Skip check
                  </Button>
                )}
                <Button variant="secondary" onClick={handleAddAndAutoAlign} disabled={disabled} title={title}>
                  {checking && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                  {label}
                </Button>
              </>
            );
          })()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
