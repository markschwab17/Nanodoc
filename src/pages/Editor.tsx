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
import { ThumbnailCarousel } from "@/features/thumbnails/ThumbnailCarousel";
import { BookmarksPanel } from "@/features/bookmarks/BookmarksPanel";
import { Toolbar } from "@/features/toolbar/Toolbar";
import { TextFormattingToolbar } from "@/features/viewer/TextFormattingToolbar";
import { HighlightToolbar } from "@/features/viewer/HighlightToolbar";
import { SearchBar } from "@/features/search/SearchBar";
import { RecentFilesModal } from "@/features/recent/RecentFilesModal";
import { Button } from "@/components/ui/button";
import { FileText, Upload, File } from "lucide-react";
import { cn } from "@/lib/utils";
import { NotificationToast } from "@/shared/components/NotificationToast";
import { LoadingIndicator } from "@/shared/components/LoadingIndicator";
import { wrapAnnotationUpdate } from "@/shared/stores/undoHelpers";
import { useNotificationStore } from "@/shared/stores/notificationStore";

function Editor() {
  const { getRootProps, getInputProps, isDragActive } = useDragDrop();
  const { tabs } = useTabStore();
  const { setCurrentDocument } = usePDFStore();
  const { getRecentFiles } = useRecentFilesStore();
  const { readMode, activeTool } = useUIStore();
  const fileSystem = useFileSystem();
  const { loadPDF, loading } = usePDF();
  const { showNotification } = useNotificationStore();
  const [showRecentFilesOnStartup, setShowRecentFilesOnStartup] = useState(false);
  
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
    
    // Also check annotations store for any highlight that might be selected
    // This is a fallback - we'll use a more direct approach by checking PageCanvas state
    // For now, return null and we'll handle highlights differently
    
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
  
  // Re-compute editingAnnotation when editor focus changes or document changes
  const [annotationSelectionKey, setAnnotationSelectionKey] = useState(0);
  // Force re-computation when annotationSelectionKey changes
  const editingAnnotation = React.useMemo(() => {
    return getEditingAnnotation();
  }, [annotationSelectionKey, editorFocusKey, currentDocument]);
  
  // Listen for annotation selection events from PageCanvas
  useEffect(() => {
    const handleAnnotationSelected = () => {
      // Wait for DOM to update, then force re-computation of editingAnnotation
      requestAnimationFrame(() => {
        setAnnotationSelectionKey(prev => prev + 1);
      });
    };
    
    window.addEventListener("annotationSelected", handleAnnotationSelected);
    
    return () => {
      window.removeEventListener("annotationSelected", handleAnnotationSelected);
    };
  }, []);

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
    // Check if we're in Tauri environment
    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      const { listen } = (window as any).__TAURI__.event;
      
      // Listen for open-pdf-file event
      const unlisten = listen("open-pdf-file", async (event: any) => {
        const filePath = event.payload;
        console.log("Received open-pdf-file event:", filePath);
        
        if (filePath && typeof filePath === "string") {
          const pdfStore = usePDFStore.getState();
          try {
            pdfStore.setLoading(true);
            pdfStore.clearError();
            
            // Read the file
            console.log("Reading file from path:", filePath);
            const fileData = await fileSystem.readFile(filePath);
            console.log("File read successfully, size:", fileData.length);
            
            const fileName = filePath.split(/[/\\]/).pop() || "file.pdf";
            
            // Load the PDF
            console.log("Loading PDF:", fileName);
            const mupdfModule = await import("mupdf");
            await loadPDF(fileData, fileName, mupdfModule.default, filePath);
            console.log("PDF loaded successfully");
          } catch (error) {
            console.error("Error opening PDF from system:", error);
            pdfStore.setLoading(false);
            const errorMessage = error instanceof Error ? error.message : "Failed to open PDF file";
            pdfStore.setError(errorMessage);
            showNotification(errorMessage, "error");
          }
        } else {
          console.warn("Invalid file path received:", filePath);
        }
      });

      return () => {
        unlisten.then((fn: () => void) => fn());
      };
    }
  }, [fileSystem, loadPDF]);

  // Get root props but override title to prevent tooltip
  const rootProps = getRootProps();
  const { title, ...restRootProps } = (rootProps && typeof rootProps === 'object' && 'title' in rootProps) ? rootProps : {};
  
  return (
    <div
      {...restRootProps}
      className={cn(
        "h-screen w-screen flex flex-col bg-background",
        isDragActive && "ring-2 ring-primary ring-offset-2"
      )}
      title=""
    >
      <input {...getInputProps()} />
      
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
            <Button
              onClick={handleOpenFileFromButton}
              size="lg"
              className="text-lg px-8 py-6 h-auto"
              data-action="open"
            >
              <File className="h-5 w-5 mr-2" />
              Browse Files
            </Button>
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

      {/* Main Content - Sidebar + Viewer - extends to top */}
      <div className="h-screen flex overflow-hidden">
        {/* Left Sidebar - Thumbnails and Bookmarks */}
        <aside className="w-64 border-r bg-secondary/50 flex flex-col overflow-hidden">
          {/* Thumbnails Section - takes available space from top */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <div className="border-b bg-background">
              <SearchBar />
            </div>
            <div className="flex-1 overflow-hidden">
              <ThumbnailCarousel />
            </div>
          </div>
          
          {/* Bookmarks Section - positioned at bottom, expands upward */}
          <div className="flex-shrink-0">
            <BookmarksPanel />
          </div>
        </aside>

        {/* Center - Large Viewer */}
        <main className="flex-1 flex overflow-hidden bg-muted">
          <PDFViewer />
        </main>
        
        {/* Right Sidebar - Tools */}
        <aside className="w-16 border-l bg-secondary/50 flex flex-col overflow-hidden">
          <Toolbar />
        </aside>
      </div>

      {/* Floating Highlight Toolbar - only when highlight tool is active and PDF is loaded */}
      {currentDocument && !readMode && activeTool === "highlight" && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40">
          <div className="bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-lg">
            <HighlightToolbar />
          </div>
        </div>
      )}

      {/* Floating Text Formatting Toolbar with Tabs - show when PDF is loaded and not in read mode */}
      {currentDocument && !readMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40">
          <div className="bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-lg flex flex-col">
            <TextFormattingToolbar
              onFormat={(_command, _value) => {
                // Formatting is handled by document.execCommand in the toolbar
              }}
              onFontChange={(font) => {
                // Update annotation font family with undo/redo support
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  wrapAnnotationUpdate(
                    currentDocument.getId(),
                    annot.id,
                    { fontFamily: font }
                  );
                }
              }}
              onFontSizeChange={(size) => {
                // Update annotation font size with undo/redo support
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  wrapAnnotationUpdate(
                    currentDocument.getId(),
                    annot.id,
                    { fontSize: size }
                  );
                }
              }}
              onColorChange={(color) => {
                // Update annotation color with undo/redo support
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  wrapAnnotationUpdate(
                    currentDocument.getId(),
                    annot.id,
                    { color: color }
                  );
                }
              }}
              onBackgroundToggle={(enabled) => {
                // Update annotation background with undo/redo support
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  wrapAnnotationUpdate(
                    currentDocument.getId(),
                    annot.id,
                    { hasBackground: enabled }
                  );
                }
              }}
              onBackgroundColorChange={(color) => {
                // Update annotation background color with undo/redo support
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  wrapAnnotationUpdate(
                    currentDocument.getId(),
                    annot.id,
                    { backgroundColor: color }
                  );
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
                const annot = getEditingAnnotation();
                if (!annot || !currentDocument) return;
                
                try {
                  // Import mupdf and create editor instance
                  const mupdfModule = await import("mupdf");
                  const { PDFEditor } = await import("@/core/pdf/PDFEditor");
                  const editor = new PDFEditor(mupdfModule.default);
                  
                  // Delete from PDF
                  await editor.deleteAnnotation(currentDocument, annot);
                  
                  // Delete from state with undo/redo support
                  const { wrapAnnotationOperation } = await import("@/shared/stores/undoHelpers");
                  wrapAnnotationOperation(
                    () => {
                      usePDFStore.getState().removeAnnotation(
                        currentDocument.getId(),
                        annot.id
                      );
                      // Clear editing annotation - handle both text boxes and highlights
                      const activeElement = document.activeElement as HTMLElement;
                      if (activeElement && activeElement.hasAttribute("data-rich-text-editor")) {
                        activeElement.blur();
                      }
                      // Clear highlight selection by removing data attribute
                      const selectedHighlights = document.querySelectorAll('[data-highlight-selected="true"]');
                      selectedHighlights.forEach((el) => {
                        el.setAttribute("data-highlight-selected", "false");
                      });
                      // Dispatch a custom event to notify PageCanvas to clear editingAnnotation
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
            {/* Tabs in separate row at bottom edge */}
            <div className="border-t border-border">
              <TabBar />
            </div>
          </div>
        </div>
      )}

      {/* Recent Files Modal on Startup */}
      <RecentFilesModal
        open={showRecentFilesOnStartup}
        onOpenChange={setShowRecentFilesOnStartup}
      />

    </div>
  );
}

export default Editor;

