/**
 * Shape Toolbar Component
 * 
 * Toolbar for shape tool settings
 */

import { useEffect } from "react";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Square, Circle, ArrowRight, Trash2 } from "lucide-react";
import { HexColorPicker } from "react-colorful";
import { wrapAnnotationUpdate } from "@/shared/stores/undoHelpers";
import type { Annotation } from "@/core/pdf/PDFEditor";

interface ShapeToolbarProps {
  selectedAnnotation?: Annotation;
}

export function ShapeToolbar({ selectedAnnotation }: ShapeToolbarProps) {
  const {
    currentShapeType,
    shapeStrokeColor,
    shapeStrokeWidth,
    shapeFillColor,
    shapeFillOpacity,
    arrowHeadSize,
    setCurrentShapeType,
    setShapeStrokeColor,
    setShapeStrokeWidth,
    setShapeFillColor,
    setShapeFillOpacity,
    setArrowHeadSize,
  } = useUIStore();
  
  const { getCurrentDocument, removeAnnotation } = usePDFStore();
  
  // Sync toolbar values with selected annotation
  useEffect(() => {
    if (selectedAnnotation && selectedAnnotation.type === "shape") {
      if (selectedAnnotation.shapeType) {
        setCurrentShapeType(selectedAnnotation.shapeType);
      }
      if (selectedAnnotation.strokeColor) {
        setShapeStrokeColor(selectedAnnotation.strokeColor);
      }
      if (selectedAnnotation.strokeWidth !== undefined) {
        setShapeStrokeWidth(selectedAnnotation.strokeWidth);
      }
      if (selectedAnnotation.fillColor) {
        setShapeFillColor(selectedAnnotation.fillColor);
      }
      if (selectedAnnotation.fillOpacity !== undefined) {
        setShapeFillOpacity(selectedAnnotation.fillOpacity);
      }
      if (selectedAnnotation.arrowHeadSize !== undefined) {
        setArrowHeadSize(selectedAnnotation.arrowHeadSize);
      }
    }
  }, [selectedAnnotation?.id, selectedAnnotation?.shapeType, selectedAnnotation?.strokeColor, selectedAnnotation?.strokeWidth, selectedAnnotation?.fillColor, selectedAnnotation?.fillOpacity, selectedAnnotation?.arrowHeadSize, setCurrentShapeType, setShapeStrokeColor, setShapeStrokeWidth, setShapeFillColor, setShapeFillOpacity, setArrowHeadSize]);
  
  // Update selected annotation when toolbar values change
  const updateSelectedShape = (updates: Partial<Annotation>) => {
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
    <div className="flex items-center gap-1 px-1.5 py-1">
      <span className="text-xs font-medium text-muted-foreground">Shape</span>
      
      {/* Shape type buttons - only show when not editing a selected shape */}
      {!selectedAnnotation && (
        <div className="flex items-center gap-1">
          <Button
            variant={currentShapeType === "rectangle" ? "default" : "outline"}
            size="icon"
            onClick={() => setCurrentShapeType("rectangle")}
            title="Rectangle"
            className="h-6 w-6"
          >
            <Square className="h-3 w-3" />
          </Button>
          <Button
            variant={currentShapeType === "circle" ? "default" : "outline"}
            size="icon"
            onClick={() => setCurrentShapeType("circle")}
            title="Circle"
            className="h-6 w-6"
          >
            <Circle className="h-3 w-3" />
          </Button>
          <Button
            variant={currentShapeType === "arrow" ? "default" : "outline"}
            size="icon"
            onClick={() => setCurrentShapeType("arrow")}
            title="Arrow"
            className="h-6 w-6"
          >
            <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
      )}
      
      {/* Show current shape type when editing */}
      {selectedAnnotation && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {selectedAnnotation.shapeType === "rectangle" && "Rectangle"}
            {selectedAnnotation.shapeType === "circle" && "Circle"}
            {selectedAnnotation.shapeType === "arrow" && "Arrow"}
          </span>
        </div>
      )}
      
      {!selectedAnnotation && <div className="h-4 w-px bg-border" />}

      <div className="h-4 w-px bg-border" />

      {/* Stroke settings */}
      <div className="flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs">
              <div
                className="h-3 w-3 rounded border"
                style={{ backgroundColor: shapeStrokeColor }}
              />
              <span className="text-xs">Stroke</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3">
            <HexColorPicker 
              color={shapeStrokeColor} 
              onChange={(color) => {
                setShapeStrokeColor(color);
                if (selectedAnnotation) {
                  updateSelectedShape({ strokeColor: color });
                }
              }} 
            />
          </PopoverContent>
        </Popover>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Thickness:</span>
          <Slider
            value={[shapeStrokeWidth]}
            onValueChange={([value]) => {
              setShapeStrokeWidth(value);
              if (selectedAnnotation) {
                updateSelectedShape({ strokeWidth: value });
              }
            }}
            min={1}
            max={10}
            step={1}
            className="w-16"
          />
        </div>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Fill settings */}
      <div className="flex items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs">
              <div
                className="h-3 w-3 rounded border"
                style={{
                  backgroundColor: shapeFillColor,
                  opacity: shapeFillOpacity
                }}
              />
              <span className="text-xs">Fill</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3">
            <HexColorPicker 
              color={shapeFillColor} 
              onChange={(color) => {
                setShapeFillColor(color);
                if (selectedAnnotation) {
                  updateSelectedShape({ fillColor: color });
                }
              }} 
            />
            <div className="mt-2">
              <span className="text-xs">Opacity:</span>
              <Slider
                value={[shapeFillOpacity * 100]}
                onValueChange={([value]) => {
                  const opacity = value / 100;
                  setShapeFillOpacity(opacity);
                  if (selectedAnnotation) {
                    updateSelectedShape({ fillOpacity: opacity });
                  }
                }}
                min={0}
                max={100}
                step={1}
                className="w-full mt-1"
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Arrow head size (only for arrows) */}
      {(currentShapeType === "arrow" || selectedAnnotation?.shapeType === "arrow") && (
        <>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Head:</span>
            <Slider
              value={[arrowHeadSize]}
              onValueChange={([value]) => {
                setArrowHeadSize(value);
                if (selectedAnnotation) {
                  updateSelectedShape({ arrowHeadSize: value });
                }
              }}
              min={5}
              max={30}
              step={1}
              className="w-16"
            />
          </div>
        </>
      )}
      
      {/* Delete button - only show when editing a selected shape */}
      {selectedAnnotation && (
        <>
          <div className="h-4 w-px bg-border" />
          <Button
            variant="outline"
            size="icon"
            onClick={handleDelete}
            title="Delete"
            className="h-6 w-6 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

