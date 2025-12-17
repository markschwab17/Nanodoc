/**
 * Shape Toolbar Component
 * 
 * Toolbar for shape tool settings
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Square, Circle, ArrowRight } from "lucide-react";
import { HexColorPicker } from "react-colorful";

export function ShapeToolbar() {
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

  return (
    <div className="flex items-center gap-2 p-2">
      <span className="text-sm font-medium">Shape:</span>
      
      {/* Shape type buttons */}
      <div className="flex items-center gap-1">
        <Button
          variant={currentShapeType === "rectangle" ? "default" : "outline"}
          size="sm"
          onClick={() => setCurrentShapeType("rectangle")}
          title="Rectangle"
        >
          <Square className="h-4 w-4" />
        </Button>
        <Button
          variant={currentShapeType === "circle" ? "default" : "outline"}
          size="sm"
          onClick={() => setCurrentShapeType("circle")}
          title="Circle"
        >
          <Circle className="h-4 w-4" />
        </Button>
        <Button
          variant={currentShapeType === "arrow" ? "default" : "outline"}
          size="sm"
          onClick={() => setCurrentShapeType("arrow")}
          title="Arrow"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Stroke settings */}
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              <div
                className="h-4 w-4 rounded border"
                style={{ backgroundColor: shapeStrokeColor }}
              />
              <span className="text-xs">Stroke</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3">
            <HexColorPicker color={shapeStrokeColor} onChange={setShapeStrokeColor} />
          </PopoverContent>
        </Popover>
        <Slider
          value={[shapeStrokeWidth]}
          onValueChange={([value]) => setShapeStrokeWidth(value)}
          min={1}
          max={10}
          step={1}
          className="w-16"
        />
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Fill settings */}
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              <div
                className="h-4 w-4 rounded border"
                style={{ 
                  backgroundColor: shapeFillColor,
                  opacity: shapeFillOpacity 
                }}
              />
              <span className="text-xs">Fill</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3">
            <HexColorPicker color={shapeFillColor} onChange={setShapeFillColor} />
            <div className="mt-2">
              <span className="text-xs">Opacity:</span>
              <Slider
                value={[shapeFillOpacity * 100]}
                onValueChange={([value]) => setShapeFillOpacity(value / 100)}
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
      {currentShapeType === "arrow" && (
        <>
          <div className="h-6 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Head:</span>
            <Slider
              value={[arrowHeadSize]}
              onValueChange={([value]) => setArrowHeadSize(value)}
              min={5}
              max={30}
              step={1}
              className="w-16"
            />
          </div>
        </>
      )}
    </div>
  );
}

