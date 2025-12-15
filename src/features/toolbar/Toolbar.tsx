/**
 * Vertical Toolbar Component
 * 
 * Vertical toolbar on the right side with all tools.
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { Button } from "@/components/ui/button";
import { 
  MousePointer2, 
  Hand, 
  Type, 
  Highlighter, 
  MessageSquare,
  Eraser,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCw,
  BookmarkPlus,
  Undo2,
  Redo2,
  FileText,
  Save,
  Printer,
  HardDrive,
  Clock,
  Maximize2,
  Settings,
  Ruler,
  TextSelect
} from "lucide-react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { useState, useEffect } from "react";
import { useUndoRedo } from "@/shared/hooks/useUndoRedo";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RecentFilesModal } from "@/features/recent/RecentFilesModal";
import { PrintSettingsDialog } from "@/features/print/PrintSettingsDialog";
import type { PrintSettings } from "@/shared/stores/printStore";
import { DocumentSettingsDialog } from "@/features/settings/DocumentSettingsDialog";
import { useDocumentSettingsStore } from "@/shared/stores/documentSettingsStore";

export function Toolbar() {
  const { activeTool, setActiveTool, zoomLevel, zoomToCenter, setFitMode, readMode } = useUIStore();
  const { currentPage, getCurrentDocument, addBookmark } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const [, setIsFullscreen] = useState(false);
  const { undo, redo, canUndo, canRedo } = useUndoRedo();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [showRecentFiles, setShowRecentFiles] = useState(false);
  const [showSizeDialog, setShowSizeDialog] = useState(false);
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [showDocumentSettings, setShowDocumentSettings] = useState(false);
  const [pageWidth, setPageWidth] = useState("8.5");
  const [pageHeight, setPageHeight] = useState("11");
  const { showRulers, toggleRulers } = useDocumentSettingsStore();

  const handleOpenFile = async () => {
    const result = await fileSystem.openFile();
    if (result) {
      try {
        // Initialize mupdf
        const mupdfModule = await import("mupdf");
        await loadPDF(result.data, result.name, mupdfModule.default, result.path || null);
      } catch (error) {
        console.error("Error loading PDF:", error);
      }
    }
  };

  const syncAndSavePDF = async (saveFunction: (data: Uint8Array) => Promise<void>) => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      // Get all annotations for this document
      const annotations = usePDFStore.getState().getAnnotations(currentDoc.getId());
      
      // Initialize mupdf and PDFEditor
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      
      // Save document with annotations synced
      const pdfData = await editor.saveDocument(currentDoc, annotations);
      
      // Call the provided save function
      await saveFunction(pdfData);
      
      // Mark tab as unmodified
      const tab = useTabStore.getState().getTabByDocumentId(currentDoc.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, false);
      }
    } catch (error) {
      console.error("Error saving PDF:", error);
      throw error;
    }
  };

  const handleSaveFile = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    const originalPath = usePDFStore.getState().getDocumentPath(currentDoc.getId());
    
    // If we have an original path, save directly to it (no dialog)
    if (originalPath && 'saveFileToPath' in fileSystem) {
      await syncAndSavePDF(async (data) => {
        await (fileSystem as any).saveFileToPath(data, originalPath);
      });
    } else {
      // No original path, show Save As dialog
      await handleSaveAs();
    }
  };

  const handleSaveAs = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    await syncAndSavePDF(async (data) => {
      // Always show save dialog for Save As
      await fileSystem.saveFile(data, currentDoc.getName());
    });
  };

  const handleSaveToDesktop = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    await syncAndSavePDF(async (data) => {
      if ('saveFileToDesktop' in fileSystem) {
        await (fileSystem as any).saveFileToDesktop(data, currentDoc.getName());
      } else {
        // Fallback to regular save in browser
        await fileSystem.saveFile(data, currentDoc.getName());
      }
    });
  };

  const handlePrint = () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    // Open print settings dialog
    setShowPrintDialog(true);
  };

  const handleExecutePrint = async (
    settings: PrintSettings,
    startPage: number,
    endPage: number
  ) => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      // Import PDFPrinter
      const PDFPrinterModule = await import("@/core/pdf/PDFPrinter");
      const PDFPrinter = PDFPrinterModule.PDFPrinter;
      const mupdfModule = await import("mupdf");
      const printer = new PDFPrinter(mupdfModule.default);
      
      await printer.printPages(currentDoc, startPage, endPage, settings);
    } catch (error) {
      console.error("Error printing PDF:", error);
    }
  };

  const handleRotatePage = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      
      // Rotate current page 90 degrees clockwise
      await editor.rotatePage(currentDoc, currentPage, 90);
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDoc.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
    } catch (error) {
      console.error("Error rotating page:", error);
    }
  };

  const handleOpenSizeDialog = () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    // Get current page dimensions
    const pageMetadata = currentDoc.getPageMetadata(currentPage);
    if (pageMetadata) {
      // Convert points to inches (72 points = 1 inch)
      setPageWidth((pageMetadata.width / 72).toFixed(2));
      setPageHeight((pageMetadata.height / 72).toFixed(2));
    }
    setShowSizeDialog(true);
  };

  const handleResizePage = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      const widthInches = parseFloat(pageWidth);
      const heightInches = parseFloat(pageHeight);
      
      if (isNaN(widthInches) || isNaN(heightInches) || widthInches <= 0 || heightInches <= 0) {
        alert("Please enter valid dimensions");
        return;
      }

      // Convert inches to points (1 inch = 72 points)
      const widthPoints = widthInches * 72;
      const heightPoints = heightInches * 72;

      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      
      await editor.resizePage(currentDoc, currentPage, widthPoints, heightPoints);
      
      setShowSizeDialog(false);
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDoc.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
    } catch (error) {
      console.error("Error resizing page:", error);
      alert("Failed to resize page: " + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handleApplyDocumentSettings = async (width: number, height: number, applyToAll: boolean) => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      
      if (applyToAll) {
        // Resize all pages
        await editor.resizeAllPages(currentDoc, width, height);
      } else {
        // Resize current page only
        await editor.resizePage(currentDoc, currentPage, width, height);
      }
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDoc.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
    } catch (error) {
      console.error("Error applying document settings:", error);
      throw error;
    }
  };

  const handleZoomIn = () => {
    const newZoom = Math.min(5, zoomLevel + 0.25);
    zoomToCenter(newZoom);
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(0.25, zoomLevel - 0.25);
    zoomToCenter(newZoom);
  };

  const handleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleBookmarkPage = () => {
    if (!currentDocument) return;
    
    const bookmark = {
      id: `bookmark_${Date.now()}`,
      pageNumber: currentPage,
      title: `Page ${currentPage + 1}`,
      created: new Date(),
    };
    
    addBookmark(currentDocument.getId(), bookmark);
  };

  return (
    <div className="flex flex-col items-center gap-2 p-2 h-full">
      {/* File Actions */}
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={handleOpenFile}
          title="Open PDF"
          className="w-12 h-12"
          data-action="open"
        >
          <FileText className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setShowRecentFiles(true)}
          title="Open Recent"
          className="w-12 h-12"
        >
          <Clock className="h-5 w-5" />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              disabled={!currentDocument}
              title="Save PDF"
              className="w-12 h-12"
              data-action="save"
            >
              <Save className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" side="left" align="start">
            <div className="flex flex-col">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveFile}
                className="justify-start"
              >
                <Save className="h-4 w-4 mr-2" />
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveAs}
                className="justify-start"
              >
                <Save className="h-4 w-4 mr-2" />
                Save As...
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveToDesktop}
                className="justify-start"
              >
                <HardDrive className="h-4 w-4 mr-2" />
                Save to Desktop
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          variant="outline"
          size="icon"
          onClick={handlePrint}
          disabled={!currentDocument}
          title="Print PDF"
          className="w-12 h-12"
        >
          <Printer className="h-5 w-5" />
        </Button>
      </div>

      <div className="h-px w-full bg-border my-2" />

      {/* Tool Selection */}
      <div className="flex flex-col gap-1">
        <Button
          variant={activeTool === "select" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("select")}
          title="Select Tool"
          className="w-12 h-12"
        >
          <MousePointer2 className="h-5 w-5" />
        </Button>
        <Button
          variant={activeTool === "selectText" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("selectText")}
          title="Select Text Tool"
          className="w-12 h-12"
        >
          <TextSelect className="h-5 w-5" />
        </Button>
        <Button
          variant={activeTool === "pan" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("pan")}
          title="Pan Tool (or hold Space)"
          className="w-12 h-12"
        >
          <Hand className="h-5 w-5" />
        </Button>
        <Button
          variant={activeTool === "text" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("text")}
          title="Text Annotation"
          className="w-12 h-12"
        >
          <Type className="h-5 w-5" />
        </Button>
        <Button
          variant={activeTool === "highlight" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("highlight")}
          title="Highlight Text"
          className="w-12 h-12"
        >
          <Highlighter className="h-5 w-5" />
        </Button>
        <Button
          variant={activeTool === "callout" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("callout")}
          title="Callout Note"
          className="w-12 h-12"
        >
          <MessageSquare className="h-5 w-5" />
        </Button>
        <Button
          variant={activeTool === "redact" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("redact")}
          title="Redact (Permanently Remove Content)"
          className="w-12 h-12"
        >
          <Eraser className="h-5 w-5" />
        </Button>
      </div>

      <div className="h-px w-full bg-border my-2" />

      {/* Zoom Controls */}
      <div className="flex flex-col gap-1">
        <Button 
          variant="outline" 
          size="icon" 
          onClick={handleZoomIn} 
          title="Zoom In"
          className="w-12 h-12"
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <div className="text-xs text-center text-muted-foreground px-2">
          {Math.round(zoomLevel * 100)}%
        </div>
        <Button 
          variant="outline" 
          size="icon" 
          onClick={handleZoomOut} 
          title="Zoom Out"
          className="w-12 h-12"
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setFitMode("page")}
          title="Fit Page"
          className="w-12 h-12"
        >
          <Maximize className="h-5 w-5" />
        </Button>
      </div>

      <div className="h-px w-full bg-border my-2" />

      {/* Undo/Redo */}
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={() => undo()}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className="w-12 h-12"
        >
          <Undo2 className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => redo()}
          disabled={!canRedo}
          title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
          className="w-12 h-12"
        >
          <Redo2 className="h-5 w-5" />
        </Button>
      </div>

      <div className="h-px w-full bg-border my-2" />

      {/* Additional Tools */}
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="icon"
          onClick={handleBookmarkPage}
          title="Bookmark Current Page"
          className="w-12 h-12"
          disabled={!currentDocument}
        >
          <BookmarkPlus className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleRotatePage}
          title="Rotate Page 90°"
          className="w-12 h-12"
          disabled={!currentDocument}
        >
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleOpenSizeDialog}
          title="Adjust Page Size (Current Page)"
          className="w-12 h-12"
          disabled={!currentDocument}
        >
          <Maximize2 className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setShowDocumentSettings(true)}
          title="Document Settings (All Pages)"
          className="w-12 h-12"
          disabled={!currentDocument}
        >
          <Settings className="h-5 w-5" />
        </Button>
        <Button
          variant={showRulers ? "default" : "outline"}
          size="icon"
          onClick={toggleRulers}
          title="Toggle Rulers"
          className="w-12 h-12"
          disabled={!currentDocument || readMode}
        >
          <Ruler className="h-5 w-5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleFullscreen}
          title="Toggle Fullscreen (F11)"
          className="w-12 h-12"
        >
          <Maximize className="h-5 w-5" />
        </Button>
      </div>

      {/* Recent Files Modal */}
      <RecentFilesModal
        open={showRecentFiles}
        onOpenChange={setShowRecentFiles}
      />

      {/* Print Settings Dialog */}
      <PrintSettingsDialog
        open={showPrintDialog}
        onOpenChange={setShowPrintDialog}
        document={currentDocument}
        onPrint={handleExecutePrint}
        currentPage={currentPage}
      />

      {/* Page Size Dialog */}
      <Dialog open={showSizeDialog} onOpenChange={setShowSizeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Page Size</DialogTitle>
            <DialogDescription>
              Change the size of page {currentPage + 1}. Dimensions are in inches.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="width">Width (inches)</Label>
              <Input
                id="width"
                type="number"
                step="0.1"
                min="1"
                value={pageWidth}
                onChange={(e) => setPageWidth(e.target.value)}
                placeholder="8.5"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="height">Height (inches)</Label>
              <Input
                id="height"
                type="number"
                step="0.1"
                min="1"
                value={pageHeight}
                onChange={(e) => setPageHeight(e.target.value)}
                placeholder="11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSizeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleResizePage}>
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Document Settings Dialog */}
      <DocumentSettingsDialog
        open={showDocumentSettings}
        onOpenChange={setShowDocumentSettings}
        document={currentDocument}
        currentPage={currentPage}
        onApply={handleApplyDocumentSettings}
      />
    </div>
  );
}

