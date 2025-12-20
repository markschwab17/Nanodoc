/**
 * Recent Files Store
 * 
 * Manages recent files list with persistence using localStorage (browser) 
 * or Tauri app data directory (desktop app).
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface RecentFile {
  path: string;
  name: string;
  lastOpened: number; // timestamp
  thumbnailPath?: string; // optional thumbnail
}

interface RecentFilesStoreState {
  recentFiles: RecentFile[];
  maxRecentFiles: number;
  
  // Actions
  addRecentFile: (file: RecentFile) => void;
  removeRecentFile: (path: string) => void;
  clearRecentFiles: () => void;
  getRecentFiles: () => RecentFile[];
}

export const useRecentFilesStore = create<RecentFilesStoreState>()(
  persist(
    (set, get) => ({
      recentFiles: [],
      maxRecentFiles: 30,

      addRecentFile: (file) =>
        set((state) => {
          // Remove existing entry if it exists (to avoid duplicates)
          const filtered = state.recentFiles.filter((f) => f.path !== file.path);
          
          // Add new entry at the beginning
          const updated = [file, ...filtered];
          
          // Limit to maxRecentFiles
          const limited = updated.slice(0, state.maxRecentFiles);
          
          return { recentFiles: limited };
        }),

      removeRecentFile: (path) =>
        set((state) => ({
          recentFiles: state.recentFiles.filter((f) => f.path !== path),
        })),

      clearRecentFiles: () => set({ recentFiles: [] }),

      getRecentFiles: () => {
        const state = get();
        // Sort by lastOpened (most recent first)
        return [...state.recentFiles].sort((a, b) => b.lastOpened - a.lastOpened);
      },
    }),
    {
      name: "recent-files-storage",
      storage: createJSONStorage(() => localStorage),
      // Only persist recentFiles array
      partialize: (state) => ({ recentFiles: state.recentFiles }),
    }
  )
);




















