/**
 * Alignment Guides Component
 *
 * Renders visual alignment guide lines when an annotation is being dragged
 * or resized. Compares the active annotation's edges and center against
 * other annotations and page boundaries. Also displays a measurement label
 * showing the annotation's width x height during resize operations.
 */

import { useMemo } from "react";

interface AlignmentGuidesProps {
  activeAnnotation: { x: number; y: number; width: number; height: number } | null;
  otherAnnotations: Array<{ x: number; y: number; width?: number; height?: number }>;
  pageWidth: number;
  pageHeight: number;
  threshold?: number;
  showMeasurements?: boolean;
}

interface GuideLine {
  orientation: "horizontal" | "vertical";
  position: number;
}

/**
 * Extracts the key alignment positions (left, center, right / top, center, bottom)
 * from a rectangle defined by { x, y, width, height }.
 */
function getEdges(rect: { x: number; y: number; width: number; height: number }) {
  return {
    left: rect.x,
    centerX: rect.x + rect.width / 2,
    right: rect.x + rect.width,
    top: rect.y,
    centerY: rect.y + rect.height / 2,
    bottom: rect.y + rect.height,
  };
}

export function AlignmentGuides({
  activeAnnotation,
  otherAnnotations,
  pageWidth,
  pageHeight,
  threshold = 5,
  showMeasurements = false,
}: AlignmentGuidesProps) {
  const guides = useMemo<GuideLine[]>(() => {
    if (!activeAnnotation) return [];

    const active = getEdges(activeAnnotation);
    const matched: GuideLine[] = [];
    const seenH = new Set<number>();
    const seenV = new Set<number>();

    const addH = (pos: number) => {
      const rounded = Math.round(pos * 100) / 100;
      if (!seenH.has(rounded)) {
        seenH.add(rounded);
        matched.push({ orientation: "horizontal", position: rounded });
      }
    };

    const addV = (pos: number) => {
      const rounded = Math.round(pos * 100) / 100;
      if (!seenV.has(rounded)) {
        seenV.add(rounded);
        matched.push({ orientation: "vertical", position: rounded });
      }
    };

    // Helper: check if two values are within the snap threshold
    const near = (a: number, b: number) => Math.abs(a - b) <= threshold;

    // --- Compare against page edges and center ---
    const pageXPositions = [0, pageWidth / 2, pageWidth];
    const pageYPositions = [0, pageHeight / 2, pageHeight];

    const activeXPositions = [active.left, active.centerX, active.right];
    const activeYPositions = [active.top, active.centerY, active.bottom];

    for (const px of pageXPositions) {
      for (const ax of activeXPositions) {
        if (near(ax, px)) {
          addV(px);
        }
      }
    }

    for (const py of pageYPositions) {
      for (const ay of activeYPositions) {
        if (near(ay, py)) {
          addH(py);
        }
      }
    }

    // --- Compare against other annotations ---
    for (const other of otherAnnotations) {
      const ow = other.width ?? 0;
      const oh = other.height ?? 0;

      const otherXPositions = [other.x, other.x + ow / 2, other.x + ow];
      const otherYPositions = [other.y, other.y + oh / 2, other.y + oh];

      for (const ox of otherXPositions) {
        for (const ax of activeXPositions) {
          if (near(ax, ox)) {
            addV(ox);
          }
        }
      }

      for (const oy of otherYPositions) {
        for (const ay of activeYPositions) {
          if (near(ay, oy)) {
            addH(oy);
          }
        }
      }
    }

    return matched;
  }, [activeAnnotation, otherAnnotations, pageWidth, pageHeight, threshold]);

  if (!activeAnnotation && !showMeasurements) return null;
  if (!activeAnnotation) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 999 }}
      aria-hidden="true"
    >
      {/* Guide lines */}
      {guides.map((guide, i) =>
        guide.orientation === "vertical" ? (
          <div
            key={`v-${i}`}
            className="absolute top-0"
            style={{
              left: `${guide.position}px`,
              width: "1px",
              height: `${pageHeight}px`,
              borderLeft: "1px dashed rgba(59, 130, 246, 0.6)",
            }}
          />
        ) : (
          <div
            key={`h-${i}`}
            className="absolute left-0"
            style={{
              top: `${guide.position}px`,
              height: "1px",
              width: `${pageWidth}px`,
              borderTop: "1px dashed rgba(59, 130, 246, 0.6)",
            }}
          />
        )
      )}

      {/* Measurement label */}
      {showMeasurements && activeAnnotation && (
        <div
          className="absolute flex items-center justify-center"
          style={{
            left: `${activeAnnotation.x + activeAnnotation.width / 2}px`,
            top: `${activeAnnotation.y + activeAnnotation.height + 8}px`,
            transform: "translateX(-50%)",
          }}
        >
          <span
            className="rounded bg-gray-900/80 px-1.5 py-0.5 text-[10px] font-mono leading-tight text-white whitespace-nowrap"
          >
            {Math.round(activeAnnotation.width)} &times; {Math.round(activeAnnotation.height)}
          </span>
        </div>
      )}
    </div>
  );
}
