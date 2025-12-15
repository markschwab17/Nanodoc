import { useEffect, useState } from "react";
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

function App() {
  const { getRootProps, getInputProps, isDragActive } = useDragDrop();
  const { tabs } = useTabStore();
  const { setCurrentDocument } = usePDFStore();
  const { getRecentFiles } = useRecentFilesStore();
  const { readMode, activeTool } = useUIStore();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [showRecentFilesOnStartup, setShowRecentFilesOnStartup] = useState(false);
  
  // Enable keyboard shortcuts
  useKeyboard();
  
  // Get current editing annotation for formatting toolbar
  const currentDocument = usePDFStore.getState().getCurrentDocument();
  
  // Helper to find the currently editing annotation by finding the active editor
  const getEditingAnnotation = () => {
    if (!currentDocument) return null;
    
    // Find the active contentEditable editor (must be focused, not just contentEditable)
    const activeElement = document.activeElement as HTMLElement;
    let activeEditor: HTMLElement | null = null;
    
    // Only consider the editor if it's both contentEditable AND currently focused
    if (activeElement && activeElement.hasAttribute("contenteditable") && 
        activeElement.getAttribute("data-rich-text-editor") === "true" &&
        activeElement.isContentEditable) {
      activeEditor = activeElement;
    }
    
    // If no focused editor, don't return any annotation
    // This ensures we only style the actively focused text box
    if (!activeEditor) return null;
    
    // Get annotation ID from the editor's data attribute
    const annotationId = activeEditor.getAttribute("data-annotation-id");
    if (!annotationId) return null;
    
    // Find the annotation by ID
    const annotations = usePDFStore.getState().getAnnotations(currentDocument.getId());
    return annotations.find(
      (a) => a.id === annotationId && a.type === "text"
    ) || null;
  };
  
  const editingAnnotation = getEditingAnnotation();

  // Handler for drag-and-drop area button
  const handleOpenFileFromButton = async () => {
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
        if (filePath && typeof filePath === "string") {
          try {
            // Read the file
            const fileData = await fileSystem.readFile(filePath);
            const fileName = filePath.split(/[/\\]/).pop() || "file.pdf";
            
            // Load the PDF
            const mupdfModule = await import("mupdf");
            await loadPDF(fileData, fileName, mupdfModule.default, filePath);
          } catch (error) {
            console.error("Error opening PDF from system:", error);
          }
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
        <aside className="w-16 border-l bg-secondary/50 flex flex-col">
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

      {/* Floating Text Formatting Toolbar with Tabs - only when PDF is loaded and not in read mode */}
      {currentDocument && !readMode && activeTool !== "highlight" && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40">
          <div className="bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-lg flex flex-col">
            <TextFormattingToolbar
              onFormat={(_command, _value) => {
                // Formatting is handled by document.execCommand in the toolbar
              }}
              onFontChange={(font) => {
                // Update annotation font family
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  usePDFStore.getState().updateAnnotation(
                    currentDocument.getId(),
                    annot.id,
                    { fontFamily: font }
                  );
                }
              }}
              onFontSizeChange={(size) => {
                // Update annotation font size
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  usePDFStore.getState().updateAnnotation(
                    currentDocument.getId(),
                    annot.id,
                    { fontSize: size }
                  );
                }
              }}
              onColorChange={(color) => {
                // Update annotation color
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  usePDFStore.getState().updateAnnotation(
                    currentDocument.getId(),
                    annot.id,
                    { color: color }
                  );
                }
              }}
              onBackgroundToggle={(enabled) => {
                // Update annotation background
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  usePDFStore.getState().updateAnnotation(
                    currentDocument.getId(),
                    annot.id,
                    { hasBackground: enabled }
                  );
                }
              }}
              onBackgroundColorChange={(color) => {
                // Update annotation background color
                const annot = getEditingAnnotation();
                if (annot && currentDocument) {
                  usePDFStore.getState().updateAnnotation(
                    currentDocument.getId(),
                    annot.id,
                    { backgroundColor: color }
                  );
                }
              }}
              defaultFont={editingAnnotation?.fontFamily || "Arial"}
              defaultFontSize={editingAnnotation?.fontSize || 12}
              defaultColor={editingAnnotation?.color || "#000000"}
              defaultHasBackground={editingAnnotation?.hasBackground || false}
              defaultBackgroundColor={editingAnnotation?.backgroundColor || "#ffffff"}
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

export default App;
