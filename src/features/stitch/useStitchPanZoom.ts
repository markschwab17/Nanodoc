/**
 * Pan/zoom for stitch canvas: wheel zoom (Ctrl) and pan, refs kept in sync with store.
 */

import { useRef, useEffect, useCallback } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { MIN_ZOOM, MAX_ZOOM, ZOOM_DELTA, SCROLL_SENSITIVITY } from "./stitchConstants";

export function useStitchPanZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const panOffset = useStitchStore((s) => s.panOffset);
  const zoomLevel = useStitchStore((s) => s.zoomLevel);
  const setPanOffset = useStitchStore((s) => s.setPanOffset);
  const setZoomLevel = useStitchStore((s) => s.setZoomLevel);
  const panOffsetRef = useRef(panOffset);
  const zoomLevelRef = useRef(zoomLevel);

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

      const currentZoom = zoomLevelRef.current;
      const currentPan = panOffsetRef.current;

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? 1 / ZOOM_DELTA : ZOOM_DELTA;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom * delta));
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const canvasX = (mouseX - currentPan.x) / currentZoom;
        const canvasY = (mouseY - currentPan.y) / currentZoom;
        const newPanX = mouseX - canvasX * newZoom;
        const newPanY = mouseY - canvasY * newZoom;
        panOffsetRef.current = { x: newPanX, y: newPanY };
        zoomLevelRef.current = newZoom;
        setZoomLevel(newZoom);
        setPanOffset({ x: newPanX, y: newPanY });
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      const panDeltaX = e.shiftKey ? -e.deltaY * SCROLL_SENSITIVITY : -e.deltaX * SCROLL_SENSITIVITY;
      const panDeltaY = e.shiftKey ? 0 : -e.deltaY * SCROLL_SENSITIVITY;
      const newPan = {
        x: currentPan.x + panDeltaX,
        y: currentPan.y + panDeltaY,
      };
      panOffsetRef.current = newPan;
      setPanOffset(newPan);
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
