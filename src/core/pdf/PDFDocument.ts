/**
 * PDF Document Wrapper
 * 
 * Manages PDF document state, metadata, and provides a unified interface
 * for working with PDF documents using mupdf-js.
 */

export interface PDFPageMetadata {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PDFDocumentMetadata {
  id: string;
  name: string;
  pageCount: number;
  pages: PDFPageMetadata[];
  fileSize: number;
  lastModified: Date;
  hasCoverPage?: boolean; // True if page 0 is a cover/title page that users don't count
}

export class PDFDocument {
  private mupdfDoc: any = null;
  private metadata: PDFDocumentMetadata;
  private isLoaded: boolean = false;
  private originalFilePath: string | null = null;
  private metadataListeners: Set<() => void> = new Set();
  private pdfData: Uint8Array | null = null;

  constructor(id: string, name: string, fileSize: number) {
    this.metadata = {
      id,
      name,
      pageCount: 0,
      pages: [],
      fileSize,
      lastModified: new Date(),
    };
  }

  /**
   * Subscribe to metadata changes (rotation, page dimensions, page count).
   * Returns an unsubscribe function.
   */
  onMetadataChange(callback: () => void): () => void {
    this.metadataListeners.add(callback);
    return () => {
      this.metadataListeners.delete(callback);
    };
  }

  /**
   * Load PDF document from binary data
   */
  /**
   * Get the raw PDF data for off-thread rendering
   */
  getPdfData(): Uint8Array | null {
    return this.pdfData;
  }

  async loadFromData(data: Uint8Array, mupdf: any): Promise<void> {
    try {
      this.pdfData = data;
      this.mupdfDoc = mupdf.Document.openDocument(data, "application/pdf");
      
      this.metadata.pageCount = this.mupdfDoc.countPages();
      this.metadata.pages = [];

      // Load page metadata
      for (let i = 0; i < this.metadata.pageCount; i++) {
        const page = this.mupdfDoc.loadPage(i);
        // IMPORTANT: mupdf's getBounds() already returns rotated dimensions
        // (it applies the PDF's Rotate field automatically)
        const bounds = page.getBounds(); // Returns [x0, y0, x1, y1] with rotation applied
        
        // Read actual rotation from page dictionary
        let rotation = 0;
        try {
          const pageObj = page.getObject();
          if (pageObj) {
            const rotateValue = pageObj.get("Rotate");
            if (rotateValue !== null && rotateValue !== undefined) {
              if (typeof rotateValue === 'number') {
                rotation = rotateValue;
              } else if (rotateValue.valueOf && typeof rotateValue.valueOf === 'function') {
                rotation = rotateValue.valueOf();
              } else if (typeof rotateValue === 'object' && 'value' in rotateValue) {
                rotation = rotateValue.value;
              }
            }
          }
        } catch (e) {
          // Rotation might not be available, default to 0
          rotation = 0;
        }
        
        // Normalize rotation to 0-360 range
        rotation = ((rotation % 360) + 360) % 360;
        
      this.metadata.pages.push({
        pageNumber: i,
        width: bounds[2] - bounds[0], // x1 - x0 (already rotated by mupdf)
        height: bounds[3] - bounds[1], // y1 - y0 (already rotated by mupdf)
        rotation: rotation,
      });
    }

    this.isLoaded = true;
    
    // Detect cover page: check if page 0 has significantly less text than page 1
    // This is done asynchronously after loading to avoid blocking
    this.detectCoverPage().catch(err => {
      console.warn("Error detecting cover page:", err);
    });
    } catch (error) {
      console.error("Error loading PDF document:", error);
      throw new Error(`Failed to load PDF: ${error}`);
    }
  }

  /**
   * Get the underlying mupdf document
   */
  getMupdfDocument(): any {
    if (!this.isLoaded) {
      throw new Error("PDF document not loaded");
    }
    return this.mupdfDoc;
  }

  /**
   * Get document metadata
   */
  getMetadata(): PDFDocumentMetadata {
    return { ...this.metadata };
  }

  /**
   * Get page count
   */
  getPageCount(): number {
    // If document is loaded, get fresh count from mupdf
    if (this.isLoaded && this.mupdfDoc) {
      try {
        const actualCount = this.mupdfDoc.countPages();
        if (actualCount !== this.metadata.pageCount) {
          // Update metadata if it's out of sync
          this.metadata.pageCount = actualCount;
          // Update pages array to match
          this.metadata.pages = this.metadata.pages.slice(0, actualCount);
        }
        return actualCount;
      } catch (error) {
        console.error("Error getting page count:", error);
      }
    }
    return this.metadata.pageCount;
  }

