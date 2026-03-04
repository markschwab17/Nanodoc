/**
 * Stitch View – combine multiple PDF pages into one stitched page.
 * Toolbar + pan/zoom canvas with tiles; Add PDF modal and save/open.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useStitchStore } from "@/shared/stores/stitchStore";
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
import { FilePlus } from "lucide-react";
import { TourOverlay } from "@/features/tour/TourOverlay";

export default function StitchView() {
  const { tiles, setCropRect, setCropToContent, setSelectedTileIds } = useStitchStore();
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

  const ctoContext = useCiviltakeoffContextStore((s) => s.context);
  // Auto-open Add PDF modal on first load only when not from CTO (CTO lands with preloaded PDF)
  useEffect(() => {
    if (!ctoContext) setShowAddPdf(true);
  }, [ctoContext]);

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
  }, [pointAlign, scaleAlign]);

  const handlePointAlignModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      setPanMode(false);
      scaleAlign.setScaleAlignMode(false);
    }
    pointAlign.setPointAlignMode(active);
  };

  const handleScaleAlignModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      setPanMode(false);
      pointAlign.setPointAlignMode(false);
    }
    scaleAlign.setScaleAlignMode(active);
  };

  const handlePanModeChange = (active: boolean) => {
    if (active) {
      setContentDeleteMode(false);
      setDeleteElementMode(false);
      pointAlign.setPointAlignMode(false);
      scaleAlign.setScaleAlignMode(false);
    }
    setPanMode(active);
  };

  const handleSelectToolActivate = useCallback(() => {
    setPanMode(false);
    setContentDeleteMode(false);
    setDeleteElementMode(false);
    pointAlign.setPointAlignMode(false);
    scaleAlign.setScaleAlignMode(false);
    setSelectedTileIds(tiles.map((t) => t.id));
  }, [tiles, setSelectedTileIds]);

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

  const handleSaveAndFlatten = (openInEditor: boolean) => {
    if (tiles.length === 0) {
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
    if (tiles.length === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    const defaultName = ctx?.project_name?.trim()
      ? `${ctx.project_name.trim()} - Stitched`
      : "Stitched";
    setSaveToCtoNewFileName(defaultName);
    setShowSaveToCtoDialog(true);
  }, [tiles.length, showNotification]);

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
    if (tiles.length === 0) {
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
        hasTiles={tiles.length > 0}
        contentDeleteMode={contentDeleteMode}
        setContentDeleteMode={setContentDeleteMode}
        deleteElementMode={deleteElementMode}
        setDeleteElementMode={setDeleteElementMode}
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
      />
      <main className="flex-1 min-h-0 overflow-hidden outline-none relative" tabIndex={0}>
        {tiles.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-muted/50">
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
        />
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
