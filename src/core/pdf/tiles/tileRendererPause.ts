/**
 * Tile-renderer pause signal.
 *
 * A module-level boolean every TiledCanvas reads; when true, TiledCanvas
 * skips its `setViewport` effect — pages still mount and paint cached
 * fallbacks, but no new tile requests hit the WorkerPool. Used by
 * VirtualizedPageList during fast/fling scrolls to stop generating
 * thousands of viewport changes for pages the user is flying past.
 *
 * Notifications are RAF-coalesced (matches tileRendererStatus convention)
 * so toggling within a frame produces one re-render, not two.
 */

import { useSyncExternalStore } from "react";

let paused = false;
const listeners = new Set<() => void>();
let scheduled = false;

function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const cb of listeners) cb();
  });
}

/** Set the paused state. No-op when value is unchanged. */
export function setTilesPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return paused;
}

/** React hook returning the current pause state. */
export function useTilesPaused(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
