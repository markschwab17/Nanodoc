/**
 * Annotation Tools Component
 * 
 * Comprehensive toolbar for all PDF annotation tools
 */

import { useState } from "react";
import { useUIStore } from "@/shared/stores/uiStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { 
  Type, Highlighter, MessageSquare, PenTool, Square, Circle, 
  ArrowRight, FileText, Stamp as StampIcon, Palette 
} from "lucide-react";
import { HexColorPicker } from "react-colorful";
import { StampGallery } from "@/features/stamps/StampGallery";
import { StampCreator } from "@/features/stamps/StampCreator";

export function AnnotationTools() {
  const {
    activeTool,
    setActiveTool,
    drawingStyle,
    drawingColor,
    drawingStrokeWidth,
    setDrawingStyle,
    setDrawingColor,
    setDrawingStrokeWidth,
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
    currentFieldType,
    setCurrentFieldType,
  } = useUIStore();

  const [showStampGallery, setShowStampGallery] = useState(false);
  const [showStampCreator, setShowStampCreator] = useState(false);

  return (
    <div className="flex items-center gap-2 p-2 border-b bg-background overflow-x-auto">
      {/* Basic Tools */}
      <div className="flex items-center gap-1">
        <Button
          variant={activeTool === "text" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTool(activeTool === "text" ? "select" : "text")}
          title="Text Annotation"
        >
          <Type className="h-4 w-4 mr-1" />
          Text
        </Button>
        
        <Button
          variant={activeTool === "highlight" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTool(activeTool === "highlight" ? "select" : "highlight")}
          title="Highlight"
        >
          <Highlighter className="h-4 w-4 mr-1" />
          Highlight
        </Button>
        
        <Button
          variant={activeTool === "callout" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTool(activeTool === "callout" ? "select" : "callout")}
          title="Callout"
        >
          <MessageSquare className="h-4 w-4 mr-1" />
          Callout
        </Button>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Drawing Tool */}
      <div className="flex items-center gap-1">
        <Button
          variant={activeTool === "draw" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTool(activeTool === "draw" ? "select" : "draw")}
          title="Draw"
        >
          <PenTool className="h-4 w-4 mr-1" />
          Draw
        </Button>

        {activeTool === "draw" && (
          <>
            <select
              value={drawingStyle}
              onChange={(e) => setDrawingStyle(e.target.value as any)}
              className="h-8 px-2 text-sm border rounded"
              title="Drawing Style"
            >
              <option value="pen">Pen</option>
              <option value="pencil">Pencil</option>
              <option value="marker">Marker</option>
            </select>

            <div className="flex items-center gap-1">
              <span className="text-xs">Width:</span>
              <Slider
                value={[drawingStrokeWidth]}
                onValueChange={([value]) => setDrawingStrokeWidth(value)}
                min={1}
                max={20}
                step={1}
                className="w-20"
              />
              <span className="text-xs w-6">{drawingStrokeWidth}</span>
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8">
                  <div
                    className="h-4 w-4 rounded border"
                    style={{ backgroundColor: drawingColor }}
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-3">
                <HexColorPicker color={drawingColor} onChange={setDrawingColor} />
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Shape Tool */}
      <div className="flex items-center gap-1">
        <Button
          variant={activeTool === "shape" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTool(activeTool === "shape" ? "select" : "shape")}
          title="Shapes"
        >
          <Square className="h-4 w-4 mr-1" />
          Shapes
        </Button>

        {activeTool === "shape" && (
          <>
            <div className="flex items-center gap-1">
              <Button
                variant={currentShapeType === "rectangle" ? "default" : "outline"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setCurrentShapeType("rectangle")}
                title="Rectangle"
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                variant={currentShapeType === "circle" ? "default" : "outline"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setCurrentShapeType("circle")}
                title="Circle"
              >
                <Circle className="h-4 w-4" />
              </Button>
              <Button
                variant={currentShapeType === "arrow" ? "default" : "outline"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setCurrentShapeType("arrow")}
                title="Arrow"
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-xs">Stroke:</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon" className="h-8 w-8">
                    <div
                      className="h-4 w-4 rounded border"
                      style={{ backgroundColor: shapeStrokeColor }}
                    />
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

            <div className="flex items-center gap-1">
              <span className="text-xs">Fill:</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon" className="h-8 w-8">
                    <div
                      className="h-4 w-4 rounded border"
                      style={{ 
                        backgroundColor: shapeFillColor,
                        opacity: shapeFillOpacity 
                      }}
                    />
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
                      className="w-full"
                    />
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {currentShapeType === "arrow" && (
              <div className="flex items-center gap-1">
                <span className="text-xs">Head:</span>
                <Slider
                  value={[arrowHeadSize]}
                  onValueChange={([value]) => setArrowHeadSize(value)}
                  min={5}
                  max={30}
                  step={1}
                  className="w-16"
                />
              </div>
            )}
          </>
        )}
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Form Tool */}
      <div className="flex items-center gap-1">
        <Button
          variant={activeTool === "form" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveTool(activeTool === "form" ? "select" : "form")}
          title="Form Fields"
        >
          <FileText className="h-4 w-4 mr-1" />
          Form
        </Button>

        {activeTool === "form" && (
          <select
            value={currentFieldType}
            onChange={(e) => setCurrentFieldType(e.target.value as any)}
            className="h-8 px-2 text-sm border rounded"
            title="Field Type"
          >
            <option value="text">Text Field</option>
            <option value="checkbox">Checkbox</option>
            <option value="radio">Radio Button</option>
            <option value="dropdown">Dropdown</option>
            <option value="date">Date Picker</option>
          </select>
        )}
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Stamp Tool */}
      <div className="flex items-center gap-1">
        <Button
          variant={activeTool === "stamp" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            if (activeTool === "stamp") {
              setActiveTool("select");
            } else {
              setShowStampGallery(true);
            }
          }}
          title="Stamps"
        >
          <StampIcon className="h-4 w-4 mr-1" />
          Stamp
        </Button>

        <Popover open={showStampGallery} onOpenChange={setShowStampGallery}>
          <PopoverTrigger asChild>
            <span />
          </PopoverTrigger>
          <PopoverContent className="w-auto p-4" align="start">
            <StampGallery
              onCreateNew={() => {
                setShowStampGallery(false);
                setShowStampCreator(true);
              }}
              onClose={() => setShowStampGallery(false)}
            />
          </PopoverContent>
        </Popover>

        <StampCreator
          open={showStampCreator}
          onClose={() => setShowStampCreator(false)}
        />
      </div>
    </div>
  );
}
