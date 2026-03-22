/**
 * Stamp Embedder using pdf-lib
 *
 * Embeds image, text, and signature stamps into PDFs as page content
 * so they render correctly in native PDF viewers.
 * When aiMetadata is provided, it is written to the PDF Keywords.
 */

// Dynamic import of pdf-lib to handle cases where it might not be installed
let pdfLibModule: any = null;

async function getPdfLib() {
  if (!pdfLibModule) {
    try {
      pdfLibModule = await import('pdf-lib');
    } catch (error) {
      console.error('[ImageStampEmbedder] Failed to import pdf-lib:', error);
      throw new Error('pdf-lib is not available. Please run: npm install pdf-lib');
    }
  }
  return pdfLibModule;
}
import type { Annotation } from './types';
import type { PDFAIMetadataPayload } from './PDFAIMetadata';
import { encodeAIMetadataForKeywords, AI_EMBEDDED_FILE_NAME } from './PDFAIMetadata';

/** PDF position for a stamp: x is left edge, y is bottom edge (PDF coords: origin bottom-left). */
function stampPosition(_page: any, stamp: Annotation): { x: number; y: number; width: number; height: number } {
  const w = stamp.width || 100;
  const h = stamp.height || 100;
  const x = stamp.x;
  // stamp.y is the PDF y of the bottom edge (matches overlay: pdfTopY = annot.y + height)
  const y = stamp.y;
  return { x, y, width: w, height: h };
}

export class ImageStampEmbedder {
  /**
   * Embed all stamp types (image, text, signature) and image annotations into a PDF buffer using pdf-lib.
   * Image annotations (type "image") are embedded as actual PDF image XObjects drawn as page content,
   * so they render correctly in all PDF viewers (Adobe Acrobat, Preview, Chrome, etc.).
   */
  async embedStamps(
    pdfBuffer: Uint8Array,
    stamps: Annotation[],
    aiMetadata?: PDFAIMetadataPayload
  ): Promise<Uint8Array> {
    try {
      const { PDFDocument, StandardFonts, rgb, degrees } = await getPdfLib();
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pages = pdfDoc.getPages();

      for (const stamp of stamps) {
        try {
          if (stamp.type === 'image' && stamp.imageData) {
            // Image annotation (type "image") - embed as page content
            await this.embedSingleImageAnnotation(pdfDoc, pages, stamp, degrees);
          } else if (stamp.stampData?.type === 'image') {
            await this.embedSingleImageStamp(pdfDoc, pages, stamp);
          } else if (stamp.stampData?.type === 'text') {
            await this.embedSingleTextStamp(pdfDoc, pages, stamp, StandardFonts, rgb);
          } else if (stamp.stampData?.type === 'signature') {
            await this.embedSingleSignatureStamp(pdfDoc, pages, stamp, rgb);
          }
        } catch (stampError) {
          console.error(`[ImageStampEmbedder] Failed to embed stamp/image ${stamp.id}:`, stampError);
        }
      }

      if (aiMetadata) {
        try {
          if (typeof pdfDoc.setKeywords === 'function') {
            pdfDoc.setKeywords(encodeAIMetadataForKeywords(aiMetadata));
          }
          const json = JSON.stringify({ ...aiMetadata, version: aiMetadata.version ?? 1 });
          await pdfDoc.attach(new TextEncoder().encode(json), AI_EMBEDDED_FILE_NAME, { mimeType: 'application/json' });
        } catch (e) {
          console.warn('[ImageStampEmbedder] Failed to set AI metadata:', e);
        }
      }

      return await pdfDoc.save({ useObjectStreams: false });
    } catch (error) {
      console.error('[ImageStampEmbedder] Failed to embed stamps:', error);
      return pdfBuffer;
    }
  }

  /** @deprecated Use embedStamps for all stamp types */
  async embedImageStamps(
    pdfBuffer: Uint8Array,
    imageStamps: Annotation[],
    aiMetadata?: PDFAIMetadataPayload
  ): Promise<Uint8Array> {
    return this.embedStamps(pdfBuffer, imageStamps, aiMetadata);
  }

  private async embedSingleImageStamp(pdfDoc: any, pages: any[], stamp: Annotation): Promise<void> {
    if (!stamp.stampData?.imageData || stamp.stampData.type !== 'image') return;

    const pageIndex = stamp.pageNumber;
    if (pageIndex >= pages.length) return;
    const page = pages[pageIndex];
    const { x, y, width, height } = stampPosition(page, stamp);

    const base64Data = stamp.stampData.imageData.split(',')[1] || stamp.stampData.imageData;
    const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    let pdfImage;
    if (stamp.stampData.imageData.startsWith('data:image/png')) {
      pdfImage = await pdfDoc.embedPng(imageBytes);
    } else if (stamp.stampData.imageData.startsWith('data:image/jpeg') || stamp.stampData.imageData.startsWith('data:image/jpg')) {
      pdfImage = await pdfDoc.embedJpg(imageBytes);
    } else {
      return;
    }

    page.drawImage(pdfImage, { x, y, width, height });
  }

