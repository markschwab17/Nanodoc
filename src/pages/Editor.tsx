import React, { useEffect, useState } from "react";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import { useDragDrop } from "@/shared/hooks/useDragDrop";
import { useKeyboard } from "@/shared/hooks/useKeyboard";
import { useTabStore } from "@/shared/stores/tabStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useRecentFilesStore } from "@/shared/stores/recentFilesStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { PDFViewer } from "@/features/viewer/PDFViewer";
import { TabBar } from "@/features/tabs/TabBar";
import { BookmarksPanel } from "@/features/bookmarks/BookmarksPanel";
import { ThumbnailCarousel } from "@/features/thumbnails/ThumbnailCarousel";
import { Toolbar } from "@/features/toolbar/Toolbar";
import { CTOSplitScreenToolbar } from "@/features/toolbar/CTOSplitScreenToolbar";
import { AISidePanel } from "@/features/specs/AISidePanel";
import { RedlinePanel } from "@/features/redline/RedlinePanel";
import { TextFormattingToolbar } from "@/features/viewer/TextFormattingToolbar";
import { HighlightToolbar } from "@/features/viewer/HighlightToolbar";
import { DrawToolbar } from "@/features/viewer/DrawToolbar";
import { ShapeToolbar } from "@/features/viewer/ShapeToolbar";
import { FormToolbar } from "@/features/viewer/FormToolbar";
import { RecentFilesModal } from "@/features/recent/RecentFilesModal";
import { StampGallery } from "@/features/stamps/StampGallery";
import { StampCreator } from "@/features/stamps/StampCreator";
import ESignPrepareToolbar from "@/features/esign/ESignPrepareToolbar";
import ESignSigningView from "@/features/esign/ESignSigningView";
import { useESignStore } from "@/shared/stores/esignStore";
import { Button } from "@/components/ui/button";
import { FileText, Upload, File, X, ChevronLeft, ChevronRight, Undo2, Redo2, Layers } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { NotificationToast } from "@/shared/components/NotificationToast";
import { LoadingIndicator } from "@/shared/components/LoadingIndicator";
import { wrapAnnotationUpdate } from "@/shared/stores/undoHelpers";
import { useUndoRedo } from "@/shared/hooks/useUndoRedo";
import { useAutoSave } from "@/shared/hooks/useAutoSave";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useUndoRedoStore } from "@/shared/stores/undoRedoStore";
import { TourOverlay } from "@/features/tour/TourOverlay";


// Pre-initialize mupdf WASM module at app startup so it's ready when the first PDF is opened
let mupdfPreloadPromise: Promise<any> | null = null;
function preloadMupdf() {
  if (!mupdfPreloadPromise) {
    mupdfPreloadPromise = import("mupdf").catch(() => null);
  }
  return mupdfPreloadPromise;
}
preloadMupdf();

