/**
 * PDF Printer
 * 
 * Handles printing PDF documents using browser print API.
 */

import type { PDFDocument } from "./PDFDocument";

export class PDFPrinter {
  private mupdf: any;

  constructor(mupdf: any) {
    this.mupdf = mupdf;
  }

  /**
   * Print the entire PDF document
   */
  async printDocument(document: PDFDocument): Promise<void> {
    const pageCount = document.getPageCount();
    await this.printPages(document, 0, pageCount - 1);
  }

  /**
   * Print a range of pages
   */
  async printPages(
    document: PDFDocument,
    startPage: number,
    endPage: number
  ): Promise<void> {
    // Create a hidden iframe for printing (no new tab)
    const iframe = window.document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    window.document.body.appendChild(iframe);

    try {
      const mupdfDoc = document.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      
      if (!pdfDoc) {
        throw new Error("Document is not a PDF");
      }

      const imagePromises: Array<Promise<{ html: string; isLandscape: boolean }>> = [];

      for (let i = startPage; i <= endPage && i < document.getPageCount(); i++) {
        try {
          const page = pdfDoc.loadPage(i);
          const bounds = page.getBounds();
          const pageWidth = bounds[2] - bounds[0];
          const pageHeight = bounds[3] - bounds[1];
          
          // Determine orientation
          const isLandscape = pageWidth > pageHeight;
          
          // Use higher DPI for print quality (300 DPI)
          const printDPI = 300;
          const pdfDPI = 72;
          const scale = printDPI / pdfDPI;
          
          // Render page to pixmap with high quality
          const matrix = this.mupdf.Matrix.scale(scale, scale);
          const pixmap = page.toPixmap(
            matrix,
            this.mupdf.ColorSpace.DeviceRGB,
            false,
            true
          );
          
          // Get pixmap dimensions
          const widthScaled = pixmap.getWidth();
          const heightScaled = pixmap.getHeight();
          const pixels = pixmap.getPixels();
          const components = pixmap.getNumberOfComponents();
          
          // Create canvas to convert to image
          const canvas = window.document.createElement("canvas");
          canvas.width = widthScaled;
          canvas.height = heightScaled;
          const ctx = canvas.getContext("2d", { 
            willReadFrequently: false,
            colorSpace: "srgb"
          });
          
          if (ctx) {
            // Create ImageData
            const imageData = ctx.createImageData(widthScaled, heightScaled);
            const data = imageData.data;
            const pixelData = pixels;
            
            // Copy pixel data based on component count
            const numPixels = widthScaled * heightScaled;
            
            if (components === 4) {
              // RGBA format - copy directly
              data.set(pixelData);
            } else if (components === 3) {
              // RGB format - need to add alpha channel
              for (let j = 0; j < numPixels; j++) {
                const srcIdx = j * 3;
                const dstIdx = j * 4;
                data[dstIdx] = pixelData[srcIdx];     // R
                data[dstIdx + 1] = pixelData[srcIdx + 1]; // G
                data[dstIdx + 2] = pixelData[srcIdx + 2]; // B
                data[dstIdx + 3] = 255; // A (fully opaque)
              }
            } else {
              // Fallback: try to handle other formats
              console.warn(`Unexpected component count: ${components}, attempting RGBA copy`);
              if (pixelData.length >= numPixels * 4) {
                data.set(pixelData.subarray(0, numPixels * 4));
              }
            }
            
            ctx.putImageData(imageData, 0, 0);
            
            // Convert to high-quality PNG
            const dataUrl = canvas.toDataURL("image/png", 1.0);
            
            // Calculate proper dimensions in inches for print (PDF points to inches: 72pt = 1 inch)
            const widthInches = pageWidth / 72;
            const heightInches = pageHeight / 72;
            
            // Store the image data URL with proper dimensions and orientation
            imagePromises.push(
              Promise.resolve({
                html: `<div class="page" style="width: ${widthInches}in; height: ${heightInches}in; page-break-after: always; page-break-inside: avoid;"><img src="${dataUrl}" style="width: 100%; height: 100%; object-fit: contain; display: block;" /></div>`,
                isLandscape
              })
            );
          }
        } catch (error) {
          console.error(`Error rendering page ${i} for printing:`, error);
          imagePromises.push(Promise.resolve({
            html: `<div class="page">Error rendering page ${i + 1}</div>`,
            isLandscape: false
          }));
        }
      }

      // Wait for all images to be processed
      const images = await Promise.all(imagePromises);
      
      // Build HTML content - each page will have its own orientation
      // Use CSS to set orientation per page
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Print PDF</title>
          <style>
            @page {
              margin: 0;
            }
            @media print {
              body { 
                margin: 0; 
                padding: 0; 
              }
              .page { 
                page-break-after: always; 
                page-break-inside: avoid;
                display: block;
                margin: 0;
                padding: 0;
              }
              .page:last-child { 
                page-break-after: auto; 
              }
              .page.landscape {
                size: landscape;
              }
              .page.portrait {
                size: portrait;
              }
            }
            @media screen {
              body { 
                margin: 20px; 
                background: #f0f0f0;
              }
              .page {
                background: white;
                box-shadow: 0 0 10px rgba(0,0,0,0.1);
                margin-bottom: 20px;
              }
            }
          </style>
        </head>
        <body>
          ${images.map(img => {
            // Add orientation class to each page div
            const orientationClass = img.isLandscape ? 'landscape' : 'portrait';
            return img.html.replace('<div class="page"', `<div class="page ${orientationClass}"`);
          }).join('\n')}
        </body>
        </html>
      `;

      // Write content to iframe
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) {
        throw new Error("Failed to access iframe document");
      }

      iframeDoc.open();
      iframeDoc.write(htmlContent);
      iframeDoc.close();
      
      // Wait for images to load, then print
      const iframeWindow = iframe.contentWindow;
      if (!iframeWindow) {
        throw new Error("Failed to access iframe window");
      }

      iframeWindow.onload = () => {
        setTimeout(() => {
          iframeWindow.print();
          // Clean up iframe after printing
          setTimeout(() => {
            if (window.document.body.contains(iframe)) {
              window.document.body.removeChild(iframe);
            }
          }, 1000);
        }, 500);
      };

      // Fallback: if onload doesn't fire, try printing after a delay
      setTimeout(() => {
        if (iframeWindow.document.readyState === 'complete') {
          iframeWindow.print();
          setTimeout(() => {
            if (window.document.body.contains(iframe)) {
              window.document.body.removeChild(iframe);
            }
          }, 1000);
        }
      }, 2000);
    } catch (error) {
      // Clean up iframe on error
      if (window.document.body.contains(iframe)) {
        window.document.body.removeChild(iframe);
      }
      throw error;
    }
  }

  /**
   * Print current page only
   */
  async printCurrentPage(document: PDFDocument, pageNumber: number): Promise<void> {
    await this.printPages(document, pageNumber, pageNumber);
  }
}

