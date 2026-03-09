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
  Loader2,
  Printer,
  Clock,
  TextSelect,
  FileDown,
  FolderOpen,
  HelpCircle,
  Pencil,
  Square,
  Circle,
  ArrowRight,
  FileText,
  Stamp as StampIcon,
  Layers,
  FileOutput,
  FilePlus2,
  Trash2
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react";
import { useUndoRedo } from "@/shared/hooks/useUndoRedo";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { RecentFilesModal } from "@/features/recent/RecentFilesModal";
import { PrintSettingsDialog } from "@/features/print/PrintSettingsDialog";
import type { PrintSettings } from "@/shared/stores/printStore";
import { DocumentSettingsDialog } from "@/features/settings/DocumentSettingsDialog";
import { ExportDialog } from "@/features/export/ExportDialog";
import { HelpDialog } from "@/features/help/HelpDialog";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { useConversationStore } from "@/shared/stores/conversationStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { SpecExtractionButton } from "@/features/specs/SpecExtractionButton";
import { AISettings } from "@/features/settings/AISettings";
import {
  isBrowserAiStorageAvailable,
  hashPdfBytes,
  setPdfAiMetadata,
} from "@/shared/browserPdfAiStorage";

/** Wraps a toolbar button with a Radix tooltip shown to the left. */
function ToolbarTooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="left" className="flex items-center gap-1.5">
        <span>{label}</span>
        {shortcut && (
          <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function Toolbar() {
  const navigate = useNavigate();
  const { activeTool, setActiveTool, currentShapeType, setCurrentShapeType, requestDocumentSettingsOpen, setRequestDocumentSettingsOpen } = useUIStore();
  const { currentPage, getCurrentDocument } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const { undo, redo, canUndo, canRedo, undoLabel, redoLabel } = useUndoRedo();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [showRecentFiles, setShowRecentFiles] = useState(false);
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [showDocumentSettings, setShowDocumentSettings] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showShapeMenu, setShowShapeMenu] = useState(false);
  const [savingToCto, setSavingToCto] = useState(false);
  const recentFilesButtonRef = useRef<HTMLButtonElement>(null);
  const shapeMenuTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Subscribe to active tab so Save uses the correct CTO context when user switches tabs
  const activeTabId = useTabStore((s) => s.activeTabId);
  const activeTab = useTabStore((s) =>
    s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) ?? null : null
  );
  const ctoContext = useCiviltakeoffContextStore((s) => s.context);

  useEffect(() => {
    const tab = useTabStore.getState().getActiveTab();
    useCiviltakeoffContextStore.getState().setContext(tab?.ctoContext ?? null);
  }, [activeTabId]);

  // Cleanup shape menu hover timeout on unmount
  useEffect(() => {
    return () => {
      if (shapeMenuTimeoutRef.current) clearTimeout(shapeMenuTimeoutRef.current);
    };
  }, []);

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

  // Open Document Settings when requested (e.g. after creating a new project)
  useEffect(() => {
    if (currentDocument && requestDocumentSettingsOpen) {
      setShowDocumentSettings(true);
      setRequestDocumentSettingsOpen(false);
    }
  }, [currentDocument, requestDocumentSettingsOpen, setRequestDocumentSettingsOpen]);
  
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

  // Listen for programmatic save requests (e.g. from CTO parent via CiviltakeoffView)
  const handleSaveFileRef = useRef<() => Promise<void>>();
  useEffect(() => {
    const handler = () => {
      if (handleSaveFileRef.current) {
        handleSaveFileRef.current()
          .then(() => window.dispatchEvent(new CustomEvent("save-document-complete", { detail: { success: true } })))
          .catch(() => window.dispatchEvent(new CustomEvent("save-document-complete", { detail: { success: false } })));
      }
    };
    window.addEventListener("save-document-request", handler);
    return () => window.removeEventListener("save-document-request", handler);
  }, []);

  // Calculate dynamic classes based on toolbar size
  const sizeClasses = useMemo(() => {
    switch (toolbarSize) {
      case 'compact':
        return {
          button: 'w-8 h-8',
          icon: 'h-4 w-4',
          gap: 'gap-0',
          padding: 'p-0.5',
          divider: 'my-1',
          text: 'text-[10px]',
        };
      case 'normal':
        return {
          button: 'w-10 h-10',
          icon: 'h-4.5 w-4.5',
          gap: 'gap-0.5',
          padding: 'p-1',
          divider: 'my-1.5',
          text: 'text-xs',
        };
      case 'spacious':
        return {
          button: 'w-12 h-12',
          icon: 'h-5 w-5',
          gap: 'gap-1',
          padding: 'p-1.5',
          divider: 'my-2',
          text: 'text-xs',
        };
    }
  }, [toolbarSize]);
  
  // Platform-aware modifier key for tooltip shortcuts
  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');
  const modKey = isMac ? '\u2318' : 'Ctrl+';

  const handleOpenFile = async () => {
    const result = await fileSystem.openFile();
    if (result) {
      try {
        useCiviltakeoffContextStore.getState().setContext(null);
        const mupdfModule = await import("mupdf");
        await loadPDF(result.data, result.name, mupdfModule.default, result.path || null);
      } catch (error) {
        console.error("Error loading PDF:", error);
      }
    }
  };

  const SIDECAR_SUFFIX = ".ai.json";

  const syncAndSavePDF = async (saveFunction: (data: Uint8Array) => Promise<string | void>, savePath?: string | null) => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      // Get all annotations for this document
      const annotations = usePDFStore.getState().getAnnotations(currentDoc.getId());

      // Build AI metadata (extracted specs, geotechnical, conversation) so it persists when PDF is re-opened and is stored inside the PDF file
      const extractedSpecs = useSpecExtractionStore.getState().getExtractedSpecs(currentDoc.getId());
      const geotechnicalSummary = useSpecExtractionStore.getState().getGeotechnicalSummary(currentDoc.getId());
      const geotechnicalScope = useSpecExtractionStore.getState().getGeotechnicalScope(currentDoc.getId());
      const conversationMessages = useConversationStore.getState().getMessages(currentDoc.getId());
      const conversationHistory: { messages: { role: "user" | "assistant"; content: string }[] } | undefined =
        conversationMessages.length > 0 ? { messages: conversationMessages } : undefined;
      const hasConversation = conversationHistory != null && conversationHistory.messages.length > 0;
      const hasGeotechnical = Boolean(geotechnicalSummary?.length && geotechnicalScope);
      const aiMetadata =
        extractedSpecs.length > 0 || hasConversation || hasGeotechnical
          ? {
              version: 1,
              ...(extractedSpecs.length > 0 && { extractedSpecs }),
              ...(hasGeotechnical && geotechnicalSummary && geotechnicalScope && {
                geotechnicalSummary,
                geotechnicalScope,
              }),
              ...(hasConversation && conversationHistory ? { conversationHistory } : {}),
            }
          : undefined;

      // Initialize mupdf and PDFEditor
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      
      // Save document with annotations and AI metadata synced
      const pdfData = await editor.saveDocument(currentDoc, annotations, aiMetadata);
      
      // CRITICAL FIX: After syncing, update store annotations with pdfAnnotation references
      // This ensures that when the PDF is reloaded, the duplicate check can match by pdfAnnotation reference
      const mupdfDoc = currentDoc.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      if (pdfDoc) {
        // Group annotations by page for efficiency
        const annotationsByPage = new Map<number, typeof annotations>();
        for (const annot of annotations) {
          if (!annotationsByPage.has(annot.pageNumber)) {
            annotationsByPage.set(annot.pageNumber, []);
          }
          annotationsByPage.get(annot.pageNumber)!.push(annot);
        }
        
        // For each page, match store annotations to PDF annotations
        for (const [pageNumber, pageAnnots] of annotationsByPage) {
          try {
            const page = pdfDoc.loadPage(pageNumber);
            const pdfAnnots = page.getAnnotations();
            
            // Match each store annotation to a PDF annotation
            for (const storeAnnot of pageAnnots) {
              if (!storeAnnot.pdfAnnotation && storeAnnot.type === "shape" && storeAnnot.shapeType === "arrow") {
                // For arrows, match by line points
                try {
                  const matchingPdfAnnot = pdfAnnots.find((pa: any) => {
                    try {
                      const paType = pa.getType();
                      if (paType !== "Line") return false;
                      const paLine = pa.getLine();
                      if (!paLine || !storeAnnot.points || storeAnnot.points.length !== 2) return false;
                      
                      const tolerance = 1; // Small tolerance for floating point differences
                      if (Array.isArray(paLine) && paLine.length >= 4) {
                        const pdfStart = { x: paLine[0], y: paLine[1] };
                        const pdfEnd = { x: paLine[2], y: paLine[3] };
                        const annotStart = storeAnnot.points[0];
                        const annotEnd = storeAnnot.points[1];
                        
                        const startMatch = Math.abs(pdfStart.x - annotStart.x) < tolerance && 
                                          Math.abs(pdfStart.y - annotStart.y) < tolerance;
                        const endMatch = Math.abs(pdfEnd.x - annotEnd.x) < tolerance && 
                                        Math.abs(pdfEnd.y - annotEnd.y) < tolerance;
                        const reverseMatch = Math.abs(pdfStart.x - annotEnd.x) < tolerance && 
                                           Math.abs(pdfStart.y - annotEnd.y) < tolerance &&
                                           Math.abs(pdfEnd.x - annotStart.x) < tolerance && 
                                           Math.abs(pdfEnd.y - annotStart.y) < tolerance;
                        
                        return (startMatch && endMatch) || reverseMatch;
                      }
                    } catch (e) {
                      return false;
                    }
                    return false;
                  });
                  
                  if (matchingPdfAnnot) {
                    // Update the store annotation with the PDF annotation reference
                    usePDFStore.getState().updateAnnotation(currentDoc.getId(), storeAnnot.id, {
                      pdfAnnotation: matchingPdfAnnot
                    });
                  }
                } catch (e) {
                  console.warn(`Could not match PDF annotation for arrow ${storeAnnot.id}:`, e);
                }
              }
            }
          } catch (e) {
            console.warn(`Could not update pdfAnnotation references for page ${pageNumber}:`, e);
          }
        }
      }
      
      
      // Call the provided save function (may return the chosen path for Save As)
      const pathFromSave = await saveFunction(pdfData);
      const pathFromSaveStr =
        typeof pathFromSave === "string"
          ? pathFromSave
          : pathFromSave != null && typeof (pathFromSave as { path?: string }).path === "string"
            ? (pathFromSave as { path: string }).path
            : null;
      const pathForSidecarRaw = savePath ?? pathFromSaveStr;
      const pathForSidecar = pathForSidecarRaw
        ? pathForSidecarRaw.trim().replace(/^file:\/\//i, "").replace(/\\/g, "/").replace(/\/+$/, "")
        : null;
      if (pathFromSaveStr && pathFromSaveStr.length > 0) {
        const normalizedDocPath = pathFromSaveStr.trim().replace(/^file:\/\//i, "").replace(/\\/g, "/").replace(/\/+$/, "");
        usePDFStore.getState().setDocumentPath(currentDoc.getId(), normalizedDocPath);
      }

      // When we have a path, write AI sidecar so re-opening restores "View Results" (works in Tauri/desktop).
      // Sidecar is the reliable source when the PDF is encrypted (in-PDF metadata may stay encrypted).
      if (pathForSidecar && aiMetadata) {
        try {
          const sidecarData = new TextEncoder().encode(JSON.stringify(aiMetadata));
          await fileSystem.saveFileToPath(sidecarData, pathForSidecar + SIDECAR_SUFFIX);
        } catch (e) {
          console.warn("[Toolbar] Failed to write AI sidecar file.", e);
        }
      } else if (aiMetadata && !pathForSidecar && isBrowserAiStorageAvailable()) {
        try {
          const hash = await hashPdfBytes(pdfData);
          if (hash) await setPdfAiMetadata(hash, aiMetadata);
        } catch (e) {
          console.warn("[Toolbar] Failed to store AI metadata for browser recall.", e);
        }
      }
      
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
    const ctx = useCiviltakeoffContextStore.getState().getContext();

    // Tauri with path: save to file
    if (originalPath && isTauri) {
      try {
        await syncAndSavePDF(async (data) => {
          await fileSystem.saveFileToPath(data, originalPath);
        }, originalPath);
      } catch (error) {
        console.error("Error saving to path, falling back to Save As:", error);
        await handleSaveAs();
      }
      return;
    }

    // Opened from Civiltakeoff (browser, no path): save PDF and extraction back to CTO
    if (ctx && !originalPath) {
      setSavingToCto(true);
      try {
        await syncAndSavePDF(async (pdfData) => {
          const form = new FormData();
          form.append("token", ctx.token);
          form.append("file", new Blob([pdfData as BlobPart], { type: "application/pdf" }), currentDoc.getName());
          const saveRes = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, {
            method: "POST",
            body: form,
          });
          if (!saveRes.ok) {
            const err = await saveRes.json().catch(() => ({}));
            throw new Error((err as { message?: string }).message ?? "Failed to save PDF to Civiltakeoff");
          }
          const documentId = currentDoc.getId();
          const extractedSpecs = useSpecExtractionStore.getState().getExtractedSpecs(documentId);
          const specHighlights = useSpecExtractionStore.getState().getSpecHighlights(documentId);
          const tables =
            extractedSpecs.length > 0
              ? [
                  {
                    headers: ["Category", "Parameter", "Value", "Unit", "Page", "Quote"],
                    rows: extractedSpecs.map((s) => [
                      s.category,
                      s.parameter,
                      s.value,
                      s.unit ?? "",
                      s.page,
                      s.quote_text ?? "",
                    ]),
                  },
                ]
              : [];
          const pageRefs = Array.from(
            new Set(extractedSpecs.map((s) => s.page).filter((p) => p != null))
          ).map((page) => ({ page: Number(page), label: `Page ${Number(page) + 1}` }));
          const extractionJson: { tables?: unknown[]; specHighlights?: typeof specHighlights } = { tables };
          if (specHighlights.length > 0) {
            extractionJson.specHighlights = specHighlights;
          }
          const extractRes = await fetch(`${ctx.api_origin}/api/nanodoc/extraction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: ctx.token,
              extractionJson,
              pageRefs,
            }),
          });
          if (!extractRes.ok) {
            console.warn("Failed to send extraction to Civiltakeoff:", await extractRes.text());
          }
        });
        useNotificationStore.getState().showNotification("Saved to Civiltakeoff", "success");
      } catch (error) {
        console.error("Error saving to Civiltakeoff:", error);
        useNotificationStore
          .getState()
          .showNotification(error instanceof Error ? error.message : "Failed to save to Civiltakeoff", "error");
      } finally {
        setSavingToCto(false);
      }
      return;
    }

    // No path and not CTO: Save As
    await handleSaveAs();
  };
  handleSaveFileRef.current = handleSaveFile;

  /** Save current PDF and extraction to Civiltakeoff only. Shown only when ctoContext is set. */
  const handleSaveToCto = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;
    const ctx = useCiviltakeoffContextStore.getState().getContext();
    if (!ctx) return;
    setSavingToCto(true);
    try {
      await syncAndSavePDF(async (pdfData) => {
        const form = new FormData();
        form.append("token", ctx.token);
        form.append("file", new Blob([pdfData as BlobPart], { type: "application/pdf" }), currentDoc.getName());
        const saveRes = await fetch(`${ctx.api_origin}/api/nanodoc/save-pdf`, {
          method: "POST",
          body: form,
        });
        if (!saveRes.ok) {
          const err = await saveRes.json().catch(() => ({}));
          throw new Error((err as { message?: string }).message ?? "Failed to save PDF to Civiltakeoff");
        }
        const documentId = currentDoc.getId();
        const extractedSpecs = useSpecExtractionStore.getState().getExtractedSpecs(documentId);
        const specHighlights = useSpecExtractionStore.getState().getSpecHighlights(documentId);
        const tables =
          extractedSpecs.length > 0
            ? [
                {
                  headers: ["Category", "Parameter", "Value", "Unit", "Page", "Quote"],
                  rows: extractedSpecs.map((s) => [
                    s.category,
                    s.parameter,
                    s.value,
                    s.unit ?? "",
                    s.page,
                    s.quote_text ?? "",
                  ]),
                },
              ]
            : [];
        const pageRefs = Array.from(
          new Set(extractedSpecs.map((s) => s.page).filter((p) => p != null))
        ).map((page) => ({ page: Number(page), label: `Page ${Number(page) + 1}` }));
        const extractionJson: { tables?: unknown[]; specHighlights?: typeof specHighlights } = { tables };
        if (specHighlights.length > 0) {
          extractionJson.specHighlights = specHighlights;
        }
        const extractRes = await fetch(`${ctx.api_origin}/api/nanodoc/extraction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: ctx.token,
            extractionJson,
            pageRefs,
          }),
        });
        if (!extractRes.ok) {
          console.warn("Failed to send extraction to Civiltakeoff:", await extractRes.text());
        }
      });
      useNotificationStore.getState().showNotification("Saved to Civiltakeoff", "success");
    } catch (error) {
      console.error("Error saving to Civiltakeoff:", error);
      useNotificationStore
        .getState()
        .showNotification(error instanceof Error ? error.message : "Failed to save to Civiltakeoff", "error");
    } finally {
      setSavingToCto(false);
    }
  };

  const handleSaveAs = async () => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    const isTauriEnv =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    try {
      let chosenPath: string | null = null;
      let tauriFs: { saveFileToPath: (data: Uint8Array, path: string) => Promise<void> } | null = null;

      if (isTauriEnv) {
        // In Tauri: use native dialog to get path first so we always have it for the AI sidecar.
        // Lazy-load TauriFileSystem so browser bundle doesn't pull in Tauri plugins.
        try {
          const { TauriFileSystem } = await import("@/core/fs/TauriFileSystem");
          const fs = new TauriFileSystem();
          chosenPath = await fs.getSavePath(currentDoc.getName());
          tauriFs = fs;
        } catch (e) {
          console.warn("[Toolbar] Tauri getSavePath failed, falling back to saveFile:", e);
        }
      }

      if (chosenPath && tauriFs) {
        await syncAndSavePDF(
          async (data) => {
            await tauriFs.saveFileToPath(data, chosenPath!);
          },
          chosenPath
        );
      } else {
        await syncAndSavePDF(async (data) => {
          return await fileSystem.saveFile(data, currentDoc.getName());
        });
      }
      useNotificationStore.getState().showNotification("PDF saved successfully", "success");
    } catch (error) {
      console.error("Error in handleSaveAs:", error);
    }
  };

  // Check if we're in Tauri (desktop) or browser - standard Tauri v2 detection
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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
    <TooltipProvider>
    <div
      ref={toolbarRef}
      data-tour="editor-toolbar"
      className={`flex flex-col items-center justify-between ${sizeClasses.padding} h-full overflow-y-auto`}
    >
      {/* File Actions */}
      <div className={`flex flex-col ${sizeClasses.gap} pt-1`}>
        <ToolbarTooltip label="Open PDF" shortcut={`${modKey}O`}>
          <Button
            variant="outline"
            size="icon"
            onClick={handleOpenFile}
            className={sizeClasses.button}
            data-action="open"
            aria-label="Open PDF"
          >
            <FolderOpen className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Open Recent">
          <Button
            ref={recentFilesButtonRef}
            variant="outline"
            size="icon"
            onClick={() => setShowRecentFiles(true)}
            className={sizeClasses.button}
            aria-label="Open Recent"
          >
            <Clock className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              disabled={!currentDocument || savingToCto}
              className={sizeClasses.button}
              data-action="save"
              aria-label="Save"
            >
              {savingToCto ? (
                <Loader2 className={`${sizeClasses.icon} animate-spin`} />
              ) : (
                <Save className={sizeClasses.icon} />
              )}
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
              {ctoContext && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSaveToCto}
                  disabled={savingToCto}
                  className="justify-start"
                >
                  {savingToCto ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {savingToCto ? "Saving…" : "Save to Civiltakeoff"}
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
        <ToolbarTooltip label="Print" shortcut={`${modKey}P`}>
          <Button
            variant="outline"
            size="icon"
            onClick={handlePrint}
            disabled={!currentDocument}
            className={sizeClasses.button}
            aria-label="Print"
          >
            <Printer className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Stitch PDFs">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate("/stitch")}
            className={sizeClasses.button}
            aria-label="Stitch PDFs"
          >
            <Layers className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        {/* Page Management Popover */}
        <Popover>
          <ToolbarTooltip label="Page Operations">
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                disabled={!currentDocument}
                className={sizeClasses.button}
                aria-label="Page Operations"
              >
                <FileText className={sizeClasses.icon} />
              </Button>
            </PopoverTrigger>
          </ToolbarTooltip>
          <PopoverContent className="w-56 p-1" side="left" align="start">
            <div className="flex flex-col">
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                Page Operations
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("page-tools-insert", { detail: { position: "before" } }));
                }}
              >
                <FilePlus2 className="h-4 w-4 mr-2" />
                Insert Blank Page Before
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("page-tools-insert", { detail: { position: "after" } }));
                }}
              >
                <FilePlus2 className="h-4 w-4 mr-2" />
                Insert Blank Page After
              </Button>
              <div className="h-px bg-border my-1" />
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={!currentDocument || currentDocument.getPageCount() <= 1}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("page-tools-delete"));
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Current Page
              </Button>
              <div className="h-px bg-border my-1" />
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("page-tools-extract"));
                }}
              >
                <FileOutput className="h-4 w-4 mr-2" />
                Extract Page to New PDF
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className={`h-px w-full bg-border`} style={{ margin: '0.5rem 0' }} />

      {/* Tool Selection */}
      <div className={`flex flex-col ${sizeClasses.gap}`}>
        <ToolbarTooltip label="Select" shortcut={`${modKey}A`}>
          <Button
            variant={activeTool === "select" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("select")}
            className={sizeClasses.button}
            aria-label="Select"
            data-tour="editor-tool-select"
          >
            <MousePointer2 className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Select Text">
          <Button
            variant={activeTool === "selectText" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("selectText")}
            className={sizeClasses.button}
            aria-label="Select Text"
          >
            <TextSelect className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Pan" shortcut="Space">
          <Button
            variant={activeTool === "pan" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("pan")}
            className={sizeClasses.button}
            aria-label="Pan"
          >
            <Hand className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Text" shortcut={`${modKey}T`}>
          <Button
            variant={activeTool === "text" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("text")}
            className={sizeClasses.button}
            aria-label="Text"
            data-tour="editor-tool-text"
          >
            <Type className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Highlight" shortcut={`${modKey}H`}>
          <Button
            variant={activeTool === "highlight" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("highlight")}
            className={sizeClasses.button}
            aria-label="Highlight"
            data-tour="editor-tool-highlight"
          >
            <Highlighter className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Redact" shortcut={`${modKey}R`}>
          <Button
            variant={activeTool === "redact" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("redact")}
            className={sizeClasses.button}
            aria-label="Redact"
          >
            <Eraser className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Draw">
          <Button
            variant={activeTool === "draw" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("draw")}
            className={sizeClasses.button}
            aria-label="Draw"
            data-tour="editor-tool-draw"
          >
            <Pencil className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        {/* Shape tool: click to draw; hover to open menu to the left (no arrow) */}
        <Popover open={showShapeMenu} onOpenChange={setShowShapeMenu}>
          <PopoverTrigger asChild>
            <div
              className="relative"
              data-tour="editor-tool-shape"
              onMouseEnter={() => {
                if (shapeMenuTimeoutRef.current) {
                  clearTimeout(shapeMenuTimeoutRef.current);
                  shapeMenuTimeoutRef.current = null;
                }
                setShowShapeMenu(true);
              }}
              onMouseLeave={() => {
                shapeMenuTimeoutRef.current = setTimeout(() => {
                  setShowShapeMenu(false);
                  shapeMenuTimeoutRef.current = null;
                }, 300);
              }}
            >
              <Button
                variant={activeTool === "shape" ? "default" : "outline"}
                size="icon"
                onClick={() => setActiveTool("shape")}
                className={sizeClasses.button}
                aria-label="Shape"
              >
                {currentShapeType === "rectangle" && <Square className={sizeClasses.icon} />}
                {currentShapeType === "circle" && <Circle className={sizeClasses.icon} />}
                {currentShapeType === "arrow" && <ArrowRight className={sizeClasses.icon} />}
              </Button>
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="w-auto p-1"
            side="left"
            align="start"
            style={{ marginLeft: "8px" }}
            onMouseEnter={() => {
              if (shapeMenuTimeoutRef.current) {
                clearTimeout(shapeMenuTimeoutRef.current);
                shapeMenuTimeoutRef.current = null;
              }
              setShowShapeMenu(true);
            }}
            onMouseLeave={() => {
              shapeMenuTimeoutRef.current = setTimeout(() => {
                setShowShapeMenu(false);
                shapeMenuTimeoutRef.current = null;
              }, 300);
            }}
          >
            <div className="flex flex-col gap-0.5">
              <Button
                variant={currentShapeType === "rectangle" ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setCurrentShapeType("rectangle");
                  setActiveTool("shape");
                  setShowShapeMenu(false);
                }}
                className="h-7 px-2 justify-start text-xs"
              >
                <Square className="h-3.5 w-3.5 mr-1.5 shrink-0" />
                Rectangle
              </Button>
              <Button
                variant={currentShapeType === "circle" ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setCurrentShapeType("circle");
                  setActiveTool("shape");
                  setShowShapeMenu(false);
                }}
                className="h-7 px-2 justify-start text-xs"
              >
                <Circle className="h-3.5 w-3.5 mr-1.5 shrink-0" />
                Circle
              </Button>
              <Button
                variant={currentShapeType === "arrow" ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setCurrentShapeType("arrow");
                  setActiveTool("shape");
                  setShowShapeMenu(false);
                }}
                className="h-7 px-2 justify-start text-xs"
              >
                <ArrowRight className="h-3.5 w-3.5 mr-1.5 shrink-0" />
                Arrow
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <ToolbarTooltip label="Form">
          <Button
            variant={activeTool === "form" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool("form")}
            className={sizeClasses.button}
            aria-label="Form"
          >
            <FileText className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label="Stamp">
          <Button
            variant={activeTool === "stamp" ? "default" : "outline"}
            size="icon"
            onClick={() => setActiveTool(activeTool === "stamp" ? "select" : "stamp")}
            className={sizeClasses.button}
            aria-label="Stamp"
            data-tour="editor-tool-stamp"
          >
            <StampIcon className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
      </div>

      <div className={`h-px w-full bg-border`} style={{ margin: '0.5rem 0' }} />

      {/* Undo/Redo */}
      <div className={`flex flex-col ${sizeClasses.gap}`} data-tour="editor-undo-redo">
        <ToolbarTooltip label={undoLabel} shortcut={`${modKey}Z`}>
          <Button
            variant="outline"
            size="icon"
            onClick={() => undo()}
            disabled={!canUndo}
            className={sizeClasses.button}
            aria-label={undoLabel}
          >
            <Undo2 className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label={redoLabel} shortcut={isMac ? '\u21E7\u2318Z' : 'Ctrl+Shift+Z'}>
          <Button
            variant="outline"
            size="icon"
            onClick={() => redo()}
            disabled={!canRedo}
            className={sizeClasses.button}
            aria-label={redoLabel}
          >
            <Redo2 className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
      </div>

      <div className={`h-px w-full bg-border`} style={{ margin: '0.5rem 0' }} />

      {/* AI Spec Extraction */}
      {currentDocument && (
        <div className={`flex flex-col ${sizeClasses.gap} mb-2`}>
          <div className="w-full flex justify-center items-center">
            <SpecExtractionButton 
              buttonClassName={sizeClasses.button}
              iconClassName={sizeClasses.icon}
            />
          </div>
          <div className="w-full flex justify-center items-center">
            <AISettings 
              buttonClassName={sizeClasses.button}
              iconClassName={sizeClasses.icon}
            />
          </div>
        </div>
      )}

      <div className={`h-px w-full bg-border`} style={{ margin: '0.5rem 0' }} />

      {/* Help Button */}
      <div className={`flex flex-col ${sizeClasses.gap} mb-2`} data-tour="editor-tool-help">
        <ToolbarTooltip label="Help" shortcut="F1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowHelpDialog(true)}
            className={sizeClasses.button}
            aria-label="Help"
          >
            <HelpCircle className={sizeClasses.icon} />
          </Button>
        </ToolbarTooltip>
      </div>

      {/* Recent Files Modal */}
      <RecentFilesModal
        open={showRecentFiles}
        onOpenChange={setShowRecentFiles}
        triggerRef={recentFilesButtonRef}
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
    </TooltipProvider>
  );
}

