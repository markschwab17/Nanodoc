/**
 * Redaction Tool Handler
 * 
 * Handles redaction tool interactions: selection, creation, and rendering
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { normalizeSelectionToRect, validatePDFRect } from "./coordinateHelpers";

export const RedactTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (coords) {
      context.setIsSelecting(true);
      context.setSelectionStart(coords);
      context.setSelectionEnd(coords);
    }
  },

  handleMouseUp: async (_e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) => {
    if (!selectionStart || !selectionEnd) return;

    const { document, pageNumber, addAnnotation, editor, renderer, canvasRef, BASE_SCALE } = context;
    const currentDocument = document;

    // Create redaction from selection box
    // Use standardized coordinate normalization to prevent Y-axis flipping issues
    const rect = normalizeSelectionToRect(selectionStart, selectionEnd);
    
    // Only create if box is large enough
    if (rect.width > 10 && rect.height > 10) {
      // Validate coordinates before creating annotation
      const pageMetadata = currentDocument.getPageMetadata(pageNumber);
      if (!pageMetadata) {
        context.setIsSelecting(false);
        context.setSelectionStart(null);
        context.setSelectionEnd(null);
        return;
      }

      // CRITICAL: Use original mediabox height (not swapped display height) for coordinate conversion
      // This must match getPDFCoordinates() which uses the same calculation
      // When page is rotated 90°/270°, display dimensions are swapped, but mediabox dimensions don't change
      let mediaboxHeight: number;
      if (pageMetadata.rotation === 90 || pageMetadata.rotation === 270) {
        // Display dimensions are swapped, so mediaboxHeight = displayWidth (original height)
        mediaboxHeight = pageMetadata.width;
      } else {
        // Display dimensions match mediabox dimensions
        mediaboxHeight = pageMetadata.height;
      }


      const validation = validatePDFRect(rect, mediaboxHeight);
      if (!validation.isValid) {
        console.error("Invalid redaction coordinates:", validation.error);
        useNotificationStore.getState().showNotification(
          "Invalid redaction coordinates - please try again",
          "error"
        );
        context.setIsSelecting(false);
        context.setSelectionStart(null);
        context.setSelectionEnd(null);
        return;
      }
      
      // CRITICAL COORDINATE SYSTEM CONVERSION FOR REDACT TOOL:
      // ============================================================
      // getPDFCoordinates() returns coordinates in PDF format: Y=0 at BOTTOM, increases UPWARD
      // normalizeSelectionToRect() preserves this format: rect.y is bottom edge (small Y), rect.y + height is top edge (large Y)
      //
      // However, mupdf's setRect() method expects coordinates where Y=0 is at the TOP (screen-like coordinates)
      // This is different from the standard PDF coordinate system!
      //
      // Conversion formula:
      // - PDF bottom edge (rect.y) → mupdf top edge: mediaboxHeight - (rect.y + rect.height)
      // - PDF top edge (rect.y + rect.height) → mupdf bottom edge: mediaboxHeight - rect.y
      //
      // Since annotation format uses (x, y) as bottom-left corner:
      // - mupdfY = mediaboxHeight - (rect.y + rect.height)  (this is the top edge in mupdf, but we store as y)
      // - height stays the same
      //
      // IMPORTANT: Use mediaboxHeight (original page height) not pageMetadata.height (display height)
      // This ensures consistency with getPDFCoordinates() which uses the same calculation
      // ============================================================
      const flippedY = mediaboxHeight - (rect.y + rect.height);
      
      
      // Create annotation with flipped Y coordinates for mupdf compatibility
      const annotation: Annotation = {
        id: `redact_${Date.now()}`,
        type: "redact",
        pageNumber,
        x: rect.x,        // Left edge (X coordinate unchanged)
        y: flippedY,     // Top edge in mupdf coordinates (Y=0 at top) - converted from PDF coords
        width: rect.width,
        height: rect.height, // Height stays the same
      };

      // Add to app state first (so it renders immediately)
      addAnnotation(currentDocument.getId(), annotation);

      // Write to PDF document and apply redaction
      if (!editor) {
        console.warn("PDF editor not initialized, redaction annotation not saved to PDF");
        useNotificationStore.getState().showNotification(
          "PDF editor not initialized",
          "error"
        );
      } else {
        try {
          // Apply redaction to PDF (this modifies the PDF content stream)
          await editor.addRedactionAnnotation(currentDocument, annotation);
          
          // CRITICAL: Clear all caches to force fresh render
          // 1. Clear renderer cache (image data cache)
          renderer.clearCache();
          
          // 2. Force document to refresh its page metadata cache
          // This ensures the PDFDocument object has the latest page information
          currentDocument.refreshPageMetadata();
          
          // 3. Reload the page in mupdf to get fresh content
          // This is critical - mupdf caches page objects internally
          const mupdfDoc = currentDocument.getMupdfDocument();
          const pdfDoc = mupdfDoc.asPDF();
          if (pdfDoc) {
            // Force reload by loading the page again
            // This clears mupdf's internal page cache
            pdfDoc.loadPage(pageNumber);
          }
          
          // 4. Force immediate re-render to show the redacted (white) area
          const canvas = canvasRef.current;
          if (canvas && currentDocument) {
            const renderPage = async () => {
              try {
                // Get fresh mupdf document reference
                const freshMupdfDoc = currentDocument.getMupdfDocument();
                
                // Render the page with updated content
                const rendered = await renderer.renderPage(freshMupdfDoc, pageNumber, {
                  scale: BASE_SCALE,
                  rotation: 0,
                });
                
                // Update canvas with new render, accounting for device pixel ratio
                const devicePixelRatio = window.devicePixelRatio || 1;
                const displayWidth = rendered.width;
                const displayHeight = rendered.height;
                
                // Set canvas internal resolution (actual pixels)
                canvas.width = displayWidth * devicePixelRatio;
                canvas.height = displayHeight * devicePixelRatio;
                
                // Set canvas display size (CSS pixels)
                canvas.style.width = `${displayWidth}px`;
                canvas.style.height = `${displayHeight}px`;
                
                const ctx = canvas.getContext("2d", {
                  willReadFrequently: false,
                  colorSpace: "srgb"
                });
                
                if (ctx && rendered.imageData instanceof ImageData) {
                  // Scale context to account for device pixel ratio
                  ctx.scale(devicePixelRatio, devicePixelRatio);
                  
                  // Disable image smoothing for crisp pixel-perfect rendering
                  ctx.imageSmoothingEnabled = false;
                  ctx.imageSmoothingQuality = "high";
                  
                  // Draw the rendered image data
                  ctx.putImageData(rendered.imageData, 0, 0);
                }
              } catch (err) {
                console.error("Error re-rendering after redaction:", err);
                useNotificationStore.getState().showNotification(
                  "Failed to re-render page after redaction",
                  "error"
                );
              }
            };
            
            // Render immediately (no delay needed since we've already applied the redaction)
            await renderPage();
          }
          
          // Show success notification
          useNotificationStore.getState().showNotification(
            "Content redacted - permanently removed from PDF",
            "success"
          );
          
        } catch (err) {
          console.error("Error during redaction:", err);
          console.error("Failed annotation:", annotation);
          
          // Show error notification to user
          useNotificationStore.getState().showNotification(
            `Redaction failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            "error"
          );
        }
      }
    }

    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },

};

