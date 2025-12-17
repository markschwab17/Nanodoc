/**
 * Stamp Editor Component
 * 
 * Modal dialog for editing text-based stamps
 */

import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import type { StampData } from "@/core/pdf/PDFEditor";
import { HexColorPicker } from "react-colorful";
import { Square, Circle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface StampEditorProps {
  open: boolean;
  onClose: () => void;
  stampData: StampData | null;
  onSave: (updatedStampData: StampData) => void;
}

export function StampEditor({ open, onClose, stampData, onSave }: StampEditorProps) {
  const [text, setText] = useState("");
  const [stampName, setStampName] = useState("");
  const [font, setFont] = useState("Arial");
  const [textColor, setTextColor] = useState("#000000");
  const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const [backgroundColor, setBackgroundColor] = useState("#FFFFFF");
  const [backgroundOpacity, setBackgroundOpacity] = useState(100);
  const [borderEnabled, setBorderEnabled] = useState(false);
  const [borderStyle, setBorderStyle] = useState<"rounded" | "square">("rounded");
  const [borderThickness, setBorderThickness] = useState(2);
  const [borderColor, setBorderColor] = useState("#000000");
  const [borderOffset, setBorderOffset] = useState(8);

  const previewRef = useRef<HTMLDivElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const currentScaleRef = useRef(1);

  // Initialize form from stampData
  useEffect(() => {
    if (stampData && stampData.type === "text") {
      setStampName(stampData.name || "");
      setText(stampData.text || "");
      setFont(stampData.font || "Arial");
      setTextColor(stampData.textColor || "#000000");
      setBackgroundEnabled(stampData.backgroundEnabled || false);
      setBackgroundColor(stampData.backgroundColor || "#FFFFFF");
      setBackgroundOpacity(stampData.backgroundOpacity !== undefined ? stampData.backgroundOpacity : 100);
      setBorderEnabled(stampData.borderEnabled || false);
      setBorderStyle(stampData.borderStyle || "rounded");
      setBorderThickness(stampData.borderThickness || 2);
      setBorderColor(stampData.borderColor || "#000000");
      setBorderOffset(stampData.borderOffset || 8);
    }
  }, [stampData, open]);

  // Debounce function
  const debounce = (func: Function, wait: number) => {
    let timeout: NodeJS.Timeout;
    return function executedFunction(...args: any[]) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  };

  // Scale preview to fit container
  useEffect(() => {
    if (open && previewRef.current && previewContainerRef.current) {
      const container = previewContainerRef.current;
      const content = previewRef.current;

      const updateScale = () => {
        const containerRect = container.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();

        if (contentRect.width === 0 || contentRect.height === 0) return;

        const availableWidth = containerRect.width - 24;
        const availableHeight = containerRect.height - 24;

        const scaleX = availableWidth / contentRect.width;
        const scaleY = availableHeight / contentRect.height;
        const newScale = Math.min(scaleX, scaleY, 1);

        if (Math.abs(currentScaleRef.current - newScale) > 0.01) {
          content.style.transform = `scale(${newScale})`;
          currentScaleRef.current = newScale;
        }
      };

      const debouncedUpdateScale = debounce(updateScale, 50);

      window.addEventListener('resize', debouncedUpdateScale);
      requestAnimationFrame(debouncedUpdateScale);

      return () => {
        window.removeEventListener('resize', debouncedUpdateScale);
      };
    }
  }, [open, text, textColor, font, backgroundEnabled, backgroundColor, backgroundOpacity, borderEnabled, borderStyle, borderThickness, borderColor, borderOffset]);

  const generateThumbnail = (): string => {
    const scale = 6;
    
    if (!text) return "";

    const drawRoundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    };
    
    const tempCanvas = document.createElement("canvas");
    const tempCtx = tempCanvas.getContext("2d");
    if (!tempCtx) return "";

    tempCtx.font = `${56 * scale}px ${font}`;
    tempCtx.textAlign = "center";
    tempCtx.textBaseline = "middle";
    
    const lines = text.split('\n');
    const fontSize = 56 * scale;
    const lineHeight = fontSize * 1.2;
    
    let maxTextWidth = 0;
    lines.forEach((line) => {
      const metrics = tempCtx.measureText(line);
      if (metrics.width > maxTextWidth) {
        maxTextWidth = metrics.width;
      }
    });
    
    const textBlockHeight = lines.length * lineHeight;
    const offset = borderOffset * scale;
    const borderThicknessScaled = borderThickness * scale;
    const contentPadding = offset;
    
    const contentWidth = maxTextWidth + contentPadding * 2;
    const contentHeight = textBlockHeight + contentPadding * 2;
    
    const totalWidth = contentWidth + (borderEnabled ? borderThicknessScaled : 0);
    const totalHeight = contentHeight + (borderEnabled ? borderThicknessScaled : 0);
    
    const canvas = document.createElement("canvas");
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const contentX = borderEnabled ? borderThicknessScaled / 2 : 0;
    const contentY = borderEnabled ? borderThicknessScaled / 2 : 0;
    
    const textBlockTop = contentY + contentPadding;
    const firstLineCenterY = textBlockTop + lineHeight / 2;
    const startY = firstLineCenterY;
    const textCenterX = contentX + contentWidth / 2;
        
    ctx.font = `${fontSize}px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    if (backgroundEnabled) {
      const r = parseInt(backgroundColor.slice(1, 3), 16);
      const g = parseInt(backgroundColor.slice(3, 5), 16);
      const b = parseInt(backgroundColor.slice(5, 7), 16);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${backgroundOpacity / 100})`;
      
      // Background fills the content area, inset by border thickness when border exists
      // The border stroke is centered on its path, so we need to account for half the border thickness
      const bgX = borderEnabled ? contentX + borderThicknessScaled / 2 : contentX;
      const bgY = borderEnabled ? contentY + borderThicknessScaled / 2 : contentY;
      const bgWidth = borderEnabled ? contentWidth - borderThicknessScaled : contentWidth;
      const bgHeight = borderEnabled ? contentHeight - borderThicknessScaled : contentHeight;
      
      if (borderStyle === "rounded") {
        const radius = 8 * scale;
        drawRoundedRect(ctx, bgX, bgY, bgWidth, bgHeight, radius);
        ctx.fill();
      } else {
        ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
      }
    }
    
    if (borderEnabled) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = borderThicknessScaled;
      
      // Border stroke is centered on the path
      // Position it so it wraps around the content area
      const borderX = contentX - borderThicknessScaled / 2;
      const borderY = contentY - borderThicknessScaled / 2;
      const borderWidth = contentWidth + borderThicknessScaled;
      const borderHeight = contentHeight + borderThicknessScaled;
      
      if (borderStyle === "rounded") {
        const radius = 8 * scale;
        drawRoundedRect(ctx, borderX, borderY, borderWidth, borderHeight, radius);
        ctx.stroke();
      } else {
        ctx.strokeRect(borderX, borderY, borderWidth, borderHeight);
      }
    }
    
    ctx.fillStyle = textColor;
    
    lines.forEach((line, index) => {
      ctx.fillText(line, textCenterX, startY + index * lineHeight);
    });
    
    return canvas.toDataURL("image/png");
  };

  const handleSave = () => {
    if (!stampData || !text.trim() || !stampName.trim()) return;

    const thumbnail = generateThumbnail();
    const updatedStampData: StampData = {
      ...stampData,
      name: stampName,
      text,
      font,
      textColor,
      backgroundEnabled,
      backgroundColor,
      backgroundOpacity,
      borderEnabled,
      borderStyle,
      borderThickness,
      borderColor,
      borderOffset,
      thumbnail,
    };

    onSave(updatedStampData);
    onClose();
  };

  const fonts = ["Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "Palatino", "Garamond", "Comic Sans MS", "Impact"];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Stamp</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 mt-4">
          {/* Left: Controls */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Stamp Name</Label>
              <Input
                value={stampName}
                onChange={(e) => setStampName(e.target.value)}
                placeholder="Enter stamp name..."
              />
            </div>
            <div className="space-y-2">
              <Label>Text</Label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Enter stamp text..."
                rows={4}
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <Label>Font</Label>
              <select
                value={font}
                onChange={(e) => setFont(e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              >
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            {/* Text Color, Background, Border - Same line */}
            <div className="grid grid-cols-3 gap-2">
              {/* Text Color */}
              <div className="space-y-1">
                <Label className="text-xs">Text</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-9 justify-start"
                      style={{ backgroundColor: textColor }}
                    >
                      <div className="w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: textColor }} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <HexColorPicker color={textColor} onChange={setTextColor} />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Background */}
              <div className="space-y-1">
                <Label className="text-xs">Background</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-9 justify-start"
                      disabled={!backgroundEnabled}
                    >
                      {backgroundEnabled ? (
                        <div className="w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: backgroundColor }} />
                      ) : (
                        <div className="w-4 h-4 rounded border border-gray-300 bg-transparent" />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={backgroundEnabled}
                          onChange={(e) => setBackgroundEnabled(e.target.checked)}
                          className="rounded"
                        />
                        <Label>Enable Background</Label>
                      </div>
                      {backgroundEnabled && (
                        <>
                          <HexColorPicker color={backgroundColor} onChange={setBackgroundColor} />
                          <div className="space-y-2">
                            <Label className="text-xs">Opacity: {backgroundOpacity}%</Label>
                            <Slider
                              value={[backgroundOpacity]}
                              onValueChange={([value]) => setBackgroundOpacity(value)}
                              min={0}
                              max={100}
                              step={1}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              {/* Border */}
              <div className="space-y-1">
                <Label className="text-xs">Border</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-9 justify-start"
                      disabled={!borderEnabled}
                    >
                      {borderEnabled ? (
                        <div className="w-4 h-4 rounded border-2" style={{ borderColor: borderColor }} />
                      ) : (
                        <div className="w-4 h-4 rounded border border-gray-300" />
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={borderEnabled}
                          onChange={(e) => setBorderEnabled(e.target.checked)}
                          className="rounded"
                        />
                        <Label>Enable Border</Label>
                      </div>
                      {borderEnabled && (
                        <>
                          <div className="flex gap-2">
                            <Button
                              variant={borderStyle === "square" ? "default" : "outline"}
                              size="sm"
                              onClick={() => setBorderStyle("square")}
                              className="flex-1"
                            >
                              <Square className="h-4 w-4" />
                            </Button>
                            <Button
                              variant={borderStyle === "rounded" ? "default" : "outline"}
                              size="sm"
                              onClick={() => setBorderStyle("rounded")}
                              className="flex-1"
                            >
                              <Circle className="h-4 w-4" />
                            </Button>
                          </div>
                          <HexColorPicker color={borderColor} onChange={setBorderColor} />
                          <div className="space-y-2">
                            <Label className="text-xs">Thickness: {borderThickness}px</Label>
                            <Slider
                              value={[borderThickness]}
                              onValueChange={([value]) => setBorderThickness(value)}
                              min={1}
                              max={10}
                              step={1}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs">Offset: {borderOffset}px</Label>
                            <Slider
                              value={[borderOffset]}
                              onValueChange={([value]) => setBorderOffset(value)}
                              min={0}
                              max={20}
                              step={1}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          {/* Right: Preview */}
          <div className="space-y-2">
            <Label>Preview</Label>
            <div
              ref={previewContainerRef}
              className="border rounded p-4 bg-gray-50 flex items-center justify-center min-h-[300px]"
              style={{ overflow: "visible" }}
            >
              <div
                ref={previewRef}
                className="text-center flex items-center justify-center"
                style={{
                  color: textColor,
                  fontFamily: font,
                  fontSize: "56px",
                  padding: `${8 + borderOffset}px`,
                  borderRadius: borderStyle === "rounded" ? "8px" : "0px",
                  border: borderEnabled
                    ? `${borderThickness}px solid ${borderColor}`
                    : "none",
                  backgroundColor: backgroundEnabled
                    ? (() => {
                        const r = parseInt(backgroundColor.slice(1, 3), 16);
                        const g = parseInt(backgroundColor.slice(3, 5), 16);
                        const b = parseInt(backgroundColor.slice(5, 7), 16);
                        const opacity = backgroundOpacity / 100;
                        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
                      })()
                    : "transparent",
                  whiteSpace: "pre-line",
                  transformOrigin: "center",
                }}
              >
                {text || "Preview"}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button onClick={handleSave} size="sm" disabled={!text.trim() || !stampName.trim()}>
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

