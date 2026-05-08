/**
 * Tile-renderer pending-work counter.
 *
 * A tiny module-level counter that every TiledPageRenderer pings before
 * issuing a tile request and again after it settles (resolve OR reject).
 * UI components (e.g. StatusBar) subscribe via useTilesPending() to show
 * a "rendering…" indicator while higher-resolution tiles are streaming in.
 *
 * Notifications are RAF-coalesced so a burst of tile arrivals from the
 * worker pool produces at most one re-render per animation frame.
 */

import { useSyncExternalStore } from "react";

let pending = 0;
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

/** Increment (positive) or decrement (negative) the pending counter. */
export function bumpTilesPending(delta: number): void {
  pending += delta;
  if (pending < 0) pending = 0; // defensive — should never happen
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): number {
  return pending;
}

/**
 * React hook returning the current count of in-flight + queued tile
 * render requests across all renderer instances. Re-renders at most
 * once per animation frame regardless of how many tiles are arriving.
 */
export function useTilesPending(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
