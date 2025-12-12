/**
 * Notification Store
 * 
 * Simple store for showing temporary notifications.
 */

import { create } from "zustand";

export interface Notification {
  id: string;
  message: string;
  type?: "success" | "error" | "info";
  timestamp: number;
}

export interface NotificationStoreState {
  notifications: Notification[];
  
  // Actions
  showNotification: (message: string, type?: "success" | "error" | "info") => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
}

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  notifications: [],

  showNotification: (message, type = "info") => {
    const id = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const notification: Notification = {
      id,
      message,
      type,
      timestamp: Date.now(),
    };

    set((state) => ({
      notifications: [...state.notifications, notification],
    }));

    // Auto-remove after 3 seconds
    setTimeout(() => {
      useNotificationStore.getState().removeNotification(id);
    }, 3000);
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearNotifications: () => {
    set({ notifications: [] });
  },
}));



