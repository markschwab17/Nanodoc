/**
 * Horizontal Ruler Component
 * 
 * Displays a horizontal ruler with inch measurements at the top of the canvas.
 */

import { useEffect, useRef } from "react";
import { POINTS_PER_INCH } from "@/shared/stores/documentSettingsStore";

interface HorizontalRulerProps {
  width: number; // Page width in points
  zoomLevel: number;
  panOffset: { x: number; y: number };
  containerWidth: number;
}

export function HorizontalRuler({ width, zoomLevel, panOffset, containerWidth }: HorizontalRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas size to match container
    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerWidth * dpr;
    canvas.height = 24 * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = "24px";

    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, containerWidth, 24);

    // Background
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, containerWidth, 24);

    // Border
    ctx.strokeStyle = "#d0d0d0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 23.5);
    ctx.lineTo(containerWidth, 23.5);
    ctx.stroke();

    // Calculate visible range in points (accounting for zoom and pan)
    const widthInPoints = width;
    
    // The page starts at panOffset.x in screen coordinates
    const pageStartX = panOffset.x;

    // Draw tick marks and labels
    ctx.strokeStyle = "#666";
    ctx.fillStyle = "#333";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // Calculate how many inches wide the page is
    const widthInInches = widthInPoints / POINTS_PER_INCH;

    // Draw tick marks at inch and half-inch intervals
    for (let inch = 0; inch <= Math.ceil(widthInInches); inch++) {
      const pointsFromLeft = inch * POINTS_PER_INCH;
      const screenX = pageStartX + (pointsFromLeft * zoomLevel);

      // Only draw if within visible area
      if (screenX >= 0 && screenX <= containerWidth) {
        // Major tick (inch)
        ctx.beginPath();
        ctx.moveTo(screenX, 24);
        ctx.lineTo(screenX, 14);
        ctx.stroke();

        // Label
        if (inch <= widthInInches) {
          ctx.fillText(`${inch}"`, screenX, 2);
        }
      }

      // Half-inch tick
      if (inch < widthInInches) {
        const halfInchPointsFromLeft = pointsFromLeft + (POINTS_PER_INCH / 2);
        const halfInchScreenX = pageStartX + (halfInchPointsFromLeft * zoomLevel);

        if (halfInchScreenX >= 0 && halfInchScreenX <= containerWidth) {
          ctx.beginPath();
          ctx.moveTo(halfInchScreenX, 24);
          ctx.lineTo(halfInchScreenX, 18);
          ctx.stroke();
        }

        // Quarter-inch ticks (only if zoomed in enough)
        if (zoomLevel >= 1.5) {
          for (let quarter = 1; quarter < 4; quarter += 2) {
            const quarterInchPointsFromLeft = pointsFromLeft + (POINTS_PER_INCH * quarter / 4);
            const quarterInchScreenX = pageStartX + (quarterInchPointsFromLeft * zoomLevel);

            if (quarterInchScreenX >= 0 && quarterInchScreenX <= containerWidth) {
              ctx.beginPath();
              ctx.moveTo(quarterInchScreenX, 24);
              ctx.lineTo(quarterInchScreenX, 20);
              ctx.stroke();
            }
          }
        }
      }
    }
  }, [width, zoomLevel, panOffset, containerWidth]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 z-50 pointer-events-none"
      style={{ width: containerWidth, height: 24 }}
      aria-label="Horizontal ruler in inches"
    />
  );
}

