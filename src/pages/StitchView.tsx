/**
 * Stitch View – combine multiple PDF pages into one stitched page.
 * Toolbar + pan/zoom canvas with tiles; Add PDF modal and save/open.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { StitchCanvas } from "@/features/stitch/StitchCanvas";
import { StitchToolbar } from "@/features/stitch/StitchToolbar";
import { AddPdfModal } from "@/features/stitch/AddPdfModal";
import { useStitchKeyboard } from "@/features/stitch/useStitchKeyboard";
import { useStitchContentDelete } from "@/features/stitch/useStitchContentDelete";
import { usePointAlignMode } from "@/features/stitch/usePointAlignMode";
import { useScaleAlignMode } from "@/features/stitch/useScaleAlignMode";
import { exportStitchToPdf } from "@/features/stitch/stitchExport";
import { exportTrainingBundle } from "@/features/stitch/stitchTrainingExport";
import { usePDF } from "@/shared/hooks/usePDF";
import { useNotificationStore } from "@/shared/stores/notificationStore";

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
  const navigate = useNavigate();
  const { loadPDF } = usePDF();
  const { showNotification } = useNotificationStore();

  useStitchKeyboard();

  const [showAddPdf, setShowAddPdf] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isExportingTraining, setIsExportingTraining] = useState(false);
  const [contentDeleteMode, setContentDeleteMode] = useState(false);
  const [deleteElementMode, setDeleteElementMode] = useState(false);
  const [panMode, setPanMode] = useState(false);

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

  const handleSaveAndFlatten = async (openInEditor: boolean) => {
    if (tiles.length === 0) {
      showNotification("Add at least one page to the canvas first.", "info");
      return;
    }
    setIsSaving(true);
    try {
      const buffer = await exportStitchToPdf();
      if (!buffer) {
        showNotification("Export failed.", "error");
        return;
      }
      if (openInEditor) {
        const mupdf = await import("mupdf").then((m) => m.default);
        await loadPDF(buffer, "Stitched.pdf", mupdf, null);
        showNotification("Stitched PDF opened in editor.", "success");
        navigate("/editor");
      } else {
        const blob = new Blob([buffer as BlobPart], {
          type: "application/pdf",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "Stitched.pdf";
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
  };

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
        onRecenter={handleRecenter}
        panMode={panMode}
        onPanModeChange={handlePanModeChange}
        onSelectToolActivate={handleSelectToolActivate}
        onClearSession={handleClearSession}
      />
      <main className="flex-1 min-h-0 overflow-hidden outline-none" tabIndex={0}>
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
          forwardedContainerRef={canvasContainerRef}
        />
      </main>
      <AddPdfModal open={showAddPdf} onClose={() => setShowAddPdf(false)} />
    </div>
  );
}
