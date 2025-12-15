/**
 * Vertical Ruler Component
 * 
 * Displays a vertical ruler with inch measurements at the left side of the canvas.
 */

import { useEffect, useRef } from "react";
import { POINTS_PER_INCH } from "@/shared/stores/documentSettingsStore";

interface VerticalRulerProps {
  height: number; // Page height in points
  zoomLevel: number;
  panOffset: { x: number; y: number };
  containerHeight: number;
}

export function VerticalRuler({ height, zoomLevel, panOffset, containerHeight }: VerticalRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size to match container
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 24 * dpr;
    canvas.height = containerHeight * dpr;
    canvas.style.width = "24px";
    canvas.style.height = `${containerHeight}px`;

    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, 24, containerHeight);

    // Background
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, 24, containerHeight);

    // Border
    ctx.strokeStyle = "#d0d0d0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(23.5, 0);
    ctx.lineTo(23.5, containerHeight);
    ctx.stroke();

    // Calculate visible range in points (accounting for zoom and pan)
    const heightInPoints = height;
    
    // The page starts at panOffset.y in screen coordinates
    const pageStartY = panOffset.y;

    // Draw tick marks and labels
    ctx.strokeStyle = "#666";
    ctx.fillStyle = "#333";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // Calculate how many inches tall the page is
    const heightInInches = heightInPoints / POINTS_PER_INCH;

    // Draw tick marks at inch and half-inch intervals
    for (let inch = 0; inch <= Math.ceil(heightInInches); inch++) {
      const pointsFromTop = inch * POINTS_PER_INCH;
      const screenY = pageStartY + (pointsFromTop * zoomLevel);

      // Only draw if within visible area
      if (screenY >= 0 && screenY <= containerHeight) {
        // Major tick (inch)
        ctx.beginPath();
        ctx.moveTo(24, screenY);
        ctx.lineTo(14, screenY);
        ctx.stroke();

        // Label (rotated text)
        if (inch <= heightInInches) {
          ctx.save();
          ctx.translate(10, screenY);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = "center";
          ctx.fillText(`${inch}"`, 0, 0);
          ctx.restore();
        }
      }

      // Half-inch tick
      if (inch < heightInInches) {
        const halfInchPointsFromTop = pointsFromTop + (POINTS_PER_INCH / 2);
        const halfInchScreenY = pageStartY + (halfInchPointsFromTop * zoomLevel);

        if (halfInchScreenY >= 0 && halfInchScreenY <= containerHeight) {
          ctx.beginPath();
          ctx.moveTo(24, halfInchScreenY);
          ctx.lineTo(18, halfInchScreenY);
          ctx.stroke();
        }

        // Quarter-inch ticks (only if zoomed in enough)
        if (zoomLevel >= 1.5) {
          for (let quarter = 1; quarter < 4; quarter += 2) {
            const quarterInchPointsFromTop = pointsFromTop + (POINTS_PER_INCH * quarter / 4);
            const quarterInchScreenY = pageStartY + (quarterInchPointsFromTop * zoomLevel);

            if (quarterInchScreenY >= 0 && quarterInchScreenY <= containerHeight) {
              ctx.beginPath();
              ctx.moveTo(24, quarterInchScreenY);
              ctx.lineTo(20, quarterInchScreenY);
              ctx.stroke();
            }
          }
        }
      }
    }
  }, [height, zoomLevel, panOffset, containerHeight]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 z-50 pointer-events-none"
      style={{ width: 24, height: containerHeight }}
      aria-label="Vertical ruler in inches"
    />
  );
}

