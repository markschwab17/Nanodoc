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
}

export class PDFDocument {
  private mupdfDoc: any = null;
  private metadata: PDFDocumentMetadata;
  private isLoaded: boolean = false;
  private originalFilePath: string | null = null;

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
   * Load PDF document from binary data
   */
  async loadFromData(data: Uint8Array, mupdf: any): Promise<void> {
    try {
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

