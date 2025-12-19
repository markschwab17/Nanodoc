/**
 * PDF Renderer Abstraction
 * 
 * Provides a unified interface for rendering PDF pages using mupdf-js
 * with caching and performance optimizations.
 */

export interface RenderOptions {
  scale?: number;
  rotation?: number;
  backgroundColor?: string;
}

export interface RenderedPage {
  pageNumber: number;
  imageData: ImageData | string; // ImageData for canvas, string for data URL
  width: number;
  height: number;
  scale: number;
}

export class PDFRenderer {
  private mupdf: any;
  private renderCache: Map<string, RenderedPage> = new Map();
  private maxCacheSize: number = 50;

  constructor(mupdf: any) {
    this.mupdf = mupdf;
  }

  /**
   * Generate cache key for a page render
   * Note: We don't include rotation in the cache key because PDF rotation
   * is already applied by mupdf when loading the page, so it's part of the
   * page's intrinsic state, not a rendering parameter.
   */
  private getCacheKey(
    pageNumber: number,
    scale: number,
    rotation: number
  ): string {
    // Include rotation in cache key for now, but ideally we shouldn't need to
    // since PDF rotation is already applied by mupdf
    return `${pageNumber}_${scale}_${rotation}`;
  }

  /**
   * Clear render cache
   */
  clearCache(): void {
    this.renderCache.clear();
  }

  /**
   * Render a PDF page to ImageData
   */
  async renderPage(
    document: any,
    pageNumber: number,
    options: RenderOptions = {}
  ): Promise<RenderedPage> {
    const scale = options.scale ?? 1.0;
    const rotation = options.rotation ?? 0;
    const cacheKey = this.getCacheKey(pageNumber, scale, rotation);

    // Check cache
    if (this.renderCache.has(cacheKey)) {
      return this.renderCache.get(cacheKey)!;
    }

    try {
      const page = document.loadPage(pageNumber);

      // Create transformation matrix
      // IMPORTANT: mupdf already applies the PDF's Rotate field when loading the page.
      // The page.getBounds() and page.toPixmap() already account for rotation.
      // So we should NOT apply additional rotation here unless we want to rotate
      // beyond what's specified in the PDF (which we don't).
      // 
      // The rotation parameter is kept for backwards compatibility, but should
      // typically be 0 since PDF rotation is already applied.
      let matrix = this.mupdf.Matrix.scale(scale, scale);
      if (rotation !== 0) {
        // Only apply rotation if explicitly requested (for special cases)
        // In normal rendering, rotation should be 0 because PDF Rotate is already applied
        const rotationMatrix = this.mupdf.Matrix.rotate(rotation);
        matrix = this.mupdf.Matrix.concat(matrix, rotationMatrix);
      }

      // Render to pixmap
      // CRITICAL: Exclude annotations from base rendering (false) since we render them with React
      // This prevents duplicate rendering - native PDF annotations would appear on the canvas
      // and we also render them as interactive React components, causing duplicates
      const pixmap = page.toPixmap(
        matrix,
        this.mupdf.ColorSpace.DeviceRGB,
        false,
        false  // Don't include annotations - we render them with React
      );

      // Get image data
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const pixels = pixmap.getPixels();

      // Convert to ImageData
      // Pixmap.getPixels() returns Uint8ClampedArray
      const imageData = new ImageData(width, height);
      const data = imageData.data;
      const pixelData = pixels;

      // Copy pixel data
      const numPixels = width * height;
      const components = pixmap.getNumberOfComponents();
      
      if (components === 4) {
        // Already RGBA - copy directly
        data.set(pixelData.subarray(0, numPixels * 4));
      } else if (components === 3) {
        // RGB - convert to RGBA
        for (let i = 0; i < numPixels; i++) {
          const srcIdx = i * 3;
          const dstIdx = i * 4;
          data[dstIdx] = pixelData[srcIdx]; // R
          data[dstIdx + 1] = pixelData[srcIdx + 1]; // G
          data[dstIdx + 2] = pixelData[srcIdx + 2]; // B
          data[dstIdx + 3] = 255; // A
        }
      } else {
        throw new Error(`Unsupported color components: ${components}`);
      }

      const rendered: RenderedPage = {
        pageNumber,
        imageData,
        width,
        height,
        scale,
      };

      // Cache the result
      this.cacheRender(cacheKey, rendered);

      return rendered;
    } catch (error) {
      console.error(`Error rendering page ${pageNumber}:`, error);
      throw new Error(`Failed to render page ${pageNumber}: ${error}`);
    }
  }

  /**
   * Render a PDF page to data URL (for thumbnails)
   */
  async renderPageToDataURL(
    document: any,
    pageNumber: number,
    options: RenderOptions = {}
  ): Promise<string> {
    try {
      const scale = options.scale ?? 0.15; // Smaller scale for thumbnails
      const page = document.loadPage(pageNumber);
      const matrix = this.mupdf.Matrix.scale(scale, scale);
      const pixmap = page.toPixmap(
        matrix,
        this.mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );

      // Convert pixmap to PNG directly
      const pngData = pixmap.asPNG();
      
      // Convert to data URL using Blob for better performance
      const blob = new Blob([pngData], { type: 'image/png' });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error(`Error rendering thumbnail for page ${pageNumber}:`, error);
      throw error;
    }
  }

  /**
   * Cache a rendered page
   */
  private cacheRender(key: string, rendered: RenderedPage): void {
    // Simple LRU: remove oldest if cache is full
    if (this.renderCache.size >= this.maxCacheSize) {
      const firstKey = this.renderCache.keys().next().value;
      if (firstKey) {
        this.renderCache.delete(firstKey);
      }
    }
    this.renderCache.set(key, rendered);
  }
}