  /**
   * Embed an image annotation (type "image") as actual page content.
   * Uses pdf-lib to embed the image as an XObject and draw it on the page,
   * so it renders correctly in all PDF viewers.
   */
  private async embedSingleImageAnnotation(
    pdfDoc: any,
    pages: any[],
    annotation: Annotation,
    degrees: (deg: number) => any
  ): Promise<void> {
    if (!annotation.imageData || annotation.type !== 'image') return;

    const pageIndex = annotation.pageNumber;
    if (pageIndex >= pages.length) return;
    const page = pages[pageIndex];

    const width = annotation.width || annotation.imageWidth || 200;
    const height = annotation.height || annotation.imageHeight || 200;
    // annotation.x = left edge, annotation.y = bottom edge (PDF coordinates)
    const x = annotation.x;
    const y = annotation.y;

    const base64Data = annotation.imageData.split(',')[1] || annotation.imageData;
    const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    let pdfImage;
    if (annotation.imageData.startsWith('data:image/png')) {
      pdfImage = await pdfDoc.embedPng(imageBytes);
    } else if (annotation.imageData.startsWith('data:image/jpeg') || annotation.imageData.startsWith('data:image/jpg')) {
      pdfImage = await pdfDoc.embedJpg(imageBytes);
    } else {
      // Try PNG as fallback for unknown formats
      try {
        pdfImage = await pdfDoc.embedPng(imageBytes);
      } catch {
        console.warn(`[ImageStampEmbedder] Unsupported image format for annotation ${annotation.id}`);
        return;
      }
    }

    const drawOpts: any = { x, y, width, height };
    if (annotation.rotation) {
      drawOpts.rotate = degrees(annotation.rotation);
    }

    page.drawImage(pdfImage, drawOpts);
  }

  private async embedSingleTextStamp(
    pdfDoc: any,
    pages: any[],
    stamp: Annotation,
    StandardFonts: any,
    rgb: (r: number, g: number, b: number) => any
  ): Promise<void> {
    const data = stamp.stampData;
    if (data?.type !== 'text' || !data.text) return;

    const pageIndex = stamp.pageNumber;
    if (pageIndex >= pages.length) return;
    const page = pages[pageIndex];
    const { x, y, width, height } = stampPosition(page, stamp);

    const fontName = (data.font || 'Helvetica').toLowerCase().includes('bold') ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
    const font = await pdfDoc.embedFont(fontName);

    const hex = (data.textColor || '#000000').replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;

    // Match StampAnnotation.tsx scale: fontSize = min(width, height) * 0.4
    const minDim = Math.min(width, height);
    const fontSize = Math.max(8, Math.min(minDim * 0.4, 72));
    const lineHeight = fontSize * 1.2;
    const lines = data.text.split(/\r?\n/);
    let drawY = y + height - fontSize;

    for (const line of lines) {
      if (!line.trim()) {
        drawY -= lineHeight;
        continue;
      }
      page.drawText(line, {
        font,
        size: fontSize,
        color: rgb(r, g, b),
        x,
        y: drawY,
      });
      drawY -= lineHeight;
    }
  }

  private async embedSingleSignatureStamp(
    _pdfDoc: any,
    pages: any[],
    stamp: Annotation,
    rgb: (r: number, g: number, b: number) => any
  ): Promise<void> {
    const path = stamp.stampData?.signaturePath;
    if (stamp.stampData?.type !== 'signature' || !path?.length) return;

    const pageIndex = stamp.pageNumber;
    if (pageIndex >= pages.length) return;
    const page = pages[pageIndex];
    const { x, y, width, height } = stampPosition(page, stamp);

    // Signature path is in design space 0–100 (x) and 0–60 (y). Scale to stamp rect and flip Y for PDF.
    const scaleX = width / 100;
    const scaleY = height / 60;
    const black = rgb(0, 0, 0);

    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const curr = path[i];
      const x1 = x + prev.x * scaleX;
      const y1 = y + height - prev.y * scaleY;
      const x2 = x + curr.x * scaleX;
      const y2 = y + height - curr.y * scaleY;
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: Math.max(1, (width + height) / 200),
        color: black,
      });
    }
  }

  static isImageStamp(annotation: Annotation): boolean {
    return annotation.type === 'stamp' &&
           annotation.stampData?.type === 'image' &&
           !!annotation.stampData.imageData;
  }

  static isStampToEmbed(annotation: Annotation): boolean {
    if (annotation.type !== 'stamp' || !annotation.stampData) return false;
    const t = annotation.stampData.type;
    if (t === 'image') return !!annotation.stampData.imageData;
    if (t === 'text') return !!annotation.stampData.text;
    if (t === 'signature') return !!annotation.stampData.signaturePath?.length;
    return false;
  }
}
