/**
 * PDF Store
 * 
 * Manages PDF documents, pages, and rendering state using Zustand.
 */

import { create } from "zustand";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { Annotation } from "@/core/pdf/PDFEditor";
import type { Bookmark } from "@/core/pdf/PDFBookmarks";
import { clearTextCache } from "@/core/pdf/PDFTextExtractor";
import { destroyTiledRenderer } from "@/core/pdf/tiles/tiledRendererRegistry";
import { useTabStore } from "./tabStore";

/** Mark the tab for a document as modified (unsaved changes). */
function markDocumentModified(documentId: string) {
  const tab = useTabStore.getState().getTabByDocumentId(documentId);
  if (tab) useTabStore.getState().setTabModified(tab.id, true);
}

// Individual search match (one per text match occurrence)
export interface SearchMatch {
  pageNumber: number;
  quad: number[][]; // Array of quads (each quad is [x0, y0, x1, y1, x2, y2, x3, y3]) - multi-line matches have multiple quads
  text: string;
  matchIndex: number; // Global index across all pages
}

// Results structure stored per document
export interface SearchResultData {
  matches: SearchMatch[]; // Flattened list of all individual matches
  query: string;
}

export interface PDFStoreState {
  documents: Map<string, PDFDocument>;
  documentPaths: Map<string, string | null>; // documentId -> original file path
  currentDocumentId: string | null;
  currentPage: number;
  annotations: Map<string, Annotation[]>; // documentId -> annotations
  bookmarks: Map<string, Bookmark[]>; // documentId -> bookmarks
  searchResults: Map<string, SearchResultData>; // documentId -> search results
  currentSearchResult: number; // Index into the flattened matches array
  /** Per-document, per-page horizontal flip (mirror). PDF Rotate cannot represent mirror, so we store it in UI state. */
  pageHorizontalFlips: Map<string, Set<number>>; // documentId -> set of page numbers
  loading: boolean;
  error: string | null;

