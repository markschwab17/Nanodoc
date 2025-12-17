/**
 * Draw Toolbar Component
 * 
 * Toolbar for draw tool settings
 */

import { useUIStore } from "@/shared/stores/uiStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PenTool, Paintbrush, Pencil } from "lucide-react";
import { HexColorPicker } from "react-colorful";

export function DrawToolbar() {
  const {
    drawingStyle,
    drawingColor,
    drawingStrokeWidth,
    setDrawingStyle,
    setDrawingColor,
    setDrawingStrokeWidth,
  } = useUIStore();

  return (
    <div className="flex items-center gap-2 p-2">
      <span className="text-sm font-medium">Draw:</span>
      
      {/* Style buttons */}
      <div className="flex items-center gap-1">
        <Button
          variant={drawingStyle === "pen" ? "default" : "outline"}
          size="sm"
          onClick={() => setDrawingStyle("pen")}
          title="Pen"
        >
          <PenTool className="h-4 w-4" />
        </Button>
        <Button
          variant={drawingStyle === "pencil" ? "default" : "outline"}
          size="sm"
          onClick={() => setDrawingStyle("pencil")}
          title="Pencil"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant={drawingStyle === "marker" ? "default" : "outline"}
          size="sm"
          onClick={() => setDrawingStyle("marker")}
          title="Marker"
        >
          <Paintbrush className="h-4 w-4" />
        </Button>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Stroke width */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Width:</span>
        <Slider
          value={[drawingStrokeWidth]}
          onValueChange={([value]) => setDrawingStrokeWidth(value)}
          min={1}
          max={20}
          step={1}
          className="w-24"
        />
        <span className="text-xs w-6">{drawingStrokeWidth}</span>
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
          <HexColorPicker color={drawingColor} onChange={setDrawingColor} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

