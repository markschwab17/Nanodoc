/**
 * Draw Toolbar Component
 * 
 * Toolbar for draw tool settings
 */

import { useEffect } from "react";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Trash2 } from "lucide-react";
import { HexColorPicker } from "react-colorful";
import { wrapAnnotationUpdate } from "@/shared/stores/undoHelpers";
import type { Annotation } from "@/core/pdf/PDFEditor";

interface DrawToolbarProps {
  selectedAnnotation?: Annotation;
}

export function DrawToolbar({ selectedAnnotation }: DrawToolbarProps) {
  const {
    drawingColor,
    drawingStrokeWidth,
    drawingOpacity,
    setDrawingColor,
    setDrawingStrokeWidth,
    setDrawingOpacity,
  } = useUIStore();
  
  const { getCurrentDocument, removeAnnotation } = usePDFStore();
  
  // Sync toolbar values with selected annotation
  useEffect(() => {
    if (selectedAnnotation && selectedAnnotation.type === "draw") {
      if (selectedAnnotation.color) {
        setDrawingColor(selectedAnnotation.color);
      }
      if (selectedAnnotation.strokeWidth !== undefined) {
        setDrawingStrokeWidth(selectedAnnotation.strokeWidth);
      }
      if (selectedAnnotation.strokeOpacity !== undefined) {
        setDrawingOpacity(selectedAnnotation.strokeOpacity);
      }
    }
  }, [selectedAnnotation?.id, selectedAnnotation?.color, selectedAnnotation?.strokeWidth, selectedAnnotation?.strokeOpacity, setDrawingColor, setDrawingStrokeWidth, setDrawingOpacity]);
  
  // Update selected annotation when toolbar values change
  const updateSelectedDrawing = (updates: Partial<Annotation>) => {
    if (!selectedAnnotation) return;
    const currentDocument = getCurrentDocument();
    if (!currentDocument) return;
    
    wrapAnnotationUpdate(
      currentDocument.getId(),
      selectedAnnotation.id,
      updates
    );
  };
  
  const handleDelete = async () => {
    if (!selectedAnnotation) return;
    const currentDocument = getCurrentDocument();
    if (!currentDocument) return;
    
    try {
      // Import mupdf and create editor instance
      const mupdfModule = await import("mupdf");
      const { PDFEditor } = await import("@/core/pdf/PDFEditor");
      const editor = new PDFEditor(mupdfModule.default);
      
      // Delete from PDF
      await editor.deleteAnnotation(currentDocument, selectedAnnotation);
      
      // Remove from store
      removeAnnotation(currentDocument.getId(), selectedAnnotation.id);
      
      // Dispatch event to clear editing annotation
      window.dispatchEvent(new CustomEvent("clearEditingAnnotation"));
      
      // Record undo
      const { useUndoRedoStore } = await import("@/shared/stores/undoRedoStore");
      useUndoRedoStore.getState().pushAction({
        type: "removeAnnotation",
        documentId: currentDocument.getId(),
        beforeState: {},
        afterState: {},
        actionData: {
          annotationId: selectedAnnotation.id,
          annotation: selectedAnnotation,
        },
        undo: async () => {
          // Undo logic would go here
        },
        redo: async () => {
          // Redo logic would go here
        },
      });
    } catch (error) {
      console.error("Error deleting annotation:", error);
    }
  };

  return (
    <div className="flex items-center gap-2 p-2">
      <span className="text-sm font-medium">Draw:</span>

      {/* Stroke width */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Width:</span>
        <Slider
          value={[drawingStrokeWidth]}
          onValueChange={([value]) => {
            setDrawingStrokeWidth(value);
            if (selectedAnnotation) {
              updateSelectedDrawing({ strokeWidth: value });
            }
          }}
          min={1}
          max={20}
          step={1}
          className="w-24"
        />
        <span className="text-xs w-6">{drawingStrokeWidth}</span>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Opacity */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Opacity:</span>
        <Slider
          value={[drawingOpacity * 100]}
          onValueChange={([value]) => {
            const opacity = value / 100;
            setDrawingOpacity(opacity);
            if (selectedAnnotation) {
              updateSelectedDrawing({ strokeOpacity: opacity });
            }
          }}
          min={0}
          max={100}
          step={1}
          className="w-24"
        />
        <span className="text-xs w-8">{Math.round(drawingOpacity * 100)}%</span>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Color picker */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <div
              className="h-4 w-4 rounded border"
              style={{ backgroundColor: drawingColor }}
            />
            Color
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <HexColorPicker 
            color={drawingColor} 
            onChange={(color) => {
              setDrawingColor(color);
              if (selectedAnnotation) {
                updateSelectedDrawing({ color });
              }
            }} 
          />
        </PopoverContent>
      </Popover>
      
      {/* Delete button - only show when editing a selected drawing */}
      {selectedAnnotation && (
        <>
          <div className="h-6 w-px bg-border" />
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            title="Delete"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  );
}