  /**
   * Refresh page metadata after page operations
   */
  refreshPageMetadata(): void {
    if (!this.isLoaded || !this.mupdfDoc) return;
    
    try {
      const actualCount = this.mupdfDoc.countPages();
      this.metadata.pageCount = actualCount;
      
      // Refresh page metadata
      this.metadata.pages = [];
      for (let i = 0; i < actualCount; i++) {
        try {
          const page = this.mupdfDoc.loadPage(i);
          // IMPORTANT: mupdf's getBounds() already returns rotated dimensions
          // (it applies the PDF's Rotate field automatically)
          // Do NOT manually swap dimensions - that would double-swap!
          const bounds = page.getBounds();
          
          // Get rotation from page dictionary
          let rotation = 0;
          try {
            const pageObj = page.getObject();
            if (pageObj) {
              const rotateValue = pageObj.get("Rotate");
              if (rotateValue !== null && rotateValue !== undefined) {
                if (typeof rotateValue === 'number') {
                  rotation = rotateValue;
                } else if (rotateValue.valueOf && typeof rotateValue.valueOf === 'function') {
                  rotation = rotateValue.valueOf();
                } else if (typeof rotateValue === 'object' && 'value' in rotateValue) {
                  rotation = rotateValue.value;
                }
              }
            }
          } catch (e) {
            // Rotation might not be available
            rotation = 0;
          }
          
          // Normalize rotation to 0-360 range
          rotation = ((rotation % 360) + 360) % 360;
          
          // Use bounds directly - mupdf already applies rotation to getBounds()
          const displayWidth = bounds[2] - bounds[0];
          const displayHeight = bounds[3] - bounds[1];
          
          this.metadata.pages.push({
            pageNumber: i,
            width: displayWidth,
            height: displayHeight,
            rotation: rotation,
          });
          
        } catch (error) {
          console.error(`Error loading metadata for page ${i}:`, error);
        }
      }
    } catch (error) {
      console.error("Error refreshing page metadata:", error);
    }

    // Notify subscribers that metadata has changed
    for (const listener of this.metadataListeners) {
      try {
        listener();
      } catch (e) {
        console.error("Error in metadata change listener:", e);
      }
    }
  }

  /**
   * Get page metadata
   */
  getPageMetadata(pageNumber: number): PDFPageMetadata | null {
    return this.metadata.pages[pageNumber] || null;
  }

  /**
   * Check if document is loaded
   */
  isDocumentLoaded(): boolean {
    return this.isLoaded;
  }

  /**
   * Get document ID
   */
  getId(): string {
    return this.metadata.id;
  }

  /**
   * Get document name
   */
  getName(): string {
    return this.metadata.name;
  }

  /**
   * Detect if the PDF has a cover page (page 0 that users don't count)
   * by comparing text content of page 0 vs page 1
   */
  private async detectCoverPage(): Promise<void> {
    if (this.metadata.pageCount < 2) {
      // Need at least 2 pages to compare
      this.metadata.hasCoverPage = false;
      return;
    }

    try {
      // Extract text from page 0 and page 1
      const page0 = this.mupdfDoc.loadPage(0);
      const page1 = this.mupdfDoc.loadPage(1);
      
      const text0 = page0.toStructuredText().asText() || '';
      const text1 = page1.toStructuredText().asText() || '';
      
      // If page 0 has less than 20% of page 1's text, it's likely a cover page
      if (text0.length > 0 && text1.length > 0) {
        const ratio = text0.length / text1.length;
        this.metadata.hasCoverPage = ratio < 0.2;
        
        if (this.metadata.hasCoverPage) {
          console.log(`Detected cover page: page 0 has ${text0.length} chars (${(ratio * 100).toFixed(1)}% of page 1's ${text1.length} chars)`);
        }
      } else if (text0.length === 0 && text1.length > 0) {
        // Page 0 has no text but page 1 does - likely a cover
        this.metadata.hasCoverPage = true;
        console.log(`Detected cover page: page 0 has no text, page 1 has ${text1.length} chars`);
      } else {
        this.metadata.hasCoverPage = false;
      }
    } catch (error) {
      console.warn("Error detecting cover page:", error);
      this.metadata.hasCoverPage = false;
    }
  }

  /**
   * Check if PDF has a cover page
   */
  hasCoverPage(): boolean {
    return this.metadata.hasCoverPage ?? false;
  }

  /**
   * Convert mupdf page index to user-visible page number
   * Accounts for cover page if present
   */
  getDisplayPageNumber(mupdfPageIndex: number): number {
    if (this.hasCoverPage()) {
      // With cover page: mupdf index 0 = cover (not counted), index 1 = user's page 1
      // So mupdf index 5 = user's page 5 (no +1 needed)
      return mupdfPageIndex;
    } else {
      // Without cover page: standard 0-based to 1-based conversion
      return mupdfPageIndex + 1;
    }
  }

  /**
   * Convert user-visible page number to mupdf page index
   * Accounts for cover page if present
   */
  getMupdfPageIndex(displayPageNumber: number): number {
    if (this.hasCoverPage()) {
      // With cover page: user's page 1 = mupdf index 1, user's page 5 = mupdf index 5
      return displayPageNumber;
    } else {
      // Without cover page: standard 1-based to 0-based conversion
      return displayPageNumber - 1;
    }
  }

  /**
   * Set document name
   */
  setName(name: string): void {
    this.metadata.name = name;
  }

  /**
   * Set original file path (where the PDF was loaded from)
   */
  setOriginalFilePath(path: string | null): void {
    this.originalFilePath = path;
  }

  /**
   * Get original file path
   */
  getOriginalFilePath(): string | null {
    return this.originalFilePath;
  }
}