function Editor() {
  const { getRootProps, getInputProps, isDragActive } = useDragDrop();
  const navigate = useNavigate();
  const { tabs } = useTabStore();
  const setCurrentDocument = usePDFStore((s) => s.setCurrentDocument);
  const { getRecentFiles } = useRecentFilesStore();
  const { activeTool, setRequestDocumentSettingsOpen, initialSidebarOpen, splitScreenMode } = useUIStore();
  const esignMode = useESignStore((s) => s.mode);
  const fileSystem = useFileSystem();
  const { loadPDF, loading } = usePDF();
  const { showNotification } = useNotificationStore();
  const { undo, redo, canUndo, canRedo } = useUndoRedo();
  useAutoSave();
  const [showRecentFilesOnStartup, setShowRecentFilesOnStartup] = useState(false);
  const [showStampCreator, setShowStampCreator] = useState(false);
  const [stampGalleryWidth, setStampGalleryWidth] = useState(320); // Default width in pixels
  const [isResizingStampGallery, setIsResizingStampGallery] = useState(false);
  // Start collapsed when URL has sidebar=0 (split-screen) so first paint is correct
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(
    () => useUIStore.getState().initialSidebarOpen === false
  );

  // Apply CTO URL initial sidebar state when set from CiviltakeoffView after load (clears initialSidebarOpen)
  useEffect(() => {
    if (initialSidebarOpen !== null) {
      setLeftSidebarCollapsed(!initialSidebarOpen);
      useUIStore.getState().setInitialSidebarOpen(null);
    }
  }, [initialSidebarOpen]);

  // WKWebView (macOS Tauri) discards rendering layers when minimized.
  // Force a repaint when the window becomes visible again.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        // Force layout recalculation to restore rendering
        document.body.style.display = "none";
        void document.body.offsetHeight;
        document.body.style.display = "";

        // Nudge React to re-render the viewer by toggling a harmless state
        window.dispatchEvent(new Event("resize"));
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Handle stamp gallery resize
  useEffect(() => {
    if (!isResizingStampGallery) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Find the left sidebar (thumbnails) to calculate relative position
      const leftSidebar = document.querySelector('aside:first-of-type');
      if (!leftSidebar) return;
      
      const leftSidebarRect = leftSidebar.getBoundingClientRect();
      const sidebarLeft = leftSidebarRect.left + leftSidebarRect.width;
      const newWidth = e.clientX - sidebarLeft;
      
      // Constrain width between 200px and 800px
      const constrainedWidth = Math.max(200, Math.min(800, newWidth));
      setStampGalleryWidth(constrainedWidth);
    };

    const handleMouseUp = () => {
      setIsResizingStampGallery(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizingStampGallery, stampGalleryWidth]);
  
  // Debug: Log loading state changes
  useEffect(() => {
    if (loading) {
      console.log("Loading state is true - should show spinner");
    }
  }, [loading]);
  
  // Enable keyboard shortcuts
  useKeyboard();

  // Get current editing annotation for formatting toolbar
  const currentDocument = usePDFStore.getState().getCurrentDocument();
  const [editorFocusKey, setEditorFocusKey] = useState(0);
  
  // Helper to find the currently editing annotation by finding the active editor
  const getEditingAnnotation = () => {
    if (!currentDocument) return null;
    
    const annotations = usePDFStore.getState().getAnnotations(currentDocument.getId());
    const currentSelectedId = selectedAnnotationId; // Capture current value for use in this function
    
    // First, try to find a focused editor
    const activeElement = document.activeElement as HTMLElement;
    let activeEditor: HTMLElement | null = null;
    
    if (activeElement && activeElement.hasAttribute("contenteditable") && 
        activeElement.getAttribute("data-rich-text-editor") === "true" &&
        activeElement.isContentEditable) {
      activeEditor = activeElement;
    }
    
    // If no focused editor, look for any editor that's in edit mode (contentEditable="true")
    // This handles the case when you first open a text box but it's not focused yet
    if (!activeEditor) {
      const editorsInEditMode = document.querySelectorAll(
        '[data-rich-text-editor="true"][contenteditable="true"]'
      );
      if (editorsInEditMode.length > 0) {
        activeEditor = editorsInEditMode[0] as HTMLElement;
      }
    }
    
    // If we found an editor, get its annotation
    if (activeEditor) {
      const annotationId = activeEditor.getAttribute("data-annotation-id");
      if (annotationId) {
        const annotation = annotations.find(
          (a) => a.id === annotationId && a.type === "text"
        );
        if (annotation) return annotation;
      }
    }
    
    // Check for selected editors (those with data-is-selected="true")
    // This prioritizes the selected text box over just any visible one
    const selectedEditors = document.querySelectorAll('[data-rich-text-editor="true"][data-is-selected="true"]');
    if (selectedEditors.length > 0) {
      // Use the first selected editor (there should typically only be one)
      const selectedEditor = selectedEditors[0] as HTMLElement;
      const annotationId = selectedEditor.getAttribute("data-annotation-id");
      if (annotationId) {
        const annotation = annotations.find(
          (a) => a.id === annotationId && a.type === "text"
        );
        if (annotation) return annotation;
      }
    }
    
    // Last resort: check for any visible editor element (selected but not in edit mode)
    // This handles the case when a text box is selected but not yet in edit mode
    const allEditors = document.querySelectorAll('[data-rich-text-editor="true"]');
    for (const editorEl of Array.from(allEditors)) {
      const element = editorEl as HTMLElement;
      // Check if element is visible (has offsetParent)
      if (element.offsetParent !== null) {
        const annotationId = element.getAttribute("data-annotation-id");
        if (annotationId) {
          const annotation = annotations.find(
            (a) => a.id === annotationId && a.type === "text"
          );
          if (annotation) return annotation;
        }
      }
    }
    
    // Check for selected highlights - look for highlight elements with data-selected attribute
    // or check if there's a highlight with a border (selected state)
    const selectedHighlights = document.querySelectorAll('[data-highlight-selected="true"]');
    if (selectedHighlights.length > 0) {
      const selectedHighlight = selectedHighlights[0] as HTMLElement;
      const annotationId = selectedHighlight.getAttribute("data-annotation-id");
      if (annotationId) {
        const annotation = annotations.find(
          (a) => a.id === annotationId && a.type === "highlight"
        );
        if (annotation) return annotation;
      }
    }
    
    // Check for selected stamps first - look for stamp elements with data-annotation-id
    // Stamps are selected via setEditingAnnotation in PageCanvas
    // Check if selectedAnnotationId matches a stamp (prioritize this)
    if (currentSelectedId !== null) {
      const stampAnnotation = annotations.find(
        (a) => a.id === currentSelectedId && a.type === "stamp"
      );
      if (stampAnnotation) {
        return stampAnnotation;
      }
    }
    
    // Also check DOM for stamp elements
    const selectedStamps = document.querySelectorAll('[data-annotation-id]');
    for (const stampEl of Array.from(selectedStamps)) {
      const element = stampEl as HTMLElement;
      if (element.offsetParent !== null) {
        const annotationId = element.getAttribute("data-annotation-id");
        if (annotationId) {
          const annotation = annotations.find(
            (a) => a.id === annotationId && a.type === "stamp"
          );
          if (annotation) {
            return annotation;
          }
        }
      }
    }
    
    // Check for selected shapes - look for shape elements with data-annotation-id
    // Shapes are selected via setEditingAnnotation in PageCanvas, so we need to check
    // the annotations store for any shape that might be selected
    // We'll use a custom event or check the annotationSelected event detail
    const selectedShapes = document.querySelectorAll('[data-annotation-id]');
    for (const shapeEl of Array.from(selectedShapes)) {
      const element = shapeEl as HTMLElement;
      // Check if this is a shape element (has data-annotation-id and is visible)
      if (element.offsetParent !== null) {
        const annotationId = element.getAttribute("data-annotation-id");
        if (annotationId) {
          const annotation = annotations.find(
            (a) => a.id === annotationId && a.type === "shape"
          );
          // For shapes, we need to check if they're selected via editingAnnotation
          // Since PageCanvas dispatches annotationSelected event, we can check
          // if this annotation matches the last selected one
          if (annotation) {
            // Check if this annotation was recently selected (within last event)
            // We'll rely on the annotationSelected event to update annotationSelectionKey
            // which will trigger a re-computation. For now, return the first shape found
            // if we're in select mode
            return annotation;
          }
        }
      }
    }
    
    return null;
  };
  
  // Listen for focus events to update when entering edit mode
  useEffect(() => {
    const handleFocus = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target && target.hasAttribute("data-rich-text-editor")) {
        // Force re-render to update editingAnnotation
        setEditorFocusKey(prev => prev + 1);
      }
    };
    
    document.addEventListener('focusin', handleFocus);
    
    return () => {
      document.removeEventListener('focusin', handleFocus);
    };
  }, []);
  
  // Track selected annotation ID from events
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  
  // Re-compute editingAnnotation when editor focus changes or document changes
  const [annotationSelectionKey, setAnnotationSelectionKey] = useState(0);
  // Force re-computation when annotationSelectionKey changes
  const editingAnnotation = React.useMemo(() => {
    // If we have a selectedAnnotationId, try to get that annotation
    if (selectedAnnotationId !== null && currentDocument) {
      const annotations = usePDFStore.getState().getAnnotations(currentDocument.getId());
      const annotation = annotations.find(a => a.id === selectedAnnotationId);
      if (annotation) {
        return annotation;
      }
      // Annotation not found, return null
      return null;
    }
    
    // If selectedAnnotationId is null, check if we should use DOM-based detection
    // This is for text/highlight annotations that don't use selectedAnnotationId
    // For shapes, if selectedAnnotationId is null, this will return null, closing the toolbar
    return getEditingAnnotation();
  }, [annotationSelectionKey, editorFocusKey, currentDocument, selectedAnnotationId]);
  
  // Listen for annotation selection events from PageCanvas
  useEffect(() => {
    const handleAnnotationSelected = (e: Event) => {
      const customEvent = e as CustomEvent<{ annotationId: string }>;
      if (customEvent.detail?.annotationId) {
        setSelectedAnnotationId(customEvent.detail.annotationId);
      }
      // Wait for DOM to update, then force re-computation of editingAnnotation
      requestAnimationFrame(() => {
        setAnnotationSelectionKey(prev => prev + 1);
      });
    };
    
    const handleClearEditingAnnotation = () => {
      setSelectedAnnotationId(null);
      setAnnotationSelectionKey(prev => prev + 1);
    };
    
    const handleDeleteSelected = async () => {
      // Get current editing annotation and document at the time of the event
      const currentDoc = usePDFStore.getState().getCurrentDocument();
      if (!currentDoc) return;
      
      // Get the current editing annotation - prioritize editingAnnotation memo
      // This ensures we get the correct annotation for all types (text, highlight, shape, draw, form, stamp)
      let annotToDelete = editingAnnotation;
      
      // If editingAnnotation is null, try to get from selectedAnnotationId
      if (!annotToDelete && selectedAnnotationId !== null) {
        const annotations = usePDFStore.getState().getAnnotations(currentDoc.getId());
        annotToDelete = annotations.find(a => a.id === selectedAnnotationId) || null;
      }
      
      // Last resort: try DOM-based detection (for text/highlight that might not be in editingAnnotation)
      if (!annotToDelete) {
        annotToDelete = getEditingAnnotation();
      }
      
      // If no annotation found, don't delete anything (especially not the page!)
      if (!annotToDelete) {
        console.log("No annotation selected to delete");
        return;
      }
      
      try {
        // Import mupdf and create editor instance
        const mupdfModule = await import("mupdf");
        const { PDFEditor } = await import("@/core/pdf/PDFEditor");
        const editor = new PDFEditor(mupdfModule.default);
        
        // Delete from PDF
        await editor.deleteAnnotation(
          currentDoc,
          annotToDelete
        );
        
      // Remove from store
      usePDFStore.getState().removeAnnotation(
        currentDoc.getId(),
        annotToDelete.id
      );
      
      // Clear editing annotation
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement && activeElement.hasAttribute("data-rich-text-editor")) {
        activeElement.blur();
      }
      const selectedHighlights = document.querySelectorAll('[data-highlight-selected="true"]');
      selectedHighlights.forEach(el => el.removeAttribute("data-highlight-selected"));
        
        // Clear selected annotation ID
        setSelectedAnnotationId(null);
        
        // Dispatch clear event
        window.dispatchEvent(new CustomEvent("clearEditingAnnotation"));
        
        // Record undo
        useUndoRedoStore.getState().pushAction({
          type: "removeAnnotation",
          documentId: currentDoc.getId(),
          beforeState: {},
          afterState: {},
          actionData: {
            annotationId: annotToDelete.id,
            annotation: annotToDelete,
          },
          undo: async () => {
            // Undo logic would go here
          },
          redo: async () => {
            // Redo logic would go here
          },
        });
      } catch (error) {
        console.error("Error deleting annotation:", error);
      }
    };
    
    window.addEventListener("annotationSelected", handleAnnotationSelected);
    window.addEventListener("clearEditingAnnotation", handleClearEditingAnnotation);
    window.addEventListener("deleteSelectedAnnotation", handleDeleteSelected);
    
    return () => {
      window.removeEventListener("annotationSelected", handleAnnotationSelected);
      window.removeEventListener("clearEditingAnnotation", handleClearEditingAnnotation);
      window.removeEventListener("deleteSelectedAnnotation", handleDeleteSelected);
    };
  }, [selectedAnnotationId, editingAnnotation, getEditingAnnotation]);

  // Track edit mode state
  const [isEditing, setIsEditing] = useState(false);
  
  // Check if we're in edit mode (any editor has contentEditable="true")
  useEffect(() => {
    const checkEditMode = () => {
      const editorsInEditMode = document.querySelectorAll(
        '[data-rich-text-editor="true"][contenteditable="true"]'
      );
      setIsEditing(editorsInEditMode.length > 0);
    };
    
    // Check initially
    checkEditMode();
    
    // Listen for focus/blur events on editors
    const handleFocus = () => {
      setTimeout(checkEditMode, 0);
    };
    
    const handleBlur = () => {
      setTimeout(checkEditMode, 0);
    };
    
    // Listen for attribute changes (contentEditable changes)
    const observer = new MutationObserver(() => {
      checkEditMode();
    });
    
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['contenteditable'],
      subtree: true,
    });
    
    document.addEventListener('focusin', handleFocus);
    document.addEventListener('focusout', handleBlur);
    
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', handleFocus);
      document.removeEventListener('focusout', handleBlur);
    };
  }, [editorFocusKey]);

  // Handler for drag-and-drop area button
  const handleOpenFileFromButton = async () => {
    const pdfStore = usePDFStore.getState();
    try {
      // Set loading state early, before file picker
      pdfStore.setLoading(true);
      
      const result = await fileSystem.openFile();
      if (result) {
        // Initialize mupdf
        const mupdfModule = await import("mupdf");
        await loadPDF(result.data, result.name, mupdfModule.default, result.path || null);
      } else {
        // User cancelled, clear loading
        pdfStore.setLoading(false);
      }
    } catch (error) {
      console.error("Error loading PDF:", error);
      pdfStore.setLoading(false);
    }
  };

  // Create a new blank PDF project (single page) and open Document Settings
  const handleCreateProject = async () => {
    const pdfStore = usePDFStore.getState();
    try {
      pdfStore.setLoading(true);
      const { PDFDocument } = await import("pdf-lib");
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage([612, 792]); // US Letter
      const bytes = await pdfDoc.save();
      const mupdfModule = await import("mupdf");
      await loadPDF(bytes, "Untitled.pdf", mupdfModule.default, null);
      setRequestDocumentSettingsOpen(true);
      showNotification("New PDF project created.", "success");
    } catch (error) {
      console.error("Error creating PDF project:", error);
      showNotification("Failed to create PDF project.", "error");
    } finally {
      pdfStore.setLoading(false);
    }
  };

  // Sync active tab with current document
  useEffect(() => {
    const activeTab = useTabStore.getState().getActiveTab();
    if (activeTab) {
      setCurrentDocument(activeTab.documentId);
    }
  }, [tabs, setCurrentDocument]);

  // Show recent files modal on startup if no PDF is loaded and recent files exist
  useEffect(() => {
    if (!currentDocument) {
      const recentFiles = getRecentFiles();
      if (recentFiles.length > 0) {
        // Small delay to ensure UI is ready
        const timer = setTimeout(() => {
          setShowRecentFilesOnStartup(true);
        }, 500);
        return () => clearTimeout(timer);
      }
    } else {
      setShowRecentFilesOnStartup(false);
    }
  }, [currentDocument, getRecentFiles]);

  // Listen for file open events from Tauri (when PDF is opened from system)
  useEffect(() => {
    // Only attach in Tauri environment (standard v2 detection)
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    let cancelled = false;
    let unlistenFn: (() => void) | null = null;

    // Use the standard Tauri v2 event API
    import('@tauri-apps/api/event').then(({ listen }) => {
      if (cancelled) return;

      listen<string>("open-pdf-file", async (event) => {
        const filePath = event.payload;
        if (!filePath || typeof filePath !== "string") return;

        const pdfStore = usePDFStore.getState();
        try {
          pdfStore.setLoading(true);
          pdfStore.clearError();

          const fileData = await fileSystem.readFile(filePath);
          const fileName = filePath.split(/[/\\]/).pop() || "file.pdf";
          const mupdfModule = await import("mupdf");
          await loadPDF(fileData, fileName, mupdfModule.default, filePath);
        } catch (error) {
          console.error("Error opening PDF from system:", error);
          pdfStore.setLoading(false);
          const errorMessage = error instanceof Error ? error.message : "Failed to open PDF file";
          pdfStore.setError(errorMessage);
          showNotification(errorMessage, "error");
        }
      }).then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlistenFn = fn;
        }
      });
    }).catch(() => {
      // Not in Tauri or event module unavailable - silently skip
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }, [fileSystem, loadPDF]);

  // Get root props but override title to prevent tooltip (spread all dropzone props so drag-and-drop works)
  const rootProps = getRootProps();
  const { title, ...restRootProps } = ((rootProps && typeof rootProps === 'object') ? rootProps : {}) as { title?: string; [key: string]: unknown };
  
  return (
    <div
      {...restRootProps}
      className={cn(
        "w-screen flex flex-col bg-background overflow-hidden",
        splitScreenMode ? "h-full min-h-0" : "h-screen",
        isDragActive && "ring-2 ring-primary ring-offset-2"
      )}
      title=""
    >
      {/* Only render file input when no PDF is loaded to prevent interference with tab clicks */}
      {!currentDocument && <input {...getInputProps()} />}
      
      {/* Notification Toast */}
      <NotificationToast />
      
      {/* Loading Indicator */}
      <LoadingIndicator isLoading={loading} />
      
      {/* Large drag and drop area when no PDF is loaded */}
      {!currentDocument && (
        <div 
          className="absolute inset-0 z-40 flex items-center justify-center bg-muted/50"
          title=""
        >
          <div
            className={cn(
              "flex flex-col items-center justify-center p-16 rounded-2xl border-2 border-dashed transition-all",
              "bg-background shadow-xl max-w-2xl mx-auto",
              isDragActive
                ? "border-primary bg-primary/5 scale-105"
                : "border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5"
            )}
            title=""
          >
            <div className={cn(
              "rounded-full p-6 mb-6 transition-all",
              isDragActive ? "bg-primary/10" : "bg-muted"
            )}>
              {isDragActive ? (
                <Upload className="h-16 w-16 text-primary animate-bounce" />
              ) : (
                <FileText className="h-16 w-16 text-muted-foreground" />
              )}
            </div>
            <h2 className="text-3xl font-bold mb-2 text-foreground">
              {isDragActive ? "Drop PDF here" : "Open a PDF Document"}
            </h2>
            <p className="text-lg text-muted-foreground mb-8 text-center max-w-md">
              {isDragActive
                ? "Release to open the PDF file"
                : "Drag and drop a PDF file here, or click the button below to browse"}
            </p>
            <div className="flex gap-3">
              <Button
                onClick={handleOpenFileFromButton}
                size="lg"
                className="text-lg px-8 py-6 h-auto"
                data-action="open"
              >
                <File className="h-5 w-5 mr-2" />
                Browse Files
              </Button>
              <Button
                onClick={() => navigate("/stitch")}
                size="lg"
                variant="outline"
                className="text-lg px-8 py-6 h-auto"
              >
                <Layers className="h-5 w-5 mr-2" />
                Stitch PDFs
              </Button>
            </div>
            <p className="text-muted-foreground mt-3 text-sm">
              or{" "}
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={loading}
                className="underline underline-offset-2 hover:text-foreground focus:outline-none focus:ring-0 disabled:opacity-50"
              >
                create a PDF project
              </button>
            </p>
          </div>
        </div>
      )}

      {/* Drag overlay when PDF is loaded but dragging */}
      {currentDocument && isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="text-center">
            <FileText className="h-16 w-16 mx-auto mb-4 text-primary" />
            <p className="text-2xl font-semibold">Drop PDF files here</p>
          </div>
        </div>
      )}

      {/* Top Toolbar - Tabs + Tool-specific settings */}
      {currentDocument && !splitScreenMode && (
        <div className="flex-shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">
          {/* Tool-specific toolbar row - fixed height */}
          <div className="h-8 flex items-center border-b border-border/50" data-tour="editor-undo-redo">
            {activeTool === "highlight" && <HighlightToolbar />}
            {activeTool === "draw" && <DrawToolbar />}
            {activeTool === "select" && editingAnnotation?.type === "draw" && (
              <DrawToolbar selectedAnnotation={editingAnnotation} />
            )}
            {activeTool === "shape" && <ShapeToolbar />}
            {activeTool === "select" && editingAnnotation?.type === "shape" && (
              <ShapeToolbar selectedAnnotation={editingAnnotation} />
            )}
            {activeTool === "form" && <FormToolbar />}
            {(activeTool === "text" || activeTool === "selectText" || (activeTool === "select" && (!editingAnnotation || (editingAnnotation.type !== "shape" && editingAnnotation.type !== "draw")))) && (
              <TextFormattingToolbar
                onFormat={(_command, _value) => {}}
                onFontChange={(font) => {
                  const annot = getEditingAnnotation();
                  if (annot && currentDocument) {
                    wrapAnnotationUpdate(currentDocument.getId(), annot.id, { fontFamily: font });
                  }
                }}
                onFontSizeChange={(size) => {
                  const annot = getEditingAnnotation();
                  if (annot && currentDocument) {
                    wrapAnnotationUpdate(currentDocument.getId(), annot.id, { fontSize: size });
                  }
                }}
                onColorChange={(color) => {
                  const annot = getEditingAnnotation();
                  if (annot && currentDocument) {
                    wrapAnnotationUpdate(currentDocument.getId(), annot.id, { color: color });
                  }
                }}
                onBackgroundToggle={(enabled) => {
                  const annot = getEditingAnnotation();
                  if (annot && currentDocument) {
                    wrapAnnotationUpdate(currentDocument.getId(), annot.id, { hasBackground: enabled });
                  }
                }}
                onBackgroundColorChange={(color) => {
                  const annot = getEditingAnnotation();
                  if (annot && currentDocument) {
                    wrapAnnotationUpdate(currentDocument.getId(), annot.id, { backgroundColor: color });
                  }
                }}
                defaultFont={editingAnnotation?.fontFamily || "Arial"}
                defaultFontSize={editingAnnotation?.fontSize || 12}
                defaultColor={editingAnnotation?.color || "rgba(0, 0, 0, 1)"}
                defaultHasBackground={editingAnnotation?.hasBackground !== undefined ? editingAnnotation.hasBackground : true}
                defaultBackgroundColor={editingAnnotation?.backgroundColor || "rgba(255, 255, 255, 0)"}
                isEditing={isEditing}
                hasSelection={!!editingAnnotation}
                onDelete={async () => {
                  let annot = editingAnnotation;
                  if (!annot) { annot = getEditingAnnotation(); }
                  if (!annot || !currentDocument) return;
                  try {
                    const mupdfModule = await import("mupdf");
                    const { PDFEditor } = await import("@/core/pdf/PDFEditor");
                    const editor = new PDFEditor(mupdfModule.default);
                    await editor.deleteAnnotation(currentDocument, annot);
                    const { wrapAnnotationOperation } = await import("@/shared/stores/undoHelpers");
                    wrapAnnotationOperation(
                      () => {
                        usePDFStore.getState().removeAnnotation(currentDocument.getId(), annot.id);
                        const activeElement = document.activeElement as HTMLElement;
                        if (activeElement && activeElement.hasAttribute("data-rich-text-editor")) {
                          activeElement.blur();
                        }
                        const selectedHighlights = document.querySelectorAll('[data-highlight-selected="true"]');
                        selectedHighlights.forEach((el) => { el.setAttribute("data-highlight-selected", "false"); });
                        window.dispatchEvent(new CustomEvent("clearEditingAnnotation", { detail: { annotationId: annot.id } }));
                      },
                      "removeAnnotation",
                      currentDocument.getId(),
                      annot.id,
                      undefined,
                      annot
                    );
                  } catch (error) {
                    console.error("Error deleting annotation:", error);
                  }
                }}
              />
            )}

            {/* Spacer + Undo/Redo */}
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 pr-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => undo()}
                disabled={!canUndo}
                className="h-6 w-6"
                title="Undo"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => redo()}
                disabled={!canRedo}
                className="h-6 w-6"
                title="Redo"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {/* Tabs row */}
          <div className="h-7 flex items-center">
            <TabBar />
          </div>
        </div>
      )}

      {/* Main Content - Sidebar + Viewer; use h-full in split-screen to fill iframe and remove bottom gap */}
      <div className={cn("flex overflow-hidden relative min-h-0 flex-1", splitScreenMode && "h-full")}>
        {/* Left Sidebar - Thumbnails and Bookmarks (collapsible). Content kept mounted when collapsed so thumbnails stay cached. */}
        <aside
          data-tour="editor-page-sidebar"
          className={cn(
            "border-r bg-secondary/50 flex flex-col overflow-hidden flex-shrink-0 transition-[width] duration-200 ease-out relative",
            leftSidebarCollapsed ? "w-8" : "w-64"
          )}
        >
          {/* Sidebar content: always mounted so ThumbnailCarousel cache is preserved when expanding */}
          <div className={cn("flex h-full w-64 shrink-0 flex-col min-h-0", leftSidebarCollapsed && "absolute left-0 top-0 bottom-0 pointer-events-none opacity-0")}>
            <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">
              <div className="flex-1 overflow-hidden min-h-0">
                <ThumbnailCarousel />
              </div>
              {/* Collapse button on right edge (overlay) - pointer-events restored when expanded */}
              {!leftSidebarCollapsed && (
                <div className="absolute right-0 top-2 bottom-0 w-8 flex items-start justify-center pt-2 bg-gradient-to-l from-secondary/80 to-transparent pointer-events-none">
                  <div className="pointer-events-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 rounded-md shadow-sm bg-background/90 hover:bg-background border border-border/50"
                      onClick={() => setLeftSidebarCollapsed(true)}
                      title="Collapse page navigation"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            <div className="flex-shrink-0">
              <BookmarksPanel />
            </div>
            </div>
          </div>
          {/* Expand button: visible when collapsed, on top so it receives clicks */}
          {leftSidebarCollapsed && (
            <div className="flex flex-col items-center py-2 h-full pointer-events-auto">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 rounded-md"
                onClick={() => setLeftSidebarCollapsed(false)}
                title="Expand page navigation"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </aside>

        {/* Stamp Gallery Panel - appears when stamp tool is active (hidden in split-screen) */}
        {activeTool === "stamp" && !splitScreenMode && (
          <aside 
            className={cn(
              "absolute top-0 bottom-0 border-r bg-background flex flex-col overflow-hidden z-50 shadow-lg",
              leftSidebarCollapsed ? "left-8" : "left-64"
            )}
            style={{ width: `${stampGalleryWidth}px` }}
          >
            <div className="border-b bg-secondary/50 p-4 flex-shrink-0 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Stamp Gallery</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  useUIStore.getState().setActiveTool("select");
                }}
                className="h-7 w-7 rounded-md hover:bg-muted"
                title="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              <StampGallery
                onCreateNew={() => {
                  setShowStampCreator(true);
                }}
                onClose={() => {
                  // Setting active tool to "select" will automatically hide the sidebar
                  useUIStore.getState().setActiveTool("select");
                }}
              />
            </div>
            {/* Resize handle */}
            <div
              className="absolute top-0 right-0 w-2 h-full cursor-col-resize hover:bg-primary/30 bg-transparent transition-colors z-10 group"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsResizingStampGallery(true);
              }}
            >
              <div className="absolute top-1/2 right-0 -translate-y-1/2 w-1 h-12 bg-border group-hover:bg-primary rounded-full transition-colors" />
            </div>
          </aside>
        )}

        {/* Center - Large Viewer */}
        <main className="flex-1 flex flex-col overflow-hidden min-h-0 bg-muted" data-tour="editor-viewer">
          {splitScreenMode && <CTOSplitScreenToolbar />}
          <div className="flex-1 min-h-0 overflow-hidden flex">
            <PDFViewer />
          </div>
        </main>
        
        {/* Right Sidebar - AI panel (collapsible) + Tools (hidden in split-screen mode) */}
        {!splitScreenMode && esignMode === "prepare" && (
          <aside className="flex border-l bg-secondary/50 overflow-hidden h-full">
            <ESignPrepareToolbar />
          </aside>
        )}
        {!splitScreenMode && !esignMode && (
          <aside className="flex border-l bg-secondary/50 overflow-hidden h-full">
            <RedlinePanel />
            <AISidePanel />
            <div className="w-16 flex flex-col overflow-hidden shrink-0">
              <Toolbar />
            </div>
          </aside>
        )}
      </div>

      {/* Recent Files Modal on Startup */}
      <RecentFilesModal
        open={showRecentFilesOnStartup}
        onOpenChange={setShowRecentFilesOnStartup}
      />


      {/* Stamp Creator Modal */}
      <StampCreator
        open={showStampCreator}
        onClose={() => setShowStampCreator(false)}
      />

      {/* Guided Tour Overlay */}
      <TourOverlay tourId="editor" />

      {/* E-Sign signing mode overlay */}
      {esignMode === "sign" && (
        <ESignSigningView documentSubject={useTabStore.getState().getActiveTab()?.name?.replace(/\.pdf$/i, '') || "Document"} />
      )}
    </div>
  );
}

export default Editor;

