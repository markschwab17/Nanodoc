/**
 * Close guard: prevents silent data loss when the window is closed with
 * unsaved changes, and tears down tile-renderer workers on exit.
 *
 * - Browser: `beforeunload` shows the native "leave site?" prompt while any
 *   tab is modified; `pagehide` destroys all tile renderers.
 * - Tauri: intercepts the window close request and asks for confirmation via
 *   a native dialog when any tab is modified.
 */

import { useEffect } from "react";
import { isTauri } from "@/shared/utils/environment";
import { useTabStore } from "@/shared/stores/tabStore";
import { destroyAllTiledRenderers } from "@/core/pdf/tiles/tiledRendererRegistry";

function hasUnsavedChanges(): boolean {
  return useTabStore.getState().tabs.some((t) => t.isModified);
}

export function useCloseGuard() {
  useEffect(() => {
    if (isTauri) {
      let unlisten: (() => void) | null = null;
      let disposed = false;

      (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const un = await getCurrentWindow().onCloseRequested(async (event) => {
            if (hasUnsavedChanges()) {
              const confirmed = await ask(
                "You have unsaved changes. Close anyway?\n\nUnsaved edits will be lost.",
                { title: "Unsaved changes", kind: "warning", okLabel: "Close", cancelLabel: "Cancel" }
              );
              if (!confirmed) {
                event.preventDefault();
                return;
              }
            }
            destroyAllTiledRenderers();
          });
          if (disposed) un();
          else unlisten = un;
        } catch (e) {
          console.warn("[CloseGuard] Failed to register Tauri close handler:", e);
        }
      })();

      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    }

    // Browser
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        e.preventDefault();
        // Chrome requires returnValue to be set to show the prompt.
        e.returnValue = "";
      }
    };
    const handlePageHide = () => {
      destroyAllTiledRenderers();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);
}