  // Actions
  getPageHorizontalFlip: (documentId: string, pageNumber: number) => boolean;
  setPageHorizontalFlip: (documentId: string, pageNumber: number, flipped: boolean) => void;
  togglePageHorizontalFlip: (documentId: string, pageNumber: number) => boolean;
  addDocument: (document: PDFDocument, originalPath?: string | null) => void;
  removeDocument: (id: string) => void;
  setCurrentDocument: (id: string) => void;
  setDocumentPath: (documentId: string, path: string | null) => void;
  getDocumentPath: (documentId: string) => string | null;
  setCurrentPage: (page: number) => void;
  getCurrentDocument: () => PDFDocument | null;
  addAnnotation: (documentId: string, annotation: Annotation) => void;
  removeAnnotation: (documentId: string, annotationId: string) => void;
  updateAnnotation: (
    documentId: string,
    annotationId: string,
    updates: Partial<Annotation>
  ) => void;
  getAnnotations: (documentId: string) => Annotation[];
  addBookmark: (documentId: string, bookmark: Bookmark) => void;
  removeBookmark: (documentId: string, bookmarkId: string) => void;
  getBookmarks: (documentId: string) => Bookmark[];
  setSearchResults: (documentId: string, results: SearchResultData) => void;
  getSearchResults: (documentId: string) => SearchResultData | null;
  getSearchMatchesForPage: (documentId: string, pageNumber: number) => SearchMatch[];
  getCurrentSearchMatch: () => SearchMatch | null;
  setCurrentSearchResult: (index: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const usePDFStore = create<PDFStoreState>((set, get) => ({
  documents: new Map(),
  documentPaths: new Map(),
  currentDocumentId: null,
  currentPage: 0,
  annotations: new Map(),
  bookmarks: new Map(),
  searchResults: new Map(),
  currentSearchResult: -1,
  pageHorizontalFlips: new Map(),
  loading: false,
  error: null,

  getPageHorizontalFlip: (documentId, pageNumber) => {
    const set = get().pageHorizontalFlips.get(documentId);
    return set ? set.has(pageNumber) : false;
  },

  setPageHorizontalFlip: (documentId, pageNumber, flipped) =>
    set((state) => {
      const next = new Map(state.pageHorizontalFlips);
      const set = new Set(next.get(documentId) || []);
      if (flipped) set.add(pageNumber);
      else set.delete(pageNumber);
      next.set(documentId, set);
      return { pageHorizontalFlips: next };
    }),

  togglePageHorizontalFlip: (documentId, pageNumber) => {
    const current = get().getPageHorizontalFlip(documentId, pageNumber);
    get().setPageHorizontalFlip(documentId, pageNumber, !current);
    return !current;
  },

  addDocument: (document, originalPath = null) =>
    set((state) => {
      const newDocuments = new Map(state.documents);
      newDocuments.set(document.getId(), document);
      const newPaths = new Map(state.documentPaths);
      newPaths.set(document.getId(), originalPath);
      const isNewCurrentDoc = !state.currentDocumentId;
      return {
        documents: newDocuments,
        documentPaths: newPaths,
        currentDocumentId:
          state.currentDocumentId || document.getId(),
        ...(isNewCurrentDoc ? { currentPage: 0 } : {}),
      };
    }),

  removeDocument: (id) => {
    // Clear text extraction cache for this document (prevents memory leak)
    clearTextCache(id);
    // Destroy the tile-renderer instance for this doc — terminates its workers,
    // drops its mupdf wasm heap, and closes any cached tile bitmaps. Without
    // this every closed doc leaks one renderer + N workers + its tile cache.
    destroyTiledRenderer(id);
    set((state) => {
      const newDocuments = new Map(state.documents);
      newDocuments.delete(id);
      const newPaths = new Map(state.documentPaths);
      newPaths.delete(id);
      const newAnnotations = new Map(state.annotations);
      newAnnotations.delete(id);
      const newSearchResults = new Map(state.searchResults);
      newSearchResults.delete(id);
      const newPageHorizontalFlips = new Map(state.pageHorizontalFlips);
      newPageHorizontalFlips.delete(id);

      let newCurrentId = state.currentDocumentId;
      if (newCurrentId === id) {
        newCurrentId =
          Array.from(newDocuments.keys())[0] || null;
      }

      return {
        documents: newDocuments,
        documentPaths: newPaths,
        annotations: newAnnotations,
        searchResults: newSearchResults,
        pageHorizontalFlips: newPageHorizontalFlips,
        currentDocumentId: newCurrentId,
        currentPage: 0,
      };
    });
  },

  setDocumentPath: (documentId, path) =>
    set((state) => {
      const newPaths = new Map(state.documentPaths);
      newPaths.set(documentId, path);
      return { documentPaths: newPaths };
    }),

  getDocumentPath: (documentId) => {
    const state = get();
    return state.documentPaths.get(documentId) || null;
  },

  setCurrentDocument: (id) =>
    set((state) => {
      // Don't reset currentPage when the document hasn't actually changed
      if (state.currentDocumentId === id) return state;
      return { currentDocumentId: id, currentPage: 0 };
    }),

  setCurrentPage: (page) => set({ currentPage: page }),

  getCurrentDocument: () => {
    const state = get();
    if (!state.currentDocumentId) return null;
    return state.documents.get(state.currentDocumentId) || null;
  },

  addAnnotation: (documentId, annotation) => {
    set((state) => {
      const newAnnotations = new Map(state.annotations);
      const docAnnotations = newAnnotations.get(documentId) || [];
      newAnnotations.set(documentId, [...docAnnotations, annotation]);
      return { annotations: newAnnotations };
    });
    markDocumentModified(documentId);
  },

  removeAnnotation: (documentId, annotationId) => {
    set((state) => {
      const newAnnotations = new Map(state.annotations);
      const docAnnotations = newAnnotations.get(documentId) || [];
      newAnnotations.set(
        documentId,
        docAnnotations.filter((a) => a.id !== annotationId)
      );
      return { annotations: newAnnotations };
    });
    markDocumentModified(documentId);
  },

  updateAnnotation: (documentId, annotationId, updates) => {
    set((state) => {
      const newAnnotations = new Map(state.annotations);
      const docAnnotations = newAnnotations.get(documentId) || [];
      newAnnotations.set(
        documentId,
        docAnnotations.map((a) =>
          a.id === annotationId ? { ...a, ...updates } : a
        )
      );
      return { annotations: newAnnotations };
    });
    markDocumentModified(documentId);
  },

  getAnnotations: (documentId) => {
    const state = get();
    return state.annotations.get(documentId) || [];
  },

  addBookmark: (documentId, bookmark) => {
    set((state) => {
      const newBookmarks = new Map(state.bookmarks);
      const docBookmarks = newBookmarks.get(documentId) || [];
      newBookmarks.set(documentId, [...docBookmarks, bookmark]);
      return { bookmarks: newBookmarks };
    });
    // Bookmarks are persisted into the PDF on save, so they count as
    // unsaved changes. (Document load also calls this while restoring
    // saved bookmarks — the tab is created after restore, so the lookup
    // inside markDocumentModified finds no tab and stays a no-op there.)
    markDocumentModified(documentId);
  },

  removeBookmark: (documentId, bookmarkId) => {
    set((state) => {
      const newBookmarks = new Map(state.bookmarks);
      const docBookmarks = newBookmarks.get(documentId) || [];
      newBookmarks.set(
        documentId,
        docBookmarks.filter((b) => b.id !== bookmarkId)
      );
      return { bookmarks: newBookmarks };
    });
    markDocumentModified(documentId);
  },

  getBookmarks: (documentId) => {
    const state = get();
    return state.bookmarks.get(documentId) || [];
  },

  setSearchResults: (documentId, results) =>
    set((state) => {
      const newSearchResults = new Map(state.searchResults);
      newSearchResults.set(documentId, results);
      return { 
        searchResults: newSearchResults, 
        currentSearchResult: results.matches.length > 0 ? 0 : -1 
      };
    }),

  getSearchResults: (documentId) => {
    const state = get();
    return state.searchResults.get(documentId) || null;
  },

  getSearchMatchesForPage: (documentId, pageNumber) => {
    const state = get();
    const results = state.searchResults.get(documentId);
    if (!results) return [];
    return results.matches.filter(m => m.pageNumber === pageNumber);
  },

  getCurrentSearchMatch: () => {
    const state = get();
    if (!state.currentDocumentId || state.currentSearchResult < 0) return null;
    const results = state.searchResults.get(state.currentDocumentId);
    if (!results || state.currentSearchResult >= results.matches.length) return null;
    return results.matches[state.currentSearchResult];
  },

  setCurrentSearchResult: (index) => set({ currentSearchResult: index }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),
}));

