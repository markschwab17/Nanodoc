/**
 * Annotation Tools Component
 * 
 * Toolbar for text annotation tools with font selection, size, styling, and color picker.
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
import { Type, Bold, Italic, Underline, Palette, Highlighter, MessageSquare } from "lucide-react";
import { HexColorPicker } from "react-colorful";

export function AnnotationTools() {
  const { activeTool, setActiveTool } = useUIStore();
  const [fontSize, setFontSize] = useState(12);
  const [fontFamily, setFontFamily] = useState("Arial");
  const [color, setColor] = useState("#000000");
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [underline, setUnderline] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const isTextToolActive = activeTool === "text";
  const isHighlightToolActive = activeTool === "highlight";
  const isCalloutToolActive = activeTool === "callout";

  const handleTextToolToggle = () => {
    setActiveTool(isTextToolActive ? "select" : "text");
  };

  const handleHighlightToolToggle = () => {
    setActiveTool(isHighlightToolActive ? "select" : "highlight");
  };

  const handleCalloutToolToggle = () => {
    setActiveTool(isCalloutToolActive ? "select" : "callout");
  };

  return (
    <div className="flex items-center gap-2 p-2 border-b bg-background">
      <Button
        variant={isTextToolActive ? "default" : "outline"}
        size="sm"
        onClick={handleTextToolToggle}
        title="Text Annotation"
      >
        <Type className="h-4 w-4 mr-2" />
        Text
      </Button>
      
      <Button
        variant={isHighlightToolActive ? "default" : "outline"}
        size="sm"
        onClick={handleHighlightToolToggle}
        title="Highlight Text"
      >
        <Highlighter className="h-4 w-4 mr-2" />
        Highlight
      </Button>
      
      <Button
        variant={isCalloutToolActive ? "default" : "outline"}
        size="sm"
        onClick={handleCalloutToolToggle}
        title="Callout Note"
      >
        <MessageSquare className="h-4 w-4 mr-2" />
        Callout
      </Button>

      {isTextToolActive && (
        <>
          <div className="h-6 w-px bg-border" />

          {/* Font Family */}
          <select
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            className="h-8 px-2 text-sm border rounded bg-background"
          >
            <option value="Arial">Arial</option>
            <option value="Helvetica">Helvetica</option>
            <option value="Times New Roman">Times New Roman</option>
            <option value="Courier New">Courier New</option>
            <option value="Verdana">Verdana</option>
          </select>

          {/* Font Size */}
          <div className="flex items-center gap-2 min-w-[120px]">
            <span className="text-xs text-muted-foreground">Size:</span>
            <Slider
              value={[fontSize]}
              onValueChange={([value]) => setFontSize(value)}
              min={8}
              max={72}
              step={1}
              className="flex-1"
            />
            <span className="text-xs text-muted-foreground w-8">{fontSize}</span>
          </div>

          {/* Text Style Buttons */}
          <Button
            variant={bold ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setBold(!bold)}
          >
            <Bold className="h-4 w-4" />
          </Button>
          <Button
            variant={italic ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setItalic(!italic)}
          >
            <Italic className="h-4 w-4" />
          </Button>
          <Button
            variant={underline ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setUnderline(!underline)}
          >
            <Underline className="h-4 w-4" />
          </Button>

          {/* Color Picker */}
          <Popover open={showColorPicker} onOpenChange={setShowColorPicker}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8">
                <Palette className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-3">
              <HexColorPicker color={color} onChange={setColor} />
              <div
                className="mt-2 h-8 w-full rounded border"
                style={{ backgroundColor: color }}
              />
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}

