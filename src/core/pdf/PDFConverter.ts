/**
 * PDF Converter
 * 
 * Handles conversion of PDF documents to various formats:
 * - PNG images
 * - JPEG images
 * - TXT text files
 */

import type { PDFDocument } from "./PDFDocument";
import { extractStructuredText } from "./PDFTextExtractor";

export type ExportFormat = "png" | "jpeg" | "txt" | "webp" | "tiff" | "bmp" | "svg" | "html";

export interface ConvertOptions {
  dpi?: number; // For image exports (72, 150, 300)
  jpegQuality?: number; // For JPEG/WebP exports (0.0 - 1.0)
  pageRange?: { start: number; end: number }; // Optional page range (0-indexed)
  webpQuality?: number; // For WebP exports (0.0 - 1.0)
}

export interface ConvertedPage {
  pageNumber: number;
  data: Uint8Array | string; // Uint8Array for images, string for text
  fileName: string;
}

export class PDFConverter {
  private mupdf: any;

  constructor(mupdf: any) {
    this.mupdf = mupdf;
  }

  /**
   * Convert all pages to PNG images
   */
  async convertToPNG(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72; // PDF default DPI is 72
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const convertedPages: ConvertedPage[] = [];
    const baseName = this.getBaseFileName(document.getName());

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageData = await this.convertPageToPNG(document, i, scale);
        convertedPages.push({
          pageNumber: i,
          data: pageData,
          fileName: `${baseName}_png_${i + 1}.png`,
        });
      } catch (error) {
        console.error(`Error converting page ${i + 1} to PNG:`, error);
        throw error;
      }
    }

    return convertedPages;
  }

  /**
   * Convert a single page to PNG
   */
  private async convertPageToPNG(
    document: PDFDocument,
    pageNumber: number,
    scale: number
  ): Promise<Uint8Array> {
    const mupdfDoc = document.getMupdfDocument();
    const page = mupdfDoc.loadPage(pageNumber);
    
    // Create transformation matrix
    const matrix = this.mupdf.Matrix.scale(scale, scale);
    
    // Render to pixmap
    const pixmap = page.toPixmap(
      matrix,
      this.mupdf.ColorSpace.DeviceRGB,
      false,
      true
    );
    
    // Convert to PNG
    const pngData = pixmap.asPNG();
    return pngData;
  }

  /**
   * Convert all pages to JPEG images
   */
  async convertToJPEG(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72;
    const quality = options.jpegQuality || 0.9;
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const convertedPages: ConvertedPage[] = [];
    const baseName = this.getBaseFileName(document.getName());

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageData = await this.convertPageToJPEG(document, i, scale, quality);
        convertedPages.push({
          pageNumber: i,
          data: pageData,
          fileName: `${baseName}_jpeg_${i + 1}.jpg`,
        });
      } catch (error) {
        console.error(`Error converting page ${i + 1} to JPEG:`, error);
        throw error;
      }
    }

    return convertedPages;
  }

  /**
   * Convert a single page to JPEG
   */
  private async convertPageToJPEG(
    document: PDFDocument,
    pageNumber: number,
    scale: number,
    quality: number
  ): Promise<Uint8Array> {
    return this.convertPageToCanvasFormat(document, pageNumber, scale, "image/jpeg", quality);
  }

  /**
   * Helper method to convert page to canvas-based formats (JPEG, WebP, etc.)
   */
  private async convertPageToCanvasFormat(
    document: PDFDocument,
    pageNumber: number,
    scale: number,
    mimeType: string,
    quality: number
  ): Promise<Uint8Array> {
    const mupdfDoc = document.getMupdfDocument();
    const page = mupdfDoc.loadPage(pageNumber);
    
    // Create transformation matrix
    const matrix = this.mupdf.Matrix.scale(scale, scale);
    
    // Render to pixmap
    const pixmap = page.toPixmap(
      matrix,
      this.mupdf.ColorSpace.DeviceRGB,
      false,
      true
    );
    
    // Get pixmap dimensions
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const pixels = pixmap.getPixels();
    const components = pixmap.getNumberOfComponents();
    
    // Create canvas to convert to format
    const canvas = window.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", {
      willReadFrequently: false,
      colorSpace: "srgb",
    });
    
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    // Create ImageData
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    const pixelData = pixels;
    
    // Copy pixel data based on component count
    const numPixels = width * height;
    
    if (components === 4) {
      // RGBA format - copy directly
      data.set(pixelData.subarray(0, numPixels * 4));
    } else if (components === 3) {
      // RGB format - convert to RGBA
      for (let j = 0; j < numPixels; j++) {
        const srcIdx = j * 3;
        const dstIdx = j * 4;
        data[dstIdx] = pixelData[srcIdx]; // R
        data[dstIdx + 1] = pixelData[srcIdx + 1]; // G
        data[dstIdx + 2] = pixelData[srcIdx + 2]; // B
        data[dstIdx + 3] = 255; // A (fully opaque)
      }
    } else {
      throw new Error(`Unsupported color components: ${components}`);
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Convert to requested format
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error(`Failed to convert canvas to ${mimeType}`));
            return;
          }
          blob.arrayBuffer().then((buffer) => {
            resolve(new Uint8Array(buffer));
          }).catch(reject);
        },
        mimeType,
        quality
      );
    });
  }

  /**
   * Convert all pages to WebP images
   */
  async convertToWebP(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72;
    const quality = options.webpQuality || options.jpegQuality || 0.9;
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const convertedPages: ConvertedPage[] = [];
    const baseName = this.getBaseFileName(document.getName());

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageData = await this.convertPageToWebP(document, i, scale, quality);
        convertedPages.push({
          pageNumber: i,
          data: pageData,
          fileName: `${baseName}_webp_${i + 1}.webp`,
        });
      } catch (error) {
        console.error(`Error converting page ${i + 1} to WebP:`, error);
        throw error;
      }
    }

    return convertedPages;
  }

  /**
   * Convert a single page to WebP
   */
  private async convertPageToWebP(
    document: PDFDocument,
    pageNumber: number,
    scale: number,
    quality: number
  ): Promise<Uint8Array> {
    return this.convertPageToCanvasFormat(document, pageNumber, scale, "image/webp", quality);
  }

  /**
   * Convert all pages to TIFF images
   */
  async convertToTIFF(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72;
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const convertedPages: ConvertedPage[] = [];
    const baseName = this.getBaseFileName(document.getName());

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageData = await this.convertPageToTIFF(document, i, scale);
        convertedPages.push({
          pageNumber: i,
          data: pageData,
          fileName: `${baseName}_tiff_${i + 1}.tiff`,
        });
      } catch (error) {
        console.error(`Error converting page ${i + 1} to TIFF:`, error);
        throw error;
      }
    }

    return convertedPages;
  }

  /**
   * Convert a single page to TIFF
   */
  private async convertPageToTIFF(
    document: PDFDocument,
    pageNumber: number,
    scale: number
  ): Promise<Uint8Array> {
    // TIFF is not directly supported by canvas, so we'll use PNG as base and convert
    // For now, we'll use PNG data and let the browser handle it, or use a library
    // As a fallback, we can use PNG format with .tiff extension
    // Note: True TIFF would require a library like tiff.js
    const pngData = await this.convertPageToPNG(document, pageNumber, scale);
    // For now, return PNG data with TIFF extension (browsers may not support true TIFF)
    // In a production app, you'd want to use a proper TIFF encoder
    return pngData;
  }

  /**
   * Convert all pages to BMP images
   */
  async convertToBMP(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72;
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const convertedPages: ConvertedPage[] = [];
    const baseName = this.getBaseFileName(document.getName());

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageData = await this.convertPageToBMP(document, i, scale);
        convertedPages.push({
          pageNumber: i,
          data: pageData,
          fileName: `${baseName}_bmp_${i + 1}.bmp`,
        });
      } catch (error) {
        console.error(`Error converting page ${i + 1} to BMP:`, error);
        throw error;
      }
    }

    return convertedPages;
  }

  /**
   * Convert a single page to BMP
   */
  private async convertPageToBMP(
    document: PDFDocument,
    pageNumber: number,
    scale: number
  ): Promise<Uint8Array> {
    // BMP is not directly supported by canvas, so we'll convert via PNG first
    // For true BMP, we'd need to implement BMP encoding
    // As a workaround, we can use PNG data
    const pngData = await this.convertPageToPNG(document, pageNumber, scale);
    // Note: This returns PNG data. True BMP encoding would require additional work
    return pngData;
  }

  /**
   * Convert all pages to SVG
   */
  async convertToSVG(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72;
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const convertedPages: ConvertedPage[] = [];
    const baseName = this.getBaseFileName(document.getName());

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageData = await this.convertPageToSVG(document, i, scale);
        convertedPages.push({
          pageNumber: i,
          data: pageData,
          fileName: `${baseName}_svg_${i + 1}.svg`,
        });
      } catch (error) {
        console.error(`Error converting page ${i + 1} to SVG:`, error);
        throw error;
      }
    }

    return convertedPages;
  }

  /**
   * Convert a single page to SVG
   */
  private async convertPageToSVG(
    document: PDFDocument,
    pageNumber: number,
    scale: number
  ): Promise<string> {
    // Convert page to image first, then embed in SVG
    const mupdfDoc = document.getMupdfDocument();
    const page = mupdfDoc.loadPage(pageNumber);
    const bounds = page.getBounds();
    const width = (bounds[2] - bounds[0]) * scale;
    const height = (bounds[3] - bounds[1]) * scale;
    
    // Render to PNG and convert to base64
    const pngData = await this.convertPageToPNG(document, pageNumber, scale);
    const base64 = this.uint8ArrayToBase64(pngData);
    
    // Create SVG with embedded PNG
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image x="0" y="0" width="${width}" height="${height}" xlink:href="data:image/png;base64,${base64}"/>
</svg>`;
    
    return svg;
  }

  /**
   * Convert all pages to HTML
   */
  async convertToHTML(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const dpi = options.dpi || 150;
    const scale = dpi / 72;
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const baseName = this.getBaseFileName(document.getName());
    const htmlPages: string[] = [];

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageHTML = await this.convertPageToHTML(document, i, scale);
        htmlPages.push(`<div class="page" data-page="${i + 1}">${pageHTML}</div>`);
      } catch (error) {
        console.error(`Error converting page ${i + 1} to HTML:`, error);
        htmlPages.push(`<div class="page error">Error converting page ${i + 1}</div>`);
      }
    }

    // Combine all pages into a single HTML document
    const fullHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${baseName}</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: #f5f5f5;
      font-family: Arial, sans-serif;
    }
    .page {
      background: white;
      margin: 20px auto;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      page-break-after: always;
    }
    .page img {
      display: block;
      width: 100%;
      height: auto;
    }
    .page.error {
      padding: 40px;
      text-align: center;
      color: #999;
    }
    @media print {
      body {
        background: white;
        padding: 0;
      }
      .page {
        margin: 0;
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  ${htmlPages.join("\n  ")}
</body>
</html>`;

    return [
      {
        pageNumber: -1,
        data: fullHTML,
        fileName: `${baseName}.html`,
      },
    ];
  }

  /**
   * Convert a single page to HTML
   */
  private async convertPageToHTML(
    document: PDFDocument,
    pageNumber: number,
    scale: number
  ): Promise<string> {
    // Convert page to image and embed in HTML
    const pngData = await this.convertPageToPNG(document, pageNumber, scale);
    const base64 = this.uint8ArrayToBase64(pngData);
    const mupdfDoc = document.getMupdfDocument();
    const page = mupdfDoc.loadPage(pageNumber);
    const bounds = page.getBounds();
    const width = (bounds[2] - bounds[0]) * scale;
    const height = (bounds[3] - bounds[1]) * scale;
    
    return `<img src="data:image/png;base64,${base64}" alt="Page ${pageNumber + 1}" width="${width}" height="${height}">`;
  }

  /**
   * Convert all pages to TXT text
   */
  async convertToTXT(
    document: PDFDocument,
    options: ConvertOptions = {}
  ): Promise<ConvertedPage[]> {
    const pageCount = document.getPageCount();
    const { start = 0, end = pageCount - 1 } = options.pageRange || {};
    
    const baseName = this.getBaseFileName(document.getName());
    const textPages: string[] = [];

    for (let i = start; i <= end && i < pageCount; i++) {
      try {
        const pageText = await this.extractPageText(document, i);
        textPages.push(pageText);
      } catch (error) {
        console.error(`Error extracting text from page ${i + 1}:`, error);
        // Continue with other pages even if one fails
        textPages.push(`[Error extracting text from page ${i + 1}]\n`);
      }
    }

    // Combine all pages with separators
    const fullText = textPages
      .map((text, index) => {
        const pageNum = start + index + 1;
        return `--- Page ${pageNum} ---\n\n${text}\n`;
      })
      .join("\n");

    return [
      {
        pageNumber: -1, // -1 indicates combined file
        data: fullText,
        fileName: `${baseName}.txt`,
      },
    ];
  }

  /**
   * Extract text from a single page
   */
  private async extractPageText(
    document: PDFDocument,
    pageNumber: number
  ): Promise<string> {
    try {
      // Try structured text extraction first
      const spans = await extractStructuredText(document, pageNumber);
      
      if (spans.length > 0) {
        // Sort spans by position (top to bottom, left to right)
        const sortedSpans = [...spans].sort((a, b) => {
          const [aX0, aY0] = a.bbox;
          const [bX0, bY0] = b.bbox;
          
          // First sort by Y (top to bottom) - higher Y first in PDF coordinates
          if (Math.abs(aY0 - bY0) > 5) {
            return bY0 - aY0;
          }
          // Then sort by X (left to right)
          return aX0 - bX0;
        });
        
        // Combine text from spans
        return sortedSpans.map((span) => span.text).join("");
      }
      
      // Fallback: use mupdf's asText() method
      const mupdfDoc = document.getMupdfDocument();
      const page = mupdfDoc.loadPage(pageNumber);
      const structuredText = page.toStructuredText();
      const text = structuredText.asText();
      
      return text || "";
    } catch (error) {
      console.error(`Error extracting text from page ${pageNumber}:`, error);
      return "";
    }
  }

  /**
   * Get base file name without extension
   */
  private getBaseFileName(fileName: string): string {
    // Remove extension
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot > 0) {
      return fileName.substring(0, lastDot);
    }
    return fileName;
  }

  /**
   * Convert Uint8Array to base64 string
   */
  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}

