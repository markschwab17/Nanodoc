/**
 * Print Preview Component
 * 
 * Visual preview showing how PDF pages will be laid out on physical paper
 */

import { useState, useEffect } from "react";
// import { useRef } from "react"; // Reserved for future use with canvasRefs
import { PrintSettings, PAGE_SIZES, MARGIN_PRESETS } from "@/shared/stores/printStore";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PDFDocument } from "@/core/pdf/PDFDocument";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";

interface PrintPreviewProps {
  settings: PrintSettings;
  totalPages: number;
  document: PDFDocument | null;
  renderer: PDFRenderer | null;
}

export function PrintPreview({ settings, totalPages, document, renderer }: PrintPreviewProps) {
  const { 
    pagesPerSheet, 
    pageSize, 
    customPageSize, 
    orientation, 
    printRange, 
    customRange,
    marginPreset,
    customMargins,
    scalingMode,
    customScale
  } = settings;
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [pageImages, setPageImages] = useState<Map<number, string>>(new Map());
  const [pageDimensions, setPageDimensions] = useState<Map<number, { width: number; height: number }>>(new Map());
  // const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map()); // Reserved for future use

  // Get actual page size
  const paperSize = pageSize === "custom" ? customPageSize : PAGE_SIZES[pageSize];
  
  // Get margins
  const margins = marginPreset === "custom" ? customMargins : MARGIN_PRESETS[marginPreset] || { top: 0, right: 0, bottom: 0, left: 0 };
  
  // Calculate how many pages will be printed based on range
  let pagesToPrint = totalPages;
  if (printRange === "current") {
    pagesToPrint = 1;
  } else if (printRange === "custom" && customRange) {
    // Parse custom range to count pages
    const pages = parsePageRange(customRange, totalPages);
    pagesToPrint = pages.length;
  }

  // Calculate how many physical sheets will be used
  const sheetsNeeded = Math.ceil(pagesToPrint / pagesPerSheet);

  // Determine paper aspect ratio for visualization
  let paperWidth = paperSize.width;
  let paperHeight = paperSize.height;
  
  // Apply orientation if not auto
  if (orientation === "landscape") {
    [paperWidth, paperHeight] = [paperHeight, paperWidth];
  }

  // Scale for display (max 300px width)
  const displayScale = Math.min(300 / paperWidth, 200 / paperHeight);
  const displayWidth = paperWidth * displayScale;
  const displayHeight = paperHeight * displayScale;

  // Calculate grid layout for N-up printing
  const getGridDimensions = (n: number): { cols: number; rows: number } => {
    switch (n) {
      case 1: return { cols: 1, rows: 1 };
      case 2: return { cols: 2, rows: 1 };
      case 4: return { cols: 2, rows: 2 };
      case 6: return { cols: 2, rows: 3 };
      case 9: return { cols: 3, rows: 3 };
      case 16: return { cols: 4, rows: 4 };
      default: return { cols: 1, rows: 1 };
    }
  };

  const { cols, rows } = getGridDimensions(pagesPerSheet);

  // Helper to parse page ranges
  function parsePageRange(rangeStr: string, total: number): number[] {
    const pages: number[] = [];
    const parts = rangeStr.split(",").map((s) => s.trim());

    for (const part of parts) {
      if (part.includes("-")) {
        const [startStr, endStr] = part.split("-").map((s) => s.trim());
        const start = Math.max(1, parseInt(startStr) || 1);
        const end = Math.min(total, parseInt(endStr) || total);
        for (let i = start; i <= end; i++) {
          if (!pages.includes(i)) pages.push(i);
        }
      } else {
        const pageNum = parseInt(part);
        if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= total) {
          if (!pages.includes(pageNum)) pages.push(pageNum);
        }
      }
    }

    return pages.sort((a, b) => a - b);
  }

  // Get the page numbers that will be printed
  const getPagesToPrint = (): number[] => {
    if (printRange === "current") {
      return [0]; // Will be replaced with actual current page
    } else if (printRange === "custom" && customRange) {
      const pages = parsePageRange(customRange, totalPages);
      return pages.map(p => p - 1); // Convert to 0-based
    }
    // All pages
    return Array.from({ length: totalPages }, (_, i) => i);
  };

  const pagesToPrintArray = getPagesToPrint();

  // Get pages for current sheet
  const getPagesForSheet = (sheetIdx: number): number[] => {
    const startIdx = sheetIdx * pagesPerSheet;
    return pagesToPrintArray.slice(startIdx, startIdx + pagesPerSheet);
  };

  const currentSheetPages = getPagesForSheet(currentSheetIndex);

  // Render PDF page thumbnails
  useEffect(() => {
    if (!document || !renderer) return;

    const renderPages = async () => {
      try {
        const mupdfDoc = document.getMupdfDocument();
        if (!mupdfDoc) return;

        for (const pageNum of currentSheetPages) {
          if (pageImages.has(pageNum)) continue; // Already rendered

          try {
            // Get page dimensions
            const pageMetadata = document.getPageMetadata(pageNum);
            if (pageMetadata) {
              setPageDimensions(prev => new Map(prev).set(pageNum, { 
                width: pageMetadata.width, 
                height: pageMetadata.height 
              }));
            }

            // Render using the renderer (same as thumbnails)
            const dataUrl = await renderer.renderPageToDataURL(mupdfDoc, pageNum, {
              scale: 0.3, // Slightly higher quality than thumbnails
            });

            if (dataUrl) {
              setPageImages(prev => new Map(prev).set(pageNum, dataUrl));
            }
          } catch (error) {
            console.error(`Error rendering preview for page ${pageNum}:`, error);
          }
        }
      } catch (error) {
        console.error("Error rendering print preview:", error);
      }
    };

    renderPages();
  }, [document, renderer, currentSheetPages]);

  // Navigation handlers
  const canGoPrev = currentSheetIndex > 0;
  const canGoNext = currentSheetIndex < sheetsNeeded - 1;

  const handlePrev = () => {
    if (canGoPrev) {
      setCurrentSheetIndex(prev => prev - 1);
    }
  };

  const handleNext = () => {
    if (canGoNext) {
      setCurrentSheetIndex(prev => prev + 1);
    }
  };

  return (
    <div className="flex flex-col items-center space-y-4">
      {/* Navigation header */}
      {sheetsNeeded > 1 && (
        <div className="flex items-center gap-2 w-full justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrev}
            disabled={!canGoPrev}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium">
            Sheet {currentSheetIndex + 1} of {sheetsNeeded}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNext}
            disabled={!canGoNext}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Paper visualization */}
      <div className="relative">
        <div
          className="bg-white border-2 border-gray-300 shadow-lg rounded-sm relative overflow-hidden"
          style={{
            width: `${displayWidth}px`,
            height: `${displayHeight}px`,
          }}
        >
          {/* Grid showing page layout with actual page content */}
          <div
            className="grid gap-1 h-full"
            style={{
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
              padding: `${margins.top * displayScale}px ${margins.right * displayScale}px ${margins.bottom * displayScale}px ${margins.left * displayScale}px`,
            }}
          >
            {Array.from({ length: pagesPerSheet }).map((_, idx) => {
              const pageNum = currentSheetPages[idx];
              const hasPage = pageNum !== undefined;
              const pageImage = hasPage ? pageImages.get(pageNum) : null;
              const pageDims = hasPage ? pageDimensions.get(pageNum) : null;

              // Calculate available space in this cell (accounting for margins and grid)
              const cellWidth = (displayWidth - (margins.left + margins.right) * displayScale) / cols;
              const cellHeight = (displayHeight - (margins.top + margins.bottom) * displayScale) / rows;

              // Calculate PDF page scale based on scaling mode
              let pdfScale = 1;
              if (pageDims && scalingMode === "fit") {
                // Convert PDF dimensions from points (72 DPI) to display pixels
                const pdfWidthInDisplay = (pageDims.width / 72) * displayScale;
                const pdfHeightInDisplay = (pageDims.height / 72) * displayScale;
                // Calculate scale to fit within cell while maintaining aspect ratio
                const scaleX = cellWidth / pdfWidthInDisplay;
                const scaleY = cellHeight / pdfHeightInDisplay;
                pdfScale = Math.min(scaleX, scaleY, 1); // Don't scale up beyond 100%
              } else if (scalingMode === "actual") {
                pdfScale = 1; // Actual size (100%)
              } else if (scalingMode === "custom") {
                pdfScale = customScale / 100;
              }

              return (
                <div
                  key={idx}
                  className={`border rounded-sm overflow-hidden flex items-center justify-center ${
                    hasPage
                      ? "border-primary/30 bg-white"
                      : "border-dashed border-gray-300 bg-gray-50"
                  }`}
                >
                  {pageImage ? (
                    <div className="relative w-full h-full flex items-center justify-center p-1">
                      {pageDims ? (() => {
                        // Calculate target display size: PDF dimensions in inches * displayScale * user's pdfScale
                        // PDF dimensions are in points (72 DPI), so divide by 72 to get inches
                        const targetWidthInches = (pageDims.width / 72) * pdfScale;
                        const targetHeightInches = (pageDims.height / 72) * pdfScale;
                        
                        // Convert to display pixels
                        const targetWidthPx = targetWidthInches * displayScale;
                        const targetHeightPx = targetHeightInches * displayScale;
                        
                        // Constrain to cell bounds while maintaining aspect ratio
                        const aspectRatio = targetWidthPx / targetHeightPx;
                        let finalWidth = Math.min(targetWidthPx, cellWidth);
                        let finalHeight = finalWidth / aspectRatio;
                        
                        if (finalHeight > cellHeight) {
                          finalHeight = cellHeight;
                          finalWidth = finalHeight * aspectRatio;
                        }
                        
                        return (
                          <img
                            src={pageImage}
                            alt={`Page ${pageNum + 1}`}
                            style={{
                              width: `${finalWidth}px`,
                              height: `${finalHeight}px`,
                              objectFit: 'contain',
                            }}
                          />
                        );
                      })() : (
                        <img
                          src={pageImage}
                          alt={`Page ${pageNum + 1}`}
                          className="max-w-full max-h-full object-contain"
                        />
                      )}
                      <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[8px] px-1 rounded">
                        {pageNum + 1}
                      </div>
                    </div>
                  ) : hasPage ? (
                    <div className="text-xs text-muted-foreground">
                      Loading page {pageNum + 1}...
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        
        {/* Paper size label */}
        <div className="absolute -bottom-6 left-0 right-0 text-center text-xs text-muted-foreground">
          {paperWidth}" × {paperHeight}"
        </div>
      </div>

      {/* Summary information */}
      <div className="text-sm text-center space-y-1 pt-2">
        <div className="font-medium">
          {pagesPerSheet === 1 ? (
            <>1 PDF page per physical sheet</>
          ) : (
            <>{pagesPerSheet} PDF pages per physical sheet</>
          )}
        </div>
        <div className="text-muted-foreground">
          {pagesToPrint} {pagesToPrint === 1 ? "page" : "pages"} to print • {sheetsNeeded}{" "}
          physical {sheetsNeeded === 1 ? "sheet" : "sheets"} needed
        </div>
        {pagesPerSheet > 1 && (
          <div className="text-xs text-muted-foreground">
            Pages arranged: {settings.pageOrder === "horizontal" ? "Across then Down" : "Down then Across"}
          </div>
        )}
      </div>
    </div>
  );
}

