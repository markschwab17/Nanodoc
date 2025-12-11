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
}: ThumbnailItemProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [aspectRatio, setAspectRatio] = useState<number>(3 / 4); // Default portrait

  useEffect(() => {
    const loadThumbnail = async () => {
      if (!document.isDocumentLoaded() || !renderer) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        
        // Get page metadata for aspect ratio
        const pageMetadata = document.getPageMetadata(pageNumber);
        if (pageMetadata) {
          const ratio = pageMetadata.width / pageMetadata.height;
          setAspectRatio(ratio);
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
  }, [document, pageNumber, renderer, document?.getPageMetadata(pageNumber)?.rotation]);

  return (
    <div
      className={cn(
        "relative flex-shrink-0 w-full max-w-[140px] mx-auto border-2 rounded cursor-pointer transition-all bg-background group",
        isActive
          ? "border-primary shadow-lg ring-2 ring-primary/20"
          : "border-border hover:border-primary/50 hover:shadow-md"
      )}
      style={{ aspectRatio: aspectRatio }}
      onClick={onClick}
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
          <div className="text-xs text-muted-foreground mb-1">Page {pageNumber + 1}</div>
          <div className="text-[10px] text-muted-foreground/70">No preview</div>
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
      <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-1 rounded-b">
        {pageNumber + 1}
      </div>
    </div>
  );
}

