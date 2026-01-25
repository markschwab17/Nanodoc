/**
 * Spec Extraction Store
 * 
 * Manages state for AI-powered spec extraction feature.
 */

import { create } from "zustand";
import type { SpecExtractionResult } from "@/core/ai/types";

export interface SpecHighlight {
  page: number;
  bbox: [number, number, number, number];
  specId: string;
  color?: string;
}

export interface TemporaryTextHighlight {
  page: number;
  quads: number[][]; // Array of quads in PDF coordinates
  color: string;
  specId: string;
}

export interface SpecExtractionState {
  // Extraction state
  isExtracting: boolean;
  extractionProgress: number; // 0-100
  extractionError: string | null;
  
  // Results
  extractedSpecs: Map<string, SpecExtractionResult[]>; // documentId -> specs
  specHighlights: Map<string, SpecHighlight[]>; // documentId -> highlights
  
  // Current extraction
  currentDocumentId: string | null;
  
  // Selected spec for highlighting
  selectedSpecId: string | null;
  selectedSpecDocumentId: string | null;
  
  // Temporary text highlight (for clicked specs)
  temporaryHighlight: TemporaryTextHighlight | null;
  
  // Actions
  startExtraction: (documentId: string) => void;
  setExtractionProgress: (progress: number) => void;
  setExtractionError: (error: string | null) => void;
  setExtractedSpecs: (documentId: string, specs: SpecExtractionResult[]) => void;
  setSpecHighlights: (documentId: string, highlights: SpecHighlight[]) => void;
  setSelectedSpec: (documentId: string, specId: string | null) => void;
  setTemporaryHighlight: (highlight: TemporaryTextHighlight | null) => void;
  finishExtraction: () => void;
  clearExtraction: (documentId: string) => void;
  getExtractedSpecs: (documentId: string) => SpecExtractionResult[];
  getSpecHighlights: (documentId: string) => SpecHighlight[];
}

export const useSpecExtractionStore = create<SpecExtractionState>((set, get) => ({
  isExtracting: false,
  extractionProgress: 0,
  extractionError: null,
  extractedSpecs: new Map(),
  specHighlights: new Map(),
  currentDocumentId: null,
  selectedSpecId: null,
  selectedSpecDocumentId: null,
  temporaryHighlight: null,
  
  setSelectedSpec: (documentId: string, specId: string | null) =>
    set({ selectedSpecId: specId, selectedSpecDocumentId: specId ? documentId : null }),
  
  setTemporaryHighlight: (highlight: TemporaryTextHighlight | null) =>
    set({ temporaryHighlight: highlight }),
  
  startExtraction: (documentId: string) =>
    set({
      isExtracting: true,
      extractionProgress: 0,
      extractionError: null,
      currentDocumentId: documentId,
    }),
  
  setExtractionProgress: (progress: number) =>
    set({ extractionProgress: Math.max(0, Math.min(100, progress)) }),
  
  setExtractionError: (error: string | null) =>
    set({ extractionError: error, isExtracting: false }),
  
  setExtractedSpecs: (documentId: string, specs: SpecExtractionResult[]) =>
    set((state) => {
      const newSpecs = new Map(state.extractedSpecs);
      newSpecs.set(documentId, specs);
      return { extractedSpecs: newSpecs };
    }),
  
  setSpecHighlights: (documentId: string, highlights: SpecHighlight[]) =>
    set((state) => {
      const newHighlights = new Map(state.specHighlights);
      newHighlights.set(documentId, highlights);
      return { specHighlights: newHighlights };
    }),
  
  finishExtraction: () =>
    set({
      isExtracting: false,
      extractionProgress: 100,
    }),
  
  clearExtraction: (documentId: string) =>
    set((state) => {
      const newSpecs = new Map(state.extractedSpecs);
      const newHighlights = new Map(state.specHighlights);
      newSpecs.delete(documentId);
      newHighlights.delete(documentId);
      return {
        extractedSpecs: newSpecs,
        specHighlights: newHighlights,
        currentDocumentId: state.currentDocumentId === documentId ? null : state.currentDocumentId,
      };
    }),
  
  getExtractedSpecs: (documentId: string) => {
    const state = get();
    return state.extractedSpecs.get(documentId) || [];
  },
  
  getSpecHighlights: (documentId: string) => {
    const state = get();
    return state.specHighlights.get(documentId) || [];
  },
}));
