/**
 * Stamp Store
 * 
 * Manages stamp templates for PDF annotations.
 * Stores stamps in localStorage for persistence.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StampData } from "@/core/pdf/PDFEditor";

interface StampState {
  stamps: StampData[];
  recentlyUsed: string[]; // Array of stamp IDs
  stampSizeMultiplier: number; // Size multiplier for stamp placement (0.1 to 2.0, default 0.5)
  
  // Actions
  addStamp: (stamp: StampData) => void;
  updateStamp: (id: string, updates: Partial<StampData>) => void;
  deleteStamp: (id: string) => void;
  getStamp: (id: string) => StampData | undefined;
  markAsUsed: (id: string) => void;
  getRecentStamps: (limit?: number) => StampData[];
  searchStamps: (query: string) => StampData[];
  setStampSizeMultiplier: (multiplier: number) => void;
}

export const useStampStore = create<StampState>()(
  persist(
    (set, get) => ({
      stamps: [],
      recentlyUsed: [],
      stampSizeMultiplier: 0.5, // Default to 50% size

      addStamp: (stamp) => {
        set((state) => ({
          stamps: [...state.stamps, stamp],
        }));
      },

      updateStamp: (id, updates) => {
        set((state) => ({
          stamps: state.stamps.map((stamp) =>
            stamp.id === id ? { ...stamp, ...updates } : stamp
          ),
        }));
      },

      deleteStamp: (id) => {
        set((state) => ({
          stamps: state.stamps.filter((stamp) => stamp.id !== id),
          recentlyUsed: state.recentlyUsed.filter((stampId) => stampId !== id),
        }));
      },

      getStamp: (id) => {
        return get().stamps.find((stamp) => stamp.id === id);
      },

      markAsUsed: (id) => {
        set((state) => {
          const recentlyUsed = [
            id,
            ...state.recentlyUsed.filter((stampId) => stampId !== id),
          ].slice(0, 10); // Keep only last 10
          return { recentlyUsed };
        });
      },

      getRecentStamps: (limit = 5) => {
        const state = get();
        return state.recentlyUsed
          .slice(0, limit)
          .map((id) => state.stamps.find((stamp) => stamp.id === id))
          .filter((stamp): stamp is StampData => stamp !== undefined);
      },

      searchStamps: (query) => {
        const state = get();
        const lowerQuery = query.toLowerCase();
        return state.stamps.filter((stamp) =>
          stamp.name.toLowerCase().includes(lowerQuery)
        );
      },

      setStampSizeMultiplier: (multiplier) => {
        set({ stampSizeMultiplier: Math.max(0.1, Math.min(2.0, multiplier)) });
      },
    }),
    {
      name: "pdf-stamp-storage",
      partialize: (state) => ({
        stamps: state.stamps,
        recentlyUsed: state.recentlyUsed,
        stampSizeMultiplier: state.stampSizeMultiplier,
      }),
    }
  )
);

