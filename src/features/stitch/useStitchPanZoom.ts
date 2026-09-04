/**
 * Pan/zoom for the stitch canvas.
 *
 * Wheel handling follows takeoff v2's conventions (the device heuristic itself
 * lives in `wheelIntent.ts`): a mouse wheel ZOOMS to the cursor, a trackpad
 * two-finger swipe PANS, pinch/Ctrl zooms, Shift pans. Before this the wheel
 * only zoomed with Ctrl/Cmd held and otherwise scrolled — which is why plans
 * scrolled off the page instead of zooming.
 */

import { useRef, useEffect, useCallback } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { MIN_ZOOM, MAX_ZOOM, SCROLL_SENSITIVITY } from "./stitchConstants";
import {
  classifyWheel,
  initialWheelKindState,
  panDeltasFor,
  zoomFactorFor,
} from "./wheelIntent";

export function useStitchPanZoom(
  containerRef: React.RefObject<HTMLDivElement | null>,
  /**
   * Lower zoom bound, read fresh on every wheel event. Defaults to MIN_ZOOM; the
   * caller passes a getter so the floor can drop below it when the composition is
   * bigger than the page (see `effectiveMinZoom`) — otherwise sheets placed far
   * outside the canvas can never be zoomed out far enough to see.
   */
  getMinZoom?: () => number
) {
  const panOffset = useStitchStore((s) => s.panOffset);
  const zoomLevel = useStitchStore((s) => s.zoomLevel);
  const setPanOffset = useStitchStore((s) => s.setPanOffset);
  const setZoomLevel = useStitchStore((s) => s.setZoomLevel);
  const panOffsetRef = useRef(panOffset);
  const zoomLevelRef = useRef(zoomLevel);
  /** Which device the recent wheel frames looked like — see classifyWheel. */
  const wheelKindRef = useRef(initialWheelKindState());
  // A ref, not a dep: the getter is rebuilt on every container resize / tile move,
  // and re-subscribing the window listener that often is pointless churn.
  const getMinZoomRef = useRef(getMinZoom);
  getMinZoomRef.current = getMinZoom;

  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const container = containerRef.current;
      if (!container) return;

      // Handle wheel over the canvas itself OR over the fullscreen mode
      // overlays (align/erase portals into document.body) — those cover the
      // viewport and would otherwise make zooming dead exactly when precise
      // point placement needs it.
      const target = e.target as Element | null;
      const inScope =
        target != null &&
        (container.contains(target) ||
          (typeof target.closest === "function" && target.closest("[data-stitch-overlay]") != null));
      if (!inScope) return;

      e.preventDefault();
      e.stopPropagation();

      const currentZoom = zoomLevelRef.current;
      const currentPan = panOffsetRef.current;

      const { intent, pinch, state } = classifyWheel(e, wheelKindRef.current, Date.now());
      wheelKindRef.current = state;

      if (intent === "pan") {
        // Raw OS deltas: the trackpad already reports pixels, so 1:1 feels native.
        const { dx, dy } = panDeltasFor(e);
        const newPan = {
          x: currentPan.x - dx * SCROLL_SENSITIVITY,
          y: currentPan.y - dy * SCROLL_SENSITIVITY,
        };
        panOffsetRef.current = newPan;
        setPanOffset(newPan);
        return;
      }

      // ZOOM to cursor (pinch or mouse wheel).
      const minZoom = getMinZoomRef.current?.() ?? MIN_ZOOM;
      const factor = zoomFactorFor(currentZoom, e.deltaY, pinch);
      const newZoom = Math.max(minZoom, Math.min(MAX_ZOOM, currentZoom * factor));
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      // Hold the canvas-space point under the cursor fixed while the scale changes.
      const canvasX = (mouseX - currentPan.x) / currentZoom;
      const canvasY = (mouseY - currentPan.y) / currentZoom;
      const newPanX = mouseX - canvasX * newZoom;
      const newPanY = mouseY - canvasY * newZoom;
      panOffsetRef.current = { x: newPanX, y: newPanY };
      zoomLevelRef.current = newZoom;
      setZoomLevel(newZoom);
      setPanOffset({ x: newPanX, y: newPanY });
    },
    [containerRef, setPanOffset, setZoomLevel]
  );

  useEffect(() => {
    // Window-level so wheel events over the body-portaled mode overlays are
    // seen too; handleWheel scopes to the canvas/overlays itself.
    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", handleWheel, true);
  }, [handleWheel]);

  return { panOffsetRef, zoomLevelRef };
}
