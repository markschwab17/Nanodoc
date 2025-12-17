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
  Eraser,
  Undo2,
  Redo2,
  Save,
  Printer,
  Clock,
  TextSelect,
  FileDown,
  FolderOpen,
  HelpCircle,
  PenTool,
  Square,
  FileText,
  Stamp as StampIcon
} from "lucide-react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useUndoRedo } from "@/shared/hooks/useUndoRedo";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RecentFilesModal } from "@/features/recent/RecentFilesModal";
import { PrintSettingsDialog } from "@/features/print/PrintSettingsDialog";
import type { PrintSettings } from "@/shared/stores/printStore";
import { DocumentSettingsDialog } from "@/features/settings/DocumentSettingsDialog";
import { ExportDialog } from "@/features/export/ExportDialog";
import { HelpDialog } from "@/features/help/HelpDialog";

export function Toolbar() {
  const { activeTool, setActiveTool } = useUIStore();
  const { currentPage, getCurrentDocument } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const { undo, redo, canUndo, canRedo } = useUndoRedo();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [showRecentFiles, setShowRecentFiles] = useState(false);
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [showDocumentSettings, setShowDocumentSettings] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  
  // Get current tab for save state
  const activeTab = useTabStore.getState().getActiveTab();

  // Listen for help dialog open event
  useEffect(() => {
    const handleOpenHelp = () => {
      setShowHelpDialog(true);
    };
    window.addEventListener("openHelp", handleOpenHelp);
    return () => {
      window.removeEventListener("openHelp", handleOpenHelp);
    };
  }, []);
  
  // Viewport detection and auto-adjustment
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [, setContainerHeight] = useState(() => {
    // Initialize with viewport height
    if (typeof window !== 'undefined') {
      return window.innerHeight;
    }
    return 1000; // Default fallback
  });
  const [toolbarSize, setToolbarSize] = useState<'compact' | 'normal' | 'spacious'>(() => {
    // Initialize based on viewport height
    if (typeof window !== 'undefined') {
      const height = window.innerHeight;
      if (height < 700) return 'compact';
      if (height < 1000) return 'normal';
      return 'spacious';
    }
    return 'normal';
  });
  
  // Calculate optimal toolbar size based on available height
  const calculateToolbarSize = useCallback((height: number) => {
    // Estimate required space for all content in each mode:
    // Compact mode: buttons 28px, gaps 1px
    // Normal mode: buttons 36px, gaps 2px  
    // Spacious mode: buttons 44px, gaps 4px
    
    // Count items:
    // - File actions: 4 buttons
    // - Tool selection: 10 buttons (select, selectText, pan, text, highlight, redact, draw, shape, form, stamp)
    // - Undo/Redo: 2 buttons
    // - Dividers: 2 dividers (~2-4px each)
    
    const buttonCount = 4 + 10 + 2; // 16 buttons
    const dividerCount = 2;
    
    // Calculate required height for each mode
    const compactHeight = 
      (buttonCount * 28) + (buttonCount * 1) + (dividerCount * 2) + 20; // Tighter spacing
    
    const normalHeight = 
      (buttonCount * 36) + (buttonCount * 2) + (dividerCount * 3) + 20;
    
    // Force compact mode more aggressively to fit all tools
    if (height < 800 || compactHeight > height * 0.95) {
      return 'compact';
    } else if (height < 1100 || normalHeight > height * 0.9) {
      return 'normal';
    } else {
      return 'spacious';
    }
  }, [currentDocument, activeTab]);
  
  useEffect(() => {
    if (!toolbarRef.current) return;
    
    const updateSize = () => {
      // Try to get the actual container height first
      const containerHeight = toolbarRef.current?.parentElement?.clientHeight || 
                             toolbarRef.current?.clientHeight || 
                             window.innerHeight;
      
      setContainerHeight(containerHeight);
      
      // Calculate and set toolbar size based on available height
      const newSize = calculateToolbarSize(containerHeight);
      setToolbarSize(newSize);
    };
    
    // Initial calculation with a small delay to ensure DOM is ready
    const timeoutId = setTimeout(updateSize, 0);
    
    // ResizeObserver for container size changes
    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });
    
    // Observe both the toolbar container and its parent
    if (toolbarRef.current) {
      resizeObserver.observe(toolbarRef.current);
      if (toolbarRef.current.parentElement) {
        resizeObserver.observe(toolbarRef.current.parentElement);
      }
    }
    
    // Window resize listener as backup
    window.addEventListener('resize', updateSize);
    
    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [calculateToolbarSize]);
  
  // Calculate dynamic classes based on toolbar size
  const sizeClasses = useMemo(() => {
    switch (toolbarSize) {
      case 'compact':
        return {
          button: 'w-7 h-7',
          icon: 'h-3.5 w-3.5',
          gap: 'gap-0',
          padding: 'p-0.5',
          divider: 'my-0.5',
          text: 'text-[10px]',
        };
      case 'normal':
        return {
          button: 'w-9 h-9',
          icon: 'h-4 w-4',
          gap: 'gap-0.5',
          padding: 'p-1',
          divider: 'my-1',
          text: 'text-xs',
        };
      case 'spacious':
        return {
          button: 'w-11 h-11',
          icon: 'h-4.5 w-4.5',
          gap: 'gap-1',
          padding: 'p-1.5',
          divider: 'my-1.5',
          text: 'text-xs',
        };
    }
  }, [toolbarSize]);
  
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
      
      // Mark tab as saved
      const tab = useTabStore.getState().getTabByDocumentId(currentDoc.getId());
      if (tab) {
        useTabStore.getState().setTabLastSaved(tab.id, Date.now());
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
    // Only available in Tauri (desktop) environment
    if (originalPath && isTauri) {
      try {
        await syncAndSavePDF(async (data) => {
          await fileSystem.saveFileToPath(data, originalPath);
        });
      } catch (error) {
        // If saveFileToPath fails (e.g., in browser), fall back to Save As
        console.error("Error saving to path, falling back to Save As:", error);
        await handleSaveAs();
      }
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

  // Check if we're in Tauri (desktop) or browser
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

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

  return (
    <div 
      ref={toolbarRef}
      className={`flex flex-col items-center ${sizeClasses.gap} ${sizeClasses.padding} h-full overflow-y-auto`}
    >
      {/* File Actions */}
      <div className={`flex flex-col ${sizeClasses.gap}`}>
        <Button
          variant="outline"
          size="icon"
          onClick={handleOpenFile}
          title="Open PDF"
          className={sizeClasses.button}
          data-action="open"
        >
          <FolderOpen className={sizeClasses.icon} />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setShowRecentFiles(true)}
          title="Open Recent"
          className={sizeClasses.button}
        >
          <Clock className={sizeClasses.icon} />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              disabled={!currentDocument}
              title="Save & Export"
              className={sizeClasses.button}
              data-action="save"
            >
              <Save className={sizeClasses.icon} />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1" side="left" align="start">
            <div className="flex flex-col">
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                Save as PDF
              </div>
              {isTauri && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSaveFile}
                  className="justify-start"
                >
                  <Save className="h-4 w-4 mr-2" />
                  Save
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveAs}
                className="justify-start"
              >
                <Save className="h-4 w-4 mr-2" />
                Save As...
              </Button>
              <div className="h-px bg-border my-1" />
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                Export to Other Formats
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowExportDialog(true)}
                className="justify-start"
              >
                <FileDown className="h-4 w-4 mr-2" />
                Export...
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
          className={sizeClasses.button}
        >
          <Printer className={sizeClasses.icon} />
        </Button>
      </div>

      <div className={`h-px w-full bg-border ${sizeClasses.divider}`} />

      {/* Tool Selection */}
      <div className={`flex flex-col ${sizeClasses.gap}`}>
        <Button
          variant={activeTool === "select" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("select")}
          title="Select Tool"
          className={sizeClasses.button}
        >
          <MousePointer2 className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "selectText" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("selectText")}
          title="Select Text Tool"
          className={sizeClasses.button}
        >
          <TextSelect className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "pan" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("pan")}
          title="Pan Tool (or hold Space)"
          className={sizeClasses.button}
        >
          <Hand className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "text" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("text")}
          title="Text Annotation"
          className={sizeClasses.button}
        >
          <Type className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "highlight" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("highlight")}
          title="Highlight Text"
          className={sizeClasses.button}
        >
          <Highlighter className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "redact" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("redact")}
          title="Redact (Permanently Remove Content)"
          className={sizeClasses.button}
        >
          <Eraser className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "draw" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("draw")}
          title="Draw Tool"
          className={sizeClasses.button}
        >
          <PenTool className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "shape" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("shape")}
          title="Shapes (Arrow, Rectangle, Circle)"
          className={sizeClasses.button}
        >
          <Square className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "form" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool("form")}
          title="Form Fields"
          className={sizeClasses.button}
        >
          <FileText className={sizeClasses.icon} />
        </Button>
        <Button
          variant={activeTool === "stamp" ? "default" : "outline"}
          size="icon"
          onClick={() => setActiveTool(activeTool === "stamp" ? "select" : "stamp")}
          title="Stamps"
          className={sizeClasses.button}
        >
          <StampIcon className={sizeClasses.icon} />
        </Button>
      </div>

      <div className={`h-px w-full bg-border ${sizeClasses.divider}`} />

      {/* Undo/Redo */}
      <div className={`flex flex-col ${sizeClasses.gap}`}>
        <Button
          variant="outline"
          size="icon"
          onClick={() => undo()}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className={sizeClasses.button}
        >
          <Undo2 className={sizeClasses.icon} />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => redo()}
          disabled={!canRedo}
          title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
          className={sizeClasses.button}
        >
          <Redo2 className={sizeClasses.icon} />
        </Button>
      </div>

      <div className={`h-px w-full bg-border ${sizeClasses.divider}`} />

      {/* Help Button */}
      <div className={`flex flex-col ${sizeClasses.gap} mt-auto`}>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setShowHelpDialog(true)}
          title="Help (F1 or Ctrl/Cmd + ?)"
          className={sizeClasses.button}
        >
          <HelpCircle className={sizeClasses.icon} />
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

      {/* Document Settings Dialog */}
      <DocumentSettingsDialog
        open={showDocumentSettings}
        onOpenChange={setShowDocumentSettings}
        document={currentDocument}
        currentPage={currentPage}
        onApply={handleApplyDocumentSettings}
      />

      {/* Export Dialog */}
      <ExportDialog
        open={showExportDialog}
        onOpenChange={setShowExportDialog}
        document={currentDocument}
      />

      {/* Help Dialog */}
      <HelpDialog
        open={showHelpDialog}
        onOpenChange={setShowHelpDialog}
      />
    </div>
  );
}

