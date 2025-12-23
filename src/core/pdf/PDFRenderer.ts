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
  quality?: 'low' | 'normal' | 'high' | 'ultra';
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
  private cacheAccessOrder: string[] = []; // Track access order for LRU
  private maxCacheSize: number = 50;
  private highZoomMode: boolean = false; // Track if we're in high zoom mode

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
    rotation: number,
    quality?: string
  ): string {
    // Include rotation and quality in cache key
    return `${pageNumber}_${scale}_${rotation}_${quality || 'normal'}`;
  }

  /**
   * Get quality multiplier for enhanced text rendering
   *
   * Performance notes:
   * - Low: Fastest, basic quality
   * - Normal: Good balance of quality and performance
   * - High: ~4x rendering time, much better text clarity
   * - Ultra: ~9x rendering time, maximum text quality for critical documents
   */
  private getQualityMultiplier(quality: 'low' | 'normal' | 'high' | 'ultra'): number {
    switch (quality) {
      case 'low': return 0.5;      // Half resolution for fastest rendering
      case 'normal': return 1.0;   // Base quality (device pixel ratio only)
      case 'high': return 1.5;     // 1.5x resolution for good text clarity without memory explosion
      case 'ultra': return 2.0;    // Double resolution for ultra-crisp text (only when appropriate)
      default: return 1.0;
    }
  }

  /**
   * Get rendering hints for improved text quality
   * Higher quality settings may use additional processing for better text rendering
   */
  private getRenderingHints(quality: 'low' | 'normal' | 'high' | 'ultra'): any {
    // Rendering hints for different quality levels
    // Note: mupdf-js may not expose all these options, but we set them up for future compatibility
    const hints: any = {};

    switch (quality) {
      case 'low':
        // Basic rendering, minimal processing
        hints.antiAlias = false;
        hints.textAntiAlias = false;
        break;

      case 'normal':
        // Standard rendering with basic anti-aliasing
        hints.antiAlias = true;
        hints.textAntiAlias = true;
        break;

      case 'high':
        // Enhanced rendering for better text clarity
        hints.antiAlias = true;
        hints.textAntiAlias = true;
        hints.useHinting = true;
        hints.lcdFilter = true;
        break;

      case 'ultra':
        // Maximum quality rendering
        hints.antiAlias = true;
        hints.textAntiAlias = true;
        hints.useHinting = true;
        hints.lcdFilter = true;
        hints.subpixelRendering = true;
        break;
    }

    return hints;
  }

  /**
   * Clear render cache
   */
  clearCache(): void {
    this.renderCache.clear();
    this.cacheAccessOrder = [];
  }

  /**
   * Set high zoom mode to optimize cache for high zoom scenarios
   */
  setHighZoomMode(enabled: boolean): void {
    if (this.highZoomMode !== enabled) {
      this.highZoomMode = enabled;
      // Reduce cache size in high zoom mode to prevent memory pressure (less aggressive)
      this.maxCacheSize = enabled ? 35 : 50;

      // If enabling high zoom mode, evict some cache entries
      if (enabled && this.renderCache.size > this.maxCacheSize) {
        while (this.renderCache.size > this.maxCacheSize) {
          this.evictLeastRecentlyUsed();
        }
      }
    }
  }

  /**
   * Render a PDF page to ImageData
   */
  async renderPage(
    document: any,
    pageNumber: number,
    options: RenderOptions = {}
  ): Promise<RenderedPage> {
    const baseScale = options.scale ?? 1.0;
    const rotation = options.rotation ?? 0;
    const quality = options.quality ?? 'normal';

    // Apply quality multiplier to base scale
    const qualityMultiplier = this.getQualityMultiplier(quality);
    const scale = baseScale * qualityMultiplier;

    const cacheKey = this.getCacheKey(pageNumber, scale, rotation, quality);

    // Check cache with LRU update
    if (this.renderCache.has(cacheKey)) {
      this.updateCacheAccess(cacheKey);
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

      // Render to pixmap with quality settings
      // CRITICAL: Exclude annotations from base rendering (false) since we render them with React
      // This prevents duplicate rendering - native PDF annotations would appear on the canvas
      // and we also render them as interactive React components, causing duplicates

      // Apply rendering hints based on quality setting
      // Note: mupdf-js may not expose all rendering hints, but we prepare them for future compatibility
      this.getRenderingHints(quality);

      const pixmap = page.toPixmap(
        matrix,
        this.mupdf.ColorSpace.DeviceRGB,
        false,  // alpha
        false   // Don't include annotations - we render them with React
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
   * Update cache access order for LRU
   */
  private updateCacheAccess(key: string): void {
    // Remove from current position and add to end (most recently used)
    const index = this.cacheAccessOrder.indexOf(key);
    if (index > -1) {
      this.cacheAccessOrder.splice(index, 1);
    }
    this.cacheAccessOrder.push(key);
  }

  /**
   * Cache a rendered page with intelligent cleanup
   */
  private cacheRender(key: string, rendered: RenderedPage): void {
    // Clean up lower quality versions of the same page if we have higher quality
    this.cleanupLowerQualityVersions(key, rendered);

    // LRU eviction with quality-based prioritization
    while (this.renderCache.size >= this.maxCacheSize) {
      this.evictLeastRecentlyUsed();
    }

    this.renderCache.set(key, rendered);
    this.updateCacheAccess(key);
  }

  /**
   * Clean up lower quality versions when a higher quality version is cached
   */
  private cleanupLowerQualityVersions(newKey: string, _rendered: RenderedPage): void {
    const qualityOrder = { 'low': 1, 'normal': 2, 'high': 3, 'ultra': 4 };
    const [pageNum, scale, rotation, quality] = this.parseCacheKey(newKey);

        // Remove lower quality versions of the same page/scale/rotation
    for (const [existingKey, _existingRendered] of this.renderCache.entries()) {
      if (existingKey !== newKey) {
        const [existingPageNum, existingScale, existingRotation, existingQuality] = this.parseCacheKey(existingKey);

        // Same page, scale, and rotation, but lower quality
        if (existingPageNum === pageNum &&
            Math.abs(existingScale - scale) < 0.01 &&
            existingRotation === rotation &&
            qualityOrder[existingQuality] < qualityOrder[quality]) {
          this.renderCache.delete(existingKey);
          const accessIndex = this.cacheAccessOrder.indexOf(existingKey);
          if (accessIndex > -1) {
            this.cacheAccessOrder.splice(accessIndex, 1);
          }
        }
      }
    }
  }

  /**
   * Evict least recently used item with quality-based prioritization
   * Prefers to keep higher quality versions for better zoom performance
   */
  private evictLeastRecentlyUsed(): void {
    // First try to find a low quality item to evict
    let lruLowQualityKey = null;
    for (const key of this.cacheAccessOrder) {
      const [, , , quality] = this.parseCacheKey(key);
      if (quality === 'low') {
        lruLowQualityKey = key;
        break; // Found first low quality item, evict it
      }
    }

    if (lruLowQualityKey) {
      this.renderCache.delete(lruLowQualityKey);
      const index = this.cacheAccessOrder.indexOf(lruLowQualityKey);
      if (index > -1) this.cacheAccessOrder.splice(index, 1);
      return;
    }

    // If no low quality items, find the LRU item
    const lruKey = this.cacheAccessOrder[0];
    if (lruKey) {
      this.renderCache.delete(lruKey);
      this.cacheAccessOrder.shift();
    }
  }

  /**
   * Parse cache key back into components
   */
  private parseCacheKey(key: string): [number, number, number, 'low' | 'normal' | 'high' | 'ultra'] {
    const parts = key.split('_');
    return [
      parseInt(parts[0], 10),
      parseFloat(parts[1]),
      parseInt(parts[2], 10),
      (parts[3] as 'low' | 'normal' | 'high' | 'ultra') || 'normal'
    ];
  }

  /**
   * Pre-cache higher quality versions of pages for smoother zooming/scrolling
   * This runs in the background to prepare higher quality renders
   */
  async preCacheHigherQuality(
    document: any,
    pageNumbers: number[],
    currentQuality: 'low' | 'normal' | 'high' | 'ultra',
    scale: number = 1.0
  ): Promise<void> {
    if (currentQuality === 'ultra') return; // Already at max quality

    const qualitiesToCache: ('low' | 'normal' | 'high' | 'ultra')[] = [];

    // Pre-cache next quality level (less aggressive in high zoom mode)
    if (this.highZoomMode) {
      // In high zoom mode, only pre-cache one level ahead to prevent memory pressure
      if (currentQuality === 'low') {
        qualitiesToCache.push('normal');
      } else if (currentQuality === 'normal') {
        qualitiesToCache.push('high');
      }
      // Don't pre-cache ultra in high zoom mode
    } else {
      // Normal mode: pre-cache more aggressively
      if (currentQuality === 'low') {
        qualitiesToCache.push('normal', 'high');
      } else if (currentQuality === 'normal') {
        qualitiesToCache.push('high', 'ultra');
      } else if (currentQuality === 'high') {
        qualitiesToCache.push('ultra');
      }
    }

    // Pre-cache higher quality versions in background
    for (const pageNumber of pageNumbers) {
      for (const quality of qualitiesToCache) {
        try {
          const cacheKey = this.getCacheKey(pageNumber, scale, 0, quality);
          if (!this.renderCache.has(cacheKey)) {
            // Render in background without awaiting
            this.renderPage(document, pageNumber, {
              scale,
              rotation: 0,
              quality,
            }).catch(err => {
              // Silently ignore pre-cache failures
              console.debug(`Pre-cache failed for page ${pageNumber} at ${quality} quality:`, err);
            });
          }
        } catch (error) {
          // Continue with other pages if one fails
          console.debug(`Pre-cache setup failed for page ${pageNumber}:`, error);
        }
      }
    }
  }
}

