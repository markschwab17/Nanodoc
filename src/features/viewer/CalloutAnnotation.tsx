/**
 * Callout Annotation Component
 * 
 * Collapsible callout with hover-to-expand, double-click to edit
 */

import { useState } from "react";
import { X, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/core/pdf/PDFEditor";

interface CalloutAnnotationProps {
  annotation: Annotation;
  pdfToContainer: (pdfX: number, pdfY: number) => { x: number; y: number };
  onEdit: () => void;
  onDelete: () => void;
  isSelected: boolean;
  zoomLevel: number;
}

export function CalloutAnnotation({
  annotation,
  pdfToContainer,
  onEdit,
  onDelete,
  isSelected,
  zoomLevel: _zoomLevel,
}: CalloutAnnotationProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const arrowPoint = annotation.arrowPoint || { x: annotation.x, y: annotation.y };
  const boxPos = annotation.boxPosition || { x: annotation.x + 50, y: annotation.y };
  const boxWidth = annotation.width || 150;
  const boxHeight = annotation.height || 80;

  const arrowContainer = pdfToContainer(arrowPoint.x, arrowPoint.y);
  const boxContainer = pdfToContainer(boxPos.x, boxPos.y);

  const showExpanded = isExpanded || isHovered || isSelected;

  return (
    <div
      className="absolute"
      style={{ zIndex: 30 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Arrow line */}
      <svg
        className="absolute pointer-events-none"
        style={{
          left: `${Math.min(arrowContainer.x, boxContainer.x)}px`,
          top: `${Math.min(arrowContainer.y, boxContainer.y)}px`,
          width: `${Math.abs(boxContainer.x - arrowContainer.x)}px`,
          height: `${Math.abs(boxContainer.y - arrowContainer.y)}px`,
        }}
      >
        <line
          x1={arrowContainer.x < boxContainer.x ? 0 : Math.abs(boxContainer.x - arrowContainer.x)}
          y1={arrowContainer.y < boxContainer.y ? 0 : Math.abs(boxContainer.y - arrowContainer.y)}
          x2={arrowContainer.x < boxContainer.x ? Math.abs(boxContainer.x - arrowContainer.x) : 0}
          y2={arrowContainer.y < boxContainer.y ? Math.abs(boxContainer.y - arrowContainer.y) : 0}
          stroke={annotation.color || "#000000"}
          strokeWidth={2}
        />
      </svg>

      {/* Collapsed note indicator */}
      {!showExpanded && (
        <div
          className="absolute w-6 h-6 bg-yellow-400 border-2 border-yellow-600 rounded-full flex items-center justify-center cursor-pointer shadow-md"
          style={{
            left: `${boxContainer.x}px`,
            top: `${boxContainer.y}px`,
          }}
          onClick={() => setIsExpanded(true)}
          title="Click to expand note"
        >
          <span className="text-xs font-bold">💬</span>
        </div>
      )}

      {/* Expanded callout box */}
      {showExpanded && (
        <div
          className={cn(
            "absolute bg-yellow-100 border-2 rounded shadow-lg",
            "transition-all duration-200",
            isSelected && "ring-2 ring-blue-500"
          )}
          style={{
            left: `${boxContainer.x}px`,
            top: `${boxContainer.y}px`,
            width: `${boxWidth}px`,
            minHeight: `${boxHeight}px`,
            borderColor: annotation.color || "#000000",
            fontSize: "12px",
            padding: "8px",
          }}
          onDoubleClick={onEdit}
        >
          {/* Control buttons */}
          <div className="absolute -top-8 right-0 flex gap-1">
            {isExpanded && !isSelected && (
              <button
                onClick={() => setIsExpanded(false)}
                className="p-1 bg-gray-700 text-white rounded hover:bg-gray-800 transition-colors"
                title="Collapse"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            {isSelected && (
              <button
                onClick={onDelete}
                className="p-1 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Content */}
          <div className="text-sm">
            {annotation.content || "Note"}
          </div>

          {/* Double-click hint */}
          {!isSelected && (
            <div className="text-xs text-gray-500 mt-2 italic">
              Double-click to edit
            </div>
          )}
        </div>
      )}
    </div>
  );
}

