/**
 * Tab Store
 * 
 * Manages multiple PDF tabs: open, close, switch, reorder.
 */

import { create } from "zustand";

export interface Tab {
  id: string;
  documentId: string;
  name: string;
  isModified: boolean;
  order: number;
}

export interface TabStoreState {
  tabs: Tab[];
  activeTabId: string | null;

  // Actions
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTab: (id: string, updates: Partial<Tab>) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  getActiveTab: () => Tab | null;
  getTabByDocumentId: (documentId: string) => Tab | null;
  setTabModified: (id: string, modified: boolean) => void;
}

export const useTabStore = create<TabStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (tab) =>
    set((state) => {
      // Check if tab already exists for this document
      const existingTab = state.tabs.find(
        (t) => t.documentId === tab.documentId
      );
      if (existingTab) {
        return {
          activeTabId: existingTab.id,
        };
      }

      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
      };
    }),

  removeTab: (id) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      let newActiveId = state.activeTabId;

      if (newActiveId === id) {
        // Find next tab to activate
        const removedIndex = state.tabs.findIndex((t) => t.id === id);
        if (removedIndex > 0) {
          newActiveId = state.tabs[removedIndex - 1].id;
        } else if (newTabs.length > 0) {
          newActiveId = newTabs[0].id;
        } else {
          newActiveId = null;
        }
      }

      return {
        tabs: newTabs,
        activeTabId: newActiveId,
      };
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTab: (id, updates) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, moved);
      
      // Update order property
      newTabs.forEach((tab, index) => {
        tab.order = index;
      });

      return { tabs: newTabs };
    }),

  getActiveTab: () => {
    const state = get();
    if (!state.activeTabId) return null;
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  },

  getTabByDocumentId: (documentId) => {
    const state = get();
    return state.tabs.find((t) => t.documentId === documentId) || null;
  },

  setTabModified: (id, modified) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, isModified: modified } : t
      ),
    })),
}));








