/**
 * Image Stamp Embedder using pdf-lib
 *
 * Handles embedding image stamps into PDFs using pdf-lib library.
 * This provides proper image rendering in native PDF viewers.
 */

// Dynamic import of pdf-lib to handle cases where it might not be installed
let pdfLibModule: any = null;

async function getPdfLib() {
  if (!pdfLibModule) {
    try {
      pdfLibModule = await import('pdf-lib');
      console.log('[ImageStampEmbedder] pdf-lib imported successfully');
    } catch (error) {
      console.error('[ImageStampEmbedder] Failed to import pdf-lib:', error);
      throw new Error('pdf-lib is not available. Please run: npm install pdf-lib');
    }
  }
  return pdfLibModule;
}
import type { Annotation } from './types';

export class ImageStampEmbedder {
  /**
   * Embed image stamps into a PDF buffer using pdf-lib
   * @param pdfBuffer - The PDF buffer from MuPDF
   * @param imageStamps - Array of image stamp annotations
   * @returns Promise<Uint8Array> - PDF buffer with embedded images
   */
  async embedImageStamps(
    pdfBuffer: Uint8Array,
    imageStamps: Annotation[]
  ): Promise<Uint8Array> {
    console.log(`[ImageStampEmbedder] Processing ${imageStamps.length} image stamps`);
    console.log(`[ImageStampEmbedder] PDF buffer size: ${pdfBuffer.length} bytes`);
    console.log(`[ImageStampEmbedder] Image stamps details:`, imageStamps.map(s => ({
      id: s.id,
      type: s.type,
      stampType: s.stampData?.type,
      hasImageData: !!s.stampData?.imageData,
      imageDataLength: s.stampData?.imageData?.length || 0
    })));

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

      // Save the modified PDF
      const modifiedPdfBytes = await pdfDoc.save();
      console.log(`[ImageStampEmbedder] Successfully embedded ${imageStamps.length} image stamps`);

      return modifiedPdfBytes;

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
      console.log(`[ImageStampEmbedder] Processing stamp ${stamp.id} on page ${pageIndex}`);

      // Extract base64 image data
      const base64Data = stamp.stampData.imageData.split(',')[1] || stamp.stampData.imageData;
      console.log(`[ImageStampEmbedder] Base64 data length: ${base64Data.length}`);

      // Convert base64 to Uint8Array
      const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      console.log(`[ImageStampEmbedder] Converted to ${imageBytes.length} bytes`);

      // Determine image type and embed
      let pdfImage;
      if (stamp.stampData.imageData.startsWith('data:image/png')) {
        console.log(`[ImageStampEmbedder] Embedding PNG image`);
        pdfImage = await pdfDoc.embedPng(imageBytes);
      } else if (stamp.stampData.imageData.startsWith('data:image/jpeg') || stamp.stampData.imageData.startsWith('data:image/jpg')) {
        console.log(`[ImageStampEmbedder] Embedding JPEG image`);
        pdfImage = await pdfDoc.embedJpg(imageBytes);
      } else {
        console.warn(`[ImageStampEmbedder] Unsupported image format for stamp ${stamp.id}`);
        return;
      }

      // Calculate position (convert from PDF coordinates to pdf-lib coordinates)
      const pageHeight = page.getHeight();
      const x = stamp.x;
      // Use stamp.y directly as the bottom-left corner Y coordinate
      const y = stamp.y;

      console.log(`[ImageStampEmbedder] Original coordinates: x=${stamp.x}, y=${stamp.y}, height=${stamp.height}`);
      console.log(`[ImageStampEmbedder] Converted coordinates: x=${x}, y=${y}, pageHeight=${pageHeight}`);
      console.log(`[ImageStampEmbedder] Drawing image at (${x}, ${y}) with size ${stamp.width || 100}x${stamp.height || 100}`);

      // Draw the image on the page
      page.drawImage(pdfImage, {
        x,
        y,
        width: stamp.width || 100,
        height: stamp.height || 100,
      });

      console.log(`[ImageStampEmbedder] Successfully embedded image stamp ${stamp.id}`);

    } catch (error) {
      console.error(`[ImageStampEmbedder] Error embedding stamp ${stamp.id}:`, error);
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
