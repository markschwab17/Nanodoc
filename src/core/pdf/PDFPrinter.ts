/**
 * PDF Printer
 * 
 * Handles printing PDF documents using browser print API with advanced layout settings.
 */

import type { PDFDocument } from "./PDFDocument";
import type { PrintSettings, PageSizeDimensions, MarginSettings } from "@/shared/stores/printStore";
import { PAGE_SIZES, MARGIN_PRESETS } from "@/shared/stores/printStore";

export class PDFPrinter {
  private mupdf: any;

  constructor(mupdf: any) {
    this.mupdf = mupdf;
  }

  /**
   * Print the entire PDF document with default settings
   */
  async printDocument(document: PDFDocument, settings?: PrintSettings): Promise<void> {
    const pageCount = document.getPageCount();
    await this.printPages(document, 0, pageCount - 1, settings);
  }

  /**
   * Print a range of pages with advanced layout settings
   */
  async printPages(
    document: PDFDocument,
    startPage: number,
    endPage: number,
    settings?: PrintSettings
  ): Promise<void> {
    // Use default settings if none provided
    const printSettings: PrintSettings = settings || {
      orientation: "auto",
      pageSize: "letter",
      customPageSize: PAGE_SIZES.letter,
      pagesPerSheet: 1,
      pageOrder: "horizontal",
      marginPreset: "none",
      customMargins: MARGIN_PRESETS.none,
      scalingMode: "fit",
      customScale: 100,
      printRange: "all",
      customRange: "",
    };

    // Get page size and margins
    const pageSize = printSettings.pageSize === "custom" 
      ? printSettings.customPageSize 
      : PAGE_SIZES[printSettings.pageSize];
    const margins = printSettings.marginPreset === "custom"
      ? printSettings.customMargins
      : MARGIN_PRESETS[printSettings.marginPreset];

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

      interface PageImage {
        dataUrl: string;
        isLandscape: boolean;
        pageNumber: number;
      }

      const pageImages: PageImage[] = [];

      // Render all pages to images
      for (let i = startPage; i <= endPage && i < document.getPageCount(); i++) {
        try {
          const pageImage = await this.renderPageToImage(pdfDoc, i);
          pageImages.push(pageImage);
        } catch (error) {
          console.error(`Error rendering page ${i} for printing:`, error);
        }
      }

      // Generate HTML based on pages per sheet setting
      const htmlContent = this.generatePrintHTML(
        pageImages,
        printSettings,
        pageSize,
        margins
      );

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
  async printCurrentPage(
    document: PDFDocument, 
    pageNumber: number, 
    settings?: PrintSettings
  ): Promise<void> {
    await this.printPages(document, pageNumber, pageNumber, settings);
  }

  /**
   * Render a single PDF page to an image
   */
  private async renderPageToImage(
    pdfDoc: any,
    pageIndex: number
  ): Promise<{ dataUrl: string; isLandscape: boolean; pageNumber: number }> {
    const page = pdfDoc.loadPage(pageIndex);
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
    
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

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
    
    return {
      dataUrl,
      isLandscape,
      pageNumber: pageIndex,
    };
  }

  /**
   * Generate print HTML with all layout settings applied
   */
  private generatePrintHTML(
    pageImages: Array<{ dataUrl: string; isLandscape: boolean; pageNumber: number }>,
    settings: PrintSettings,
    pageSize: PageSizeDimensions,
    margins: MarginSettings
  ): string {
    const { pagesPerSheet, pageOrder, orientation, scalingMode, customScale } = settings;

    // Determine page size and orientation
    let paperWidth = pageSize.width;
    let paperHeight = pageSize.height;
    let pageOrientation = "portrait";

    // Check if we should apply orientation override
    if (orientation === "landscape") {
      pageOrientation = "landscape";
      // Swap width and height for landscape
      [paperWidth, paperHeight] = [paperHeight, paperWidth];
    } else if (orientation === "portrait") {
      pageOrientation = "portrait";
    }

    // Calculate scaling factor
    let scaleFactor = 1;
    if (scalingMode === "actual") {
      scaleFactor = 1;
    } else if (scalingMode === "custom") {
      scaleFactor = customScale / 100;
    }
    // For "fit" mode, scaling is handled by CSS

    // Generate CSS
    const css = this.generatePrintCSS(
      paperWidth,
      paperHeight,
      pageOrientation,
      margins,
      pagesPerSheet,
      scaleFactor,
      scalingMode
    );

    // Generate page HTML
    const pageHTML = this.generatePageHTML(
      pageImages,
      pagesPerSheet,
      pageOrder,
      paperWidth,
      paperHeight,
      margins,
      orientation,
      scaleFactor,
      scalingMode
    );

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print PDF</title>
        <style>${css}</style>
      </head>
      <body>
        ${pageHTML}
      </body>
      </html>
    `;
  }

  /**
   * Generate CSS for print layout
   */
  private generatePrintCSS(
    paperWidth: number,
    paperHeight: number,
    orientation: string,
    margins: MarginSettings,
    pagesPerSheet: number,
    scaleFactor: number,
    scalingMode: string
  ): string {
    const marginStr = `${margins.top}in ${margins.right}in ${margins.bottom}in ${margins.left}in`;

    return `
      * {
        box-sizing: border-box;
      }

      @page {
        size: ${paperWidth}in ${paperHeight}in ${orientation === "auto" ? "" : orientation};
        margin: ${marginStr};
      }

      @media print {
        body {
          margin: 0;
          padding: 0;
        }

        .print-sheet {
          page-break-after: always;
          page-break-inside: avoid;
          width: 100%;
          height: 100%;
          display: ${pagesPerSheet > 1 ? "grid" : "block"};
          ${pagesPerSheet === 2 ? "grid-template-columns: 1fr 1fr; grid-template-rows: 1fr;" : ""}
          ${pagesPerSheet === 4 ? "grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;" : ""}
          ${pagesPerSheet === 6 ? "grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr 1fr;" : ""}
          ${pagesPerSheet === 9 ? "grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr;" : ""}
          ${pagesPerSheet === 16 ? "grid-template-columns: 1fr 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr 1fr;" : ""}
          gap: ${pagesPerSheet > 1 ? "0.1in" : "0"};
        }

        .print-sheet:last-child {
          page-break-after: auto;
        }

        .page-container {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .page-container img {
          ${scalingMode === "fit" ? "max-width: 100%; max-height: 100%;" : ""}
          ${scalingMode === "actual" || scalingMode === "custom" ? `width: auto; height: auto; transform: scale(${scaleFactor});` : ""}
          object-fit: contain;
          display: block;
        }
      }

      @media screen {
        body {
          margin: 20px;
          background: #f0f0f0;
        }

        .print-sheet {
          background: white;
          box-shadow: 0 0 10px rgba(0,0,0,0.1);
          margin-bottom: 20px;
          padding: 0.5in;
          display: ${pagesPerSheet > 1 ? "grid" : "block"};
          ${pagesPerSheet === 2 ? "grid-template-columns: 1fr 1fr; grid-template-rows: 1fr;" : ""}
          ${pagesPerSheet === 4 ? "grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;" : ""}
          ${pagesPerSheet === 6 ? "grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr 1fr;" : ""}
          ${pagesPerSheet === 9 ? "grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr;" : ""}
          ${pagesPerSheet === 16 ? "grid-template-columns: 1fr 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr 1fr;" : ""}
          gap: 10px;
        }

        .page-container {
          border: 1px solid #ddd;
          background: white;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .page-container img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
      }
    `;
  }

  /**
   * Generate HTML for pages
   */
  private generatePageHTML(
    pageImages: Array<{ dataUrl: string; isLandscape: boolean; pageNumber: number }>,
    pagesPerSheet: number,
    _pageOrder: string,
    _paperWidth: number,
    _paperHeight: number,
    _margins: MarginSettings,
    _orientation: string,
    _scaleFactor: number,
    _scalingMode: string
  ): string {
    if (pagesPerSheet === 1) {
      // Simple case: one page per sheet
      return pageImages
        .map(
          (img) => `
          <div class="print-sheet">
            <div class="page-container">
              <img src="${img.dataUrl}" alt="Page ${img.pageNumber + 1}" />
            </div>
          </div>
        `
        )
        .join("\n");
    }

    // N-up printing: multiple pages per sheet
    const sheets: string[] = [];
    let currentSheet: Array<{ dataUrl: string; isLandscape: boolean; pageNumber: number }> = [];

    for (let i = 0; i < pageImages.length; i++) {
      currentSheet.push(pageImages[i]);

      if (currentSheet.length === pagesPerSheet || i === pageImages.length - 1) {
        // Generate a sheet
        const sheetHTML = `
          <div class="print-sheet">
            ${currentSheet
              .map(
                (img) => `
              <div class="page-container">
                <img src="${img.dataUrl}" alt="Page ${img.pageNumber + 1}" />
              </div>
            `
              )
              .join("\n")}
            ${Array(pagesPerSheet - currentSheet.length)
              .fill("")
              .map(() => '<div class="page-container"></div>')
              .join("\n")}
          </div>
        `;
        sheets.push(sheetHTML);
        currentSheet = [];
      }
    }

    return sheets.join("\n");
  }
}





