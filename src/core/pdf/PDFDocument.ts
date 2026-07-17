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
  /** Stored per-page label from the /NanodocLabel page-dict key. Undefined when unstored. */
  label?: string;
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

/** Thrown by loadFromData when the PDF requires a password (none given or wrong). */
export class PasswordRequiredError extends Error {
  readonly code = "PASSWORD_REQUIRED";
  constructor(public readonly wrongPassword: boolean) {
    super(wrongPassword ? "Wrong password" : "Password required");
    this.name = "PasswordRequiredError";
  }
}

export class PDFDocument {
  private mupdfDoc: any = null;
  private metadata: PDFDocumentMetadata;
  private isLoaded: boolean = false;
  private originalFilePath: string | null = null;
  private metadataListeners: Set<() => void> = new Set();
  private pdfData: Uint8Array | null = null;
  /** True when the source file had an /Encrypt dictionary (password OR owner-restrictions). */
  private encrypted: boolean = false;

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

  /**
   * Re-serialize the live (edited) mupdf document and replace the cached
   * byte snapshot. Render workers open the document from these bytes, so
   * every structural edit (insert/delete/reorder/rotate pages, baked-in
   * content changes) must refresh them or the workers keep rendering the
   * file as it was at load time. Returns the fresh bytes (a NEW Uint8Array
   * identity, which byte-identity checks in the renderers rely on), or
   * null when serialization fails.
   */
  refreshPdfData(): Uint8Array | null {
    if (!this.isLoaded || !this.mupdfDoc) return null;
    try {
      const pdf = this.mupdfDoc.asPDF?.() ?? this.mupdfDoc;
      // Encrypted sources must be saved decrypted — the workers have no
      // password to re-authenticate with (mirrors the save path).
      const buffer = this.encrypted
        ? pdf.saveToBuffer("decrypt")
        : pdf.saveToBuffer();
      // Copy out of the mupdf Buffer before destroying it.
      this.pdfData = buffer.asUint8Array().slice();
      try {
        buffer.destroy?.();
      } catch {
        /* ignore */
      }
      return this.pdfData;
    } catch (error) {
      console.error("Failed to refresh PDF data snapshot:", error);
      return null;
    }
  }

  /**
   * Read one page's display dimensions + rotation. mupdf's getBounds()
   * already returns rotated dimensions (it applies the PDF's Rotate field
   * automatically) — do NOT manually swap, that would double-swap.
   */
  private readPageMetadata(i: number): PDFPageMetadata {
    const page = this.mupdfDoc.loadPage(i);
    const bounds = page.getBounds(); // [x0, y0, x1, y1] with rotation applied

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

    // Read stored per-page label (custom /NanodocLabel key), if present.
    let label: string | undefined;
    try {
      const pageObj = page.getObject();
      const labelObj = pageObj?.get("NanodocLabel");
      if (labelObj !== null && labelObj !== undefined && !(labelObj.isNull?.() ?? false)) {
        const s = typeof labelObj.asString === "function" ? labelObj.asString() : null;
        if (s) label = s;
      }
    } catch {
      label = undefined;
    }

    return {
      pageNumber: i,
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      rotation,
      label,
    };
  }

  async loadFromData(data: Uint8Array, mupdf: any, password?: string): Promise<void> {
    try {
      this.pdfData = data;
      this.mupdfDoc = mupdf.Document.openDocument(data, "application/pdf");

      // Password-protected files: authenticate or fail loudly so the UI can
      // prompt. Without this, page loads below would fail in confusing ways.
      if (typeof this.mupdfDoc.needsPassword === "function" && this.mupdfDoc.needsPassword()) {
        const ok = password ? this.mupdfDoc.authenticatePassword(password) !== 0 : false;
        if (!ok) throw new PasswordRequiredError(!!password);
      }

      // Record encryption (incl. owner-restriction-only files that open
      // without a password) — save uses this to decrypt explicitly and the
      // UI uses it to warn that protection is removed on save.
      try {
        const pdf = this.mupdfDoc.asPDF?.();
        const encDict = pdf?.getTrailer?.()?.get?.("Encrypt");
        this.encrypted = !!encDict && !(encDict.isNull?.() ?? true);
      } catch {
        this.encrypted = false;
      }

      this.metadata.pageCount = this.mupdfDoc.countPages();
      this.metadata.pages = [];

      // Load page metadata in chunks, yielding to the event loop between
      // chunks so a 100+ page plan set doesn't block the main thread (and
      // freeze the loading indicator) for the whole loop.
      const CHUNK = 25;
      for (let i = 0; i < this.metadata.pageCount; i++) {
        this.metadata.pages.push(this.readPageMetadata(i));
        if ((i + 1) % CHUNK === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      this.isLoaded = true;
    
    // Detect cover page: check if page 0 has significantly less text than page 1
    // This is done asynchronously after loading to avoid blocking
    this.detectCoverPage().catch(err => {
      console.warn("Error detecting cover page:", err);
    });
    } catch (error) {
      if (error instanceof PasswordRequiredError) throw error;
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
          this.metadata.pages.push(this.readPageMetadata(i));
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

  /** True when the source file was encrypted (password or owner restrictions). */
  isEncrypted(): boolean {
    return this.encrypted;
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

