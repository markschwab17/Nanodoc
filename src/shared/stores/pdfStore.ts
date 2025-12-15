/**
 * PDF Store
 * 
 * Manages PDF documents, pages, and rendering state using Zustand.
 */

import { create } from "zustand";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { Annotation } from "@/core/pdf/PDFEditor";
import type { Bookmark } from "@/core/pdf/PDFBookmarks";

export interface PDFStoreState {
  documents: Map<string, PDFDocument>;
  documentPaths: Map<string, string | null>; // documentId -> original file path
  currentDocumentId: string | null;
  currentPage: number;
  annotations: Map<string, Annotation[]>; // documentId -> annotations
  bookmarks: Map<string, Bookmark[]>; // documentId -> bookmarks
  searchResults: Map<string, any[]>; // documentId -> search results
  currentSearchResult: number;
  loading: boolean;
  error: string | null;

  // Actions
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
  setSearchResults: (documentId: string, results: any[]) => void;
  getSearchResults: (documentId: string) => any[];
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
  loading: false,
  error: null,

  addDocument: (document, originalPath = null) =>
    set((state) => {
      const newDocuments = new Map(state.documents);
      newDocuments.set(document.getId(), document);
      const newPaths = new Map(state.documentPaths);
      newPaths.set(document.getId(), originalPath);
      return {
        documents: newDocuments,
        documentPaths: newPaths,
        currentDocumentId:
          state.currentDocumentId || document.getId(),
        currentPage: 0,
      };
    }),

  removeDocument: (id) =>
    set((state) => {
      const newDocuments = new Map(state.documents);
      newDocuments.delete(id);
      const newPaths = new Map(state.documentPaths);
      newPaths.delete(id);
      const newAnnotations = new Map(state.annotations);
      newAnnotations.delete(id);
      
      let newCurrentId = state.currentDocumentId;
      if (newCurrentId === id) {
        newCurrentId =
          Array.from(newDocuments.keys())[0] || null;
      }

      return {
        documents: newDocuments,
        documentPaths: newPaths,
        annotations: newAnnotations,
        currentDocumentId: newCurrentId,
        currentPage: 0,
      };
    }),

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
    set({ currentDocumentId: id, currentPage: 0 }),

  setCurrentPage: (page) => set({ currentPage: page }),

  getCurrentDocument: () => {
    const state = get();
    if (!state.currentDocumentId) return null;
    return state.documents.get(state.currentDocumentId) || null;
  },

  addAnnotation: (documentId, annotation) =>
    set((state) => {
      const newAnnotations = new Map(state.annotations);
      const docAnnotations = newAnnotations.get(documentId) || [];
      newAnnotations.set(documentId, [...docAnnotations, annotation]);
      return { annotations: newAnnotations };
    }),

  removeAnnotation: (documentId, annotationId) =>
    set((state) => {
      const newAnnotations = new Map(state.annotations);
      const docAnnotations = newAnnotations.get(documentId) || [];
      newAnnotations.set(
        documentId,
        docAnnotations.filter((a) => a.id !== annotationId)
      );
      return { annotations: newAnnotations };
    }),

  updateAnnotation: (documentId, annotationId, updates) =>
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
    }),

  getAnnotations: (documentId) => {
    const state = get();
    return state.annotations.get(documentId) || [];
  },

  addBookmark: (documentId, bookmark) =>
    set((state) => {
      const newBookmarks = new Map(state.bookmarks);
      const docBookmarks = newBookmarks.get(documentId) || [];
      newBookmarks.set(documentId, [...docBookmarks, bookmark]);
      return { bookmarks: newBookmarks };
    }),

  removeBookmark: (documentId, bookmarkId) =>
    set((state) => {
      const newBookmarks = new Map(state.bookmarks);
      const docBookmarks = newBookmarks.get(documentId) || [];
      newBookmarks.set(
        documentId,
        docBookmarks.filter((b) => b.id !== bookmarkId)
      );
      return { bookmarks: newBookmarks };
    }),

  getBookmarks: (documentId) => {
    const state = get();
    return state.bookmarks.get(documentId) || [];
  },

  setSearchResults: (documentId, results) =>
    set((state) => {
      const newSearchResults = new Map(state.searchResults);
      newSearchResults.set(documentId, results);
      return { searchResults: newSearchResults, currentSearchResult: results.length > 0 ? 0 : -1 };
    }),

  getSearchResults: (documentId) => {
    const state = get();
    return state.searchResults.get(documentId) || [];
  },

  setCurrentSearchResult: (index) => set({ currentSearchResult: index }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),
}));

