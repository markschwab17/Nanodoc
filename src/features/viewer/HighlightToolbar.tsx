/**
 * Highlight Toolbar Component
 * 
 * Toolbar for highlight tool settings: color, stroke width, and opacity.
 * Appears at the top of the screen when highlight tool is active.
 */

import { useState, useEffect } from "react";
import { useUIStore } from "@/shared/stores/uiStore";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Highlighter } from "lucide-react";
import { HexColorPicker } from "react-colorful";

export function HighlightToolbar() {
  const { 
    highlightColor, 
    highlightStrokeWidth, 
    highlightOpacity,
    setHighlightColor,
    setHighlightStrokeWidth,
    setHighlightOpacity 
  } = useUIStore();
  
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [localStrokeWidth, setLocalStrokeWidth] = useState(highlightStrokeWidth);
  const [localOpacity, setLocalOpacity] = useState(highlightOpacity);

  // Sync local state with store
  useEffect(() => {
    setLocalStrokeWidth(highlightStrokeWidth);
  }, [highlightStrokeWidth]);

  useEffect(() => {
    setLocalOpacity(highlightOpacity);
  }, [highlightOpacity]);

  const handleStrokeWidthChange = (value: number[]) => {
    const newWidth = value[0];
    setLocalStrokeWidth(newWidth);
    setHighlightStrokeWidth(newWidth);
  };

  const handleOpacityChange = (value: number[]) => {
    const newOpacity = value[0];
    setLocalOpacity(newOpacity);
    setHighlightOpacity(newOpacity);
  };

  const handleColorChange = (newColor: string) => {
    setHighlightColor(newColor);
  };

  return (
    <div className="flex items-center gap-2 p-2" data-highlight-toolbar="true">
      <Highlighter className="h-4 w-4 text-muted-foreground" />
      
      <div className="h-6 w-px bg-border" />

      {/* Color Picker */}
      <Popover open={showColorPicker} onOpenChange={setShowColorPicker}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <div
              className="h-4 w-4 rounded border border-border"
              style={{ backgroundColor: highlightColor }}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <HexColorPicker color={highlightColor} onChange={handleColorChange} />
          <div
            className="mt-2 h-8 w-full rounded border"
            style={{ backgroundColor: highlightColor }}
          />
        </PopoverContent>
      </Popover>

      <div className="h-6 w-px bg-border" />

      {/* Stroke Width Slider */}
      <div className="flex items-center gap-2 min-w-[120px]">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Width</span>
        <Slider
          value={[localStrokeWidth]}
          onValueChange={handleStrokeWidthChange}
          min={5}
          max={50}
          step={1}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground w-8">{localStrokeWidth}</span>
      </div>

      <div className="h-6 w-px bg-border" />

      {/* Opacity Slider */}
      <div className="flex items-center gap-2 min-w-[120px]">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Opacity</span>
        <Slider
          value={[localOpacity]}
          onValueChange={handleOpacityChange}
          min={0.1}
          max={1.0}
          step={0.1}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground w-12">
          {Math.round(localOpacity * 100)}%
        </span>
      </div>
    </div>
  );
}
















