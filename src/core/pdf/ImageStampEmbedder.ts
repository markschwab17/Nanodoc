/**
 * Image Stamp Embedder using pdf-lib
 *
 * Handles embedding image stamps into PDFs using pdf-lib library.
 * This provides proper image rendering in native PDF viewers.
 * When aiMetadata is provided, it is written to the PDF Keywords so that
 * AI-extracted data and conversation persist after the pdf-lib rewrite.
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

export class ImageStampEmbedder {
  /**
   * Embed image stamps into a PDF buffer using pdf-lib
   * @param pdfBuffer - The PDF buffer from MuPDF
   * @param imageStamps - Array of image stamp annotations
   * @param aiMetadata - Optional AI metadata (extracted specs, conversation) to preserve in the saved PDF
   * @returns Promise<Uint8Array> - PDF buffer with embedded images
   */
  async embedImageStamps(
    pdfBuffer: Uint8Array,
    imageStamps: Annotation[],
    aiMetadata?: PDFAIMetadataPayload
  ): Promise<Uint8Array> {
    try {
      // Get pdf-lib dynamically
      const { PDFDocument } = await getPdfLib();

      // Load the PDF with pdf-lib
      const pdfDoc = await PDFDocument.load(pdfBuffer);

      // Get all pages
      const pages = pdfDoc.getPages();

      // Process each image stamp
      for (const stamp of imageStamps) {
        try {
          await this.embedSingleImageStamp(pdfDoc, pages, stamp);
        } catch (stampError) {
          console.error(`[ImageStampEmbedder] Failed to embed stamp ${stamp.id}:`, stampError);
          // Continue with other stamps rather than failing completely
        }
      }

      // Preserve AI metadata in Keywords and as an embedded file so it travels with the PDF.
      if (aiMetadata) {
        try {
          if (typeof pdfDoc.setKeywords === 'function') {
            const keywordsValue = encodeAIMetadataForKeywords(aiMetadata);
            pdfDoc.setKeywords(keywordsValue);
          }
          const json = JSON.stringify({
            ...aiMetadata,
            version: aiMetadata.version ?? 1,
          });
          const jsonBytes = new TextEncoder().encode(json);
          await pdfDoc.attach(jsonBytes, AI_EMBEDDED_FILE_NAME, { mimeType: 'application/json' });
        } catch (e) {
          console.warn('[ImageStampEmbedder] Failed to set AI metadata (Keywords/embed):', e);
        }
      }

      // Save the modified PDF. useObjectStreams: false for mupdf-wasm compatibility
      // (object streams can cause "corrupt object stream" / zlib errors on reopen)
      return await pdfDoc.save({ useObjectStreams: false });

    } catch (error) {
      console.error('[ImageStampEmbedder] Failed to embed image stamps:', error);
      // Return original buffer if embedding fails
      return pdfBuffer;
    }
  }

  /**
   * Embed a single image stamp
   */
  private async embedSingleImageStamp(
    pdfDoc: any,
    pages: any[],
    stamp: Annotation
  ): Promise<void> {
    if (!stamp.stampData?.imageData || stamp.stampData.type !== 'image') {
      return;
    }

    // Get the target page
    const pageIndex = stamp.pageNumber;
    if (pageIndex >= pages.length) {
      console.warn(`[ImageStampEmbedder] Page ${pageIndex} not found for stamp ${stamp.id}`);
      return;
    }

    const page = pages[pageIndex];

    try {
      const base64Data = stamp.stampData.imageData.split(',')[1] || stamp.stampData.imageData;
      const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

      let pdfImage;
      if (stamp.stampData.imageData.startsWith('data:image/png')) {
        pdfImage = await pdfDoc.embedPng(imageBytes);
      } else if (stamp.stampData.imageData.startsWith('data:image/jpeg') || stamp.stampData.imageData.startsWith('data:image/jpg')) {
        pdfImage = await pdfDoc.embedJpg(imageBytes);
      } else {
        console.warn('[ImageStampEmbedder] Unsupported image format for stamp', stamp.id);
        return;
      }

      const x = stamp.x;
      const y = stamp.y;
      page.drawImage(pdfImage, {
        x,
        y,
        width: stamp.width || 100,
        height: stamp.height || 100,
      });
    } catch (error) {
      console.error('[ImageStampEmbedder] Failed to embed stamp', stamp.id, error);
      throw error;
    }
  }

  /**
   * Check if an annotation is an image stamp that needs embedding
   */
  static isImageStamp(annotation: Annotation): boolean {
    return annotation.type === 'stamp' &&
           annotation.stampData?.type === 'image' &&
           !!annotation.stampData.imageData;
  }
}
