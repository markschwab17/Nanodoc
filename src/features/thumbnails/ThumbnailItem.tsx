/**
 * Thumbnail Item Component
 * 
 * Individual thumbnail in the carousel.
 */

import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { Trash2, RotateCw } from "lucide-react";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { usePDFStore } from "@/shared/stores/pdfStore";

interface ThumbnailItemProps {
  document: PDFDocument;
  pageNumber: number;
  renderer: PDFRenderer;
  isActive: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDelete?: (e: React.MouseEvent) => void;
  onRotate?: (e: React.MouseEvent) => void;
  onDragStart?: () => void;
}

export function ThumbnailItem({
  document,
  pageNumber,
  renderer,
  isActive,
  onClick,
  onDelete,
  onRotate,
  onDragStart: _onDragStart,
}: ThumbnailItemProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLandscape, setIsLandscape] = useState<boolean>(false);
  const { getAnnotations } = usePDFStore();

  useEffect(() => {
    const loadThumbnail = async () => {
      if (!document.isDocumentLoaded() || !renderer) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        
        // Get page metadata to determine orientation
        const pageMetadata = document.getPageMetadata(pageNumber);
        if (pageMetadata) {
          // Determine if landscape or portrait based on width vs height
          setIsLandscape(pageMetadata.width > pageMetadata.height);
        }
        
        const mupdfDoc = document.getMupdfDocument();
        if (!mupdfDoc) {
          throw new Error("Mupdf document not available");
        }
        
        const dataUrl = await renderer.renderPageToDataURL(mupdfDoc, pageNumber, {
          scale: 0.15,
        });
        
        if (dataUrl) {
          setThumbnailUrl(dataUrl);
        } else {
          throw new Error("Failed to generate thumbnail data URL");
        }
      } catch (error) {
        console.error(`Error loading thumbnail for page ${pageNumber}:`, error);
        setThumbnailUrl(null);
      } finally {
        setIsLoading(false);
      }
    };

    loadThumbnail();
  }, [document, pageNumber, renderer, document?.getPageMetadata(pageNumber)?.rotation, document?.getPageCount()]);

  // Use fixed aspect ratios: landscape (4:3) or portrait (3:4)
  const aspectRatio = isLandscape ? 4 / 3 : 3 / 4;

  const handleDragStart = async (e: React.DragEvent) => {
    // Stop propagation to prevent parent drag handlers from interfering
    e.stopPropagation();
    
    // This is a drag-out operation - prepare the page as PDF file
    // The parent's page reordering is handled at a different level
    try {
      // Get all annotations for this page
      const documentId = document.getId();
      const allAnnotations = getAnnotations(documentId);
      const pageAnnotations = allAnnotations.filter(ann => ann.pageNumber === pageNumber);

      // Initialize mupdf and editor
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);

      // Export the page as PDF
      const pdfData = await editor.exportPageAsPDF(document, pageNumber, pageAnnotations);

      // Create a File object from the PDF data
      const fileName = `${document.getName().replace('.pdf', '')}_page_${pageNumber + 1}.pdf`;
      const file = new File([pdfData as BlobPart], fileName, { type: 'application/pdf' });

      // Set the file in the data transfer
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/pdf', '');
      e.dataTransfer.setData('text/plain', fileName);
      e.dataTransfer.setData('application/x-page-export', 'true'); // Mark as page export
      
      // Use the items API to add the file (for dragging out of browser)
      if (e.dataTransfer.items) {
        // Don't clear items - we want to add the file
        try {
          e.dataTransfer.items.add(file);
        } catch (err) {
          // If items can't be modified, try fallback
          console.warn("Could not add file to dataTransfer.items, using fallback:", err);
          const blobUrl = URL.createObjectURL(file);
          e.dataTransfer.setData('DownloadURL', `application/pdf:${fileName}:${blobUrl}`);
        }
      } else {
        // Fallback for older browsers
        const blobUrl = URL.createObjectURL(file);
        e.dataTransfer.setData('DownloadURL', `application/pdf:${fileName}:${blobUrl}`);
      }

      // For Tauri, we might need to use a different approach
      // Check if we're in Tauri environment
      if (typeof window !== "undefined" && (window as any).__TAURI__) {
        // Tauri handles file drags differently - the file will be available via the drag event
        // The browser API should still work, but we can enhance it if needed
      }
    } catch (error) {
      console.error("Error preparing page for drag-out:", error);
      // Don't prevent the drag, just log the error
    }
  };

  return (
    <div
      className={cn(
        "relative flex-shrink-0 border-2 rounded cursor-pointer transition-all bg-background group",
        isActive
          ? "border-primary shadow-lg ring-2 ring-primary/20"
          : "border-border hover:border-primary/50 hover:shadow-md"
      )}
      style={{ 
        aspectRatio: aspectRatio, 
        width: '120px',
        height: 'auto'
      }}
      onClick={onClick}
      draggable
      onDragStart={handleDragStart}
    >
      {isLoading ? (
        <div className="w-full h-full flex items-center justify-center bg-muted rounded">
          <div className="text-xs text-muted-foreground animate-pulse">Loading...</div>
        </div>
      ) : thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={`Page ${pageNumber + 1}`}
          className="w-full h-full object-contain rounded"
          onError={() => {
            console.error(`Failed to load thumbnail image for page ${pageNumber}`);
            setThumbnailUrl(null);
          }}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-muted rounded">
          <div className="text-sm font-medium text-muted-foreground mb-1">Page {pageNumber + 1}</div>
          <div className="text-xs text-muted-foreground/70">No preview</div>
        </div>
      )}
      {/* Action buttons in top right */}
      <div className="absolute top-1 right-1 flex gap-1 z-20">
        {onRotate && (
          <button
            type="button"
            className="h-6 w-6 bg-primary hover:bg-primary/90 text-primary-foreground rounded flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onRotate(e);
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            title="Rotate Page"
          >
            <RotateCw className="h-3 w-3" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="h-6 w-6 bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDelete(e);
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            title="Delete Page"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-sm font-medium text-center py-1.5 rounded-b">
        {pageNumber + 1}
      </div>
    </div>
  );
}

