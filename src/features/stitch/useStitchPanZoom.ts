/**
 * Pan/zoom for stitch canvas: wheel zoom (Ctrl) and pan, refs kept in sync with store.
 */

import { useRef, useEffect, useCallback } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { MIN_ZOOM, MAX_ZOOM, ZOOM_DELTA, SCROLL_SENSITIVITY } from "./stitchConstants";

export function useStitchPanZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const { panOffset, zoomLevel, setPanOffset, setZoomLevel } = useStitchStore();
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
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [containerRef, handleWheel]);

  return { panOffsetRef, zoomLevelRef };
}
