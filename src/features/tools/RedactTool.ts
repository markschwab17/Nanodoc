/**
 * Redaction Tool Handler
 * 
 * Handles redaction tool interactions: selection, creation, and rendering
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useNotificationStore } from "@/shared/stores/notificationStore";

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
    // Note: PDF coordinates have Y=0 at bottom, so larger Y = higher up
    const minX = Math.min(selectionStart.x, selectionEnd.x);
    const minY = Math.min(selectionStart.y, selectionEnd.y); // Bottom edge
    const maxX = Math.max(selectionStart.x, selectionEnd.x);
    const maxY = Math.max(selectionStart.y, selectionEnd.y); // Top edge
    const width = maxX - minX;
    const height = maxY - minY;

    // Only create if box is large enough
    if (width > 10 && height > 10) {
      // Store bottom-left corner (minX, minY) for PDF rect
      const annotation: Annotation = {
        id: `redact_${Date.now()}`,
        type: "redact",
        pageNumber,
        x: minX,        // Left edge
        y: minY,        // Bottom edge
        width: width,
        height: height,
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
          console.log("🔄 Starting redaction process...");
          
          // Apply redaction to PDF (this modifies the PDF content stream)
          await editor.addRedactionAnnotation(currentDocument, annotation);
          
          console.log("✓ Redaction applied to PDF");
          
          // CRITICAL: Clear all caches to force fresh render
          // 1. Clear renderer cache (image data cache)
          renderer.clearCache();
          console.log("✓ Renderer cache cleared");
          
          // 2. Force document to refresh its page metadata cache
          // This ensures the PDFDocument object has the latest page information
          currentDocument.refreshPageMetadata();
          console.log("✓ Document metadata refreshed");
          
          // 3. Reload the page in mupdf to get fresh content
          // This is critical - mupdf caches page objects internally
          const mupdfDoc = currentDocument.getMupdfDocument();
          const pdfDoc = mupdfDoc.asPDF();
          if (pdfDoc) {
            // Force reload by loading the page again
            // This clears mupdf's internal page cache
            pdfDoc.loadPage(pageNumber);
            console.log("✓ Page reloaded in mupdf");
          }
          
          // 4. Force immediate re-render to show the redacted (white) area
          const canvas = canvasRef.current;
          if (canvas && currentDocument) {
            console.log("🎨 Re-rendering page to show redaction...");
            
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
                  console.log("✅ Page re-rendered successfully - redacted area should now show as white");
                }
              } catch (err) {
                console.error("❌ Error re-rendering after redaction:", err);
                useNotificationStore.getState().showNotification(
                  "Failed to re-render page after redaction",
                  "error"
                );
              }
            };
            
            // Render immediately (no delay needed since we've already applied the redaction)
            await renderPage();
          }
          
          console.log("✅ Redaction complete - content permanently removed");
          
          // Show success notification
          useNotificationStore.getState().showNotification(
            "Content redacted - permanently removed from PDF",
            "success"
          );
          
        } catch (err) {
          console.error("❌ Error during redaction:", err);
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

