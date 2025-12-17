/**
 * Stamp Creator Component
 * 
 * Modal dialog for creating text, image, and signature stamps
 */

import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStampStore } from "@/shared/stores/stampStore";
import type { StampData } from "@/core/pdf/PDFEditor";
import { HexColorPicker } from "react-colorful";
import { Type, Image, PenTool, Undo } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface StampCreatorProps {
  open: boolean;
  onClose: () => void;
}

type TabType = "text" | "image" | "signature";

export function StampCreator({ open, onClose }: StampCreatorProps) {
  const { addStamp } = useStampStore();
  const [activeTab, setActiveTab] = useState<TabType>("text");
  const [stampName, setStampName] = useState("");

  // Text stamp state
  const [text, setText] = useState("");
  const [font, setFont] = useState("Arial");
  const [textColor, setTextColor] = useState("#000000");
  const [backgroundEnabled, setBackgroundEnabled] = useState(false); // Transparent by default
  const [backgroundColor, setBackgroundColor] = useState("#FFFFFF");

  // Image stamp state
  const [imageData, setImageData] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Signature stamp state
  const [isDrawing, setIsDrawing] = useState(false);
  const [signaturePath, setSignaturePath] = useState<Array<{ x: number; y: number }>>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Reset form when tab changes
  useEffect(() => {
    if (open) {
      setStampName("");
      setText("");
      setImageData("");
      setSignaturePath([]);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
    }
  }, [open, activeTab]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setImageData(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 60;

    setSignaturePath([{ x, y }]);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    // Normalize coordinates to 0-100 (x) and 0-60 (y) range for storage
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 60;

    setSignaturePath((prev) => [...prev, { x, y }]);

    // Draw on canvas with high resolution
    const ctx = canvas.getContext("2d");
    if (ctx && signaturePath.length > 0) {
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const prevPoint = signaturePath[signaturePath.length - 1];
      ctx.beginPath();
      ctx.moveTo((prevPoint.x / 100) * canvas.width, (prevPoint.y / 60) * canvas.height);
      ctx.lineTo((x / 100) * canvas.width, (y / 60) * canvas.height);
      ctx.stroke();
    }
  };

  const handleCanvasMouseUp = () => {
    setIsDrawing(false);
  };

  const clearSignature = () => {
    setSignaturePath([]);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  };

  const generateThumbnail = (): string => {
    // Use higher resolution for crisp stamps
    const scale = 4; // 4x resolution for high DPI
    
    if (activeTab === "image" && imageData) {
      return imageData;
    }

    if (activeTab === "signature" && signaturePath.length > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = 400 * scale;
      canvas.height = 240 * scale;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // Transparent background by default
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 3 * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.beginPath();
        signaturePath.forEach((point, index) => {
          const x = (point.x / 100) * canvas.width;
          const y = (point.y / 60) * canvas.height;
          if (index === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
      }
      return canvas.toDataURL("image/png");
    }

    if (activeTab === "text" && text) {
      const canvas = document.createElement("canvas");
      canvas.width = 400 * scale;
      canvas.height = 240 * scale;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // Transparent background by default
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        if (backgroundEnabled) {
          ctx.fillStyle = backgroundColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.fillStyle = textColor;
        ctx.font = `${56 * scale}px ${font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      }
      return canvas.toDataURL("image/png");
    }

    return "";
  };

  const handleSave = () => {
    if (!stampName.trim()) {
      alert("Please enter a stamp name");
      return;
    }

    if (activeTab === "text" && !text.trim()) {
      alert("Please enter text for the stamp");
      return;
    }

    if (activeTab === "image" && !imageData) {
      alert("Please upload an image");
      return;
    }

    if (activeTab === "signature" && signaturePath.length === 0) {
      alert("Please draw a signature");
      return;
    }

    const stamp: StampData = {
      id: `stamp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: stampName,
      type: activeTab,
      createdAt: Date.now(),
      thumbnail: generateThumbnail(),
    };

    if (activeTab === "text") {
      stamp.text = text;
      stamp.font = font;
      stamp.textColor = textColor;
      stamp.backgroundEnabled = backgroundEnabled;
      stamp.backgroundColor = backgroundColor;
    } else if (activeTab === "image") {
      stamp.imageData = imageData;
    } else if (activeTab === "signature") {
      stamp.signaturePath = signaturePath;
    }

    addStamp(stamp);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Stamp</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Stamp name */}
          <div>
            <Label htmlFor="stamp-name">Stamp Name</Label>
            <Input
              id="stamp-name"
              value={stampName}
              onChange={(e) => setStampName(e.target.value)}
              placeholder="Enter stamp name"
            />
          </div>

          {/* Tab selector */}
          <div className="flex gap-2 border-b">
            <Button
              variant={activeTab === "text" ? "default" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("text")}
            >
              <Type className="h-4 w-4 mr-1" />
              Text
            </Button>
            <Button
              variant={activeTab === "image" ? "default" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("image")}
            >
              <Image className="h-4 w-4 mr-1" />
              Image
            </Button>
            <Button
              variant={activeTab === "signature" ? "default" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("signature")}
            >
              <PenTool className="h-4 w-4 mr-1" />
              Signature
            </Button>
          </div>

          {/* Text stamp tab */}
          {activeTab === "text" && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="text">Text</Label>
                <Input
                  id="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Enter text"
                />
              </div>

              <div>
                <Label htmlFor="font">Font</Label>
                <select
                  id="font"
                  value={font}
                  onChange={(e) => setFont(e.target.value)}
                  className="w-full px-3 py-2 border rounded-md"
                >
                  <option value="Arial">Arial</option>
                  <option value="Times New Roman">Times New Roman</option>
                  <option value="Courier New">Courier New</option>
                  <option value="Georgia">Georgia</option>
                  <option value="Verdana">Verdana</option>
                </select>
              </div>

              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <Label>Text Color</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className="w-full h-10 border rounded-md"
                        style={{ backgroundColor: textColor }}
                      />
                    </PopoverTrigger>
                    <PopoverContent className="w-auto">
                      <HexColorPicker color={textColor} onChange={setTextColor} />
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="flex-1">
                  <Label>
                    <input
                      type="checkbox"
                      checked={backgroundEnabled}
                      onChange={(e) => setBackgroundEnabled(e.target.checked)}
                      className="mr-2"
                    />
                    Background
                  </Label>
                  {backgroundEnabled && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          className="w-full h-10 border rounded-md"
                          style={{ backgroundColor }}
                        />
                      </PopoverTrigger>
                      <PopoverContent className="w-auto">
                        <HexColorPicker color={backgroundColor} onChange={setBackgroundColor} />
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              </div>

              {/* Preview */}
              <div className="border rounded p-4 h-24 flex items-center justify-center">
                <div
                  style={{
                    color: textColor,
                    fontFamily: font,
                    backgroundColor: backgroundEnabled ? backgroundColor : "transparent",
                    padding: "8px 16px",
                    borderRadius: "4px",
                  }}
                >
                  {text || "Preview"}
                </div>
              </div>
            </div>
          )}

          {/* Image stamp tab */}
          {activeTab === "image" && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="image-upload">Upload Image</Label>
                <Input
                  id="image-upload"
                  type="file"
                  accept="image/*"
                  ref={fileInputRef}
                  onChange={handleImageUpload}
                />
              </div>

              {imageData && (
                <div className="border rounded p-4 h-48 flex items-center justify-center">
                  <img
                    src={imageData}
                    alt="Stamp preview"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              )}
            </div>
          )}

          {/* Signature stamp tab */}
          {activeTab === "signature" && (
            <div className="space-y-3">
              <Label>Draw Signature</Label>
              <div className="border rounded bg-white">
                <canvas
                  ref={canvasRef}
                  width={800}
                  height={400}
                  className="w-full h-48 cursor-crosshair"
                  style={{ imageRendering: "crisp-edges" }}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={handleCanvasMouseUp}
                />
              </div>
              <Button
                onClick={clearSignature}
                variant="outline"
                size="sm"
                className="w-full"
              >
                <Undo className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 justify-end pt-4">
            <Button onClick={onClose} variant="outline">
              Cancel
            </Button>
            <Button onClick={handleSave}>Create Stamp</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

