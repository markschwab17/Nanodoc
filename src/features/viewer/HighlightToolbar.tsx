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
import { Input } from "@/components/ui/input";
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

  const handleOpacityInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value) && value >= 0 && value <= 100) {
      const opacity = Math.max(0.1, Math.min(1.0, value / 100));
      setLocalOpacity(opacity);
      setHighlightOpacity(opacity);
    }
  };

  const handleOpacityInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (isNaN(value) || value < 10) {
      const opacity = 0.1;
      setLocalOpacity(opacity);
      setHighlightOpacity(opacity);
    } else if (value > 100) {
      const opacity = 1.0;
      setLocalOpacity(opacity);
      setHighlightOpacity(opacity);
    }
  };

  const handleColorChange = (newColor: string) => {
    setHighlightColor(newColor);
  };

  return (
    <div className="flex items-center gap-1 px-1.5 py-1" data-highlight-toolbar="true">
      <Highlighter className="h-3 w-3 text-muted-foreground" />

      <div className="h-4 w-px bg-border" />

      {/* Color Picker */}
      <Popover open={showColorPicker} onOpenChange={setShowColorPicker}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="icon" className="h-6 w-6">
            <div
              className="h-3.5 w-3.5 rounded border border-border"
              style={{ backgroundColor: highlightColor }}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-3">
          <HexColorPicker color={highlightColor} onChange={handleColorChange} />
          <div
            className="mt-2 h-6 w-full rounded border"
            style={{ backgroundColor: highlightColor }}
          />
        </PopoverContent>
      </Popover>

      <div className="h-4 w-px bg-border" />

      {/* Stroke Width Slider */}
      <div className="flex items-center gap-1 min-w-[100px]">
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">Width</span>
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

      <div className="h-4 w-px bg-border" />

      {/* Opacity Slider */}
      <div className="flex items-center gap-1 min-w-[160px]">
        <span className="text-[10px] text-muted-foreground whitespace-nowrap">Opacity</span>
        <Slider
          value={[localOpacity]}
          onValueChange={handleOpacityChange}
          min={0.1}
          max={1.0}
          step={0.05}
          className="w-32"
        />
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={10}
            max={100}
            step={5}
            value={Math.round(localOpacity * 100)}
            onChange={handleOpacityInputChange}
            onBlur={handleOpacityInputBlur}
            className="h-5 w-10 text-[10px] text-center px-1"
          />
          <span className="text-xs text-muted-foreground font-medium">%</span>
        </div>
      </div>
    </div>
  );
}
















