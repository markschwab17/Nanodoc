/**
 * Stamp Creator Component
 * 
 * Modal dialog for creating text, image, and signature stamps
 */

import { useState, useRef, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { useStampStore } from "@/shared/stores/stampStore";
import type { StampData } from "@/core/pdf/PDFEditor";
import { HexColorPicker } from "react-colorful";
import { Type, Image, PenTool, Undo, Square, Circle, Upload, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setSelectedStamp } from "@/features/tools/StampTool";
import { useUIStore } from "@/shared/stores/uiStore";

interface StampCreatorProps {
  open: boolean;
  onClose: () => void;
}

type TabType = "text" | "image" | "signature";

export function StampCreator({ open, onClose }: StampCreatorProps) {
  const { addStamp } = useStampStore();
  const { setActiveTool } = useUIStore();
  const [activeTab, setActiveTab] = useState<TabType>("text");
  const [stampName, setStampName] = useState("");

  // Text stamp state
  const [text, setText] = useState("");
  const [font, setFont] = useState("Arial");
  const [textColor, setTextColor] = useState("#000000");
  const [backgroundEnabled, setBackgroundEnabled] = useState(false); // Transparent by default
  const [backgroundColor, setBackgroundColor] = useState("#FFFFFF");
  const [backgroundOpacity, setBackgroundOpacity] = useState(100); // 0-100
  const [borderEnabled, setBorderEnabled] = useState(false);
  const [borderStyle, setBorderStyle] = useState<"rounded" | "square">("rounded");
  const [borderThickness, setBorderThickness] = useState(2);
  const [borderColor, setBorderColor] = useState("#000000");
  const [borderOffset, setBorderOffset] = useState(8); // Distance from text in pixels

  // Image stamp state
  const [imageData, setImageData] = useState("");
  const [originalFile, setOriginalFile] = useState<File | null>(null); // Store original file for scaling
  const [imageScale, setImageScale] = useState(100); // Scale percentage (100 = original, default high DPI)
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Signature stamp state
  const [isDrawing, setIsDrawing] = useState(false);
  const [signaturePath, setSignaturePath] = useState<Array<{ x: number; y: number }>>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Reset form when tab changes
  useEffect(() => {
    if (open) {
      setStampName("");
      setText("");
      setImageData("");
      setOriginalFile(null);
      setImageScale(100);
      setIsDragOver(false);
      setSignaturePath([]);
      setBorderEnabled(false);
      setBorderStyle("rounded");
      setBorderThickness(2);
      setBorderColor("#000000");
      setBorderOffset(8);
      setBackgroundOpacity(100);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
    }
  }, [open, activeTab]);

  // Scale preview to fit container
  useEffect(() => {
    if (activeTab === "text" && previewRef.current && previewContainerRef.current) {
      const container = previewContainerRef.current;
      const content = previewRef.current;
      
      const updateScale = () => {
        if (!container || !content) return;
        
        const containerRect = container.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        
        // Only update if we have valid dimensions
        if (containerRect.width === 0 || containerRect.height === 0 || 
            contentRect.width === 0 || contentRect.height === 0) {
          return;
        }
        
        const availableWidth = containerRect.width - 24; // Account for padding
        const availableHeight = containerRect.height - 24;
        
        const scaleX = availableWidth / contentRect.width;
        const scaleY = availableHeight / contentRect.height;
        const scale = Math.min(scaleX, scaleY, 1); // Don't scale up, only down
        
        // Only update if scale changed significantly to avoid infinite loops
        const currentScale = parseFloat(content.style.transform.match(/scale\(([^)]+)\)/)?.[1] || "1");
        if (Math.abs(currentScale - scale) > 0.01) {
          content.style.transform = `scale(${scale})`;
        }
      };
      
      // Debounce the update to prevent too frequent calls
      let timeoutId: NodeJS.Timeout;
      const debouncedUpdate = () => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          requestAnimationFrame(updateScale);
        }, 50);
      };
      
      // Update scale when dependencies change
      debouncedUpdate();
      
      // Also update on window resize (debounced)
      window.addEventListener('resize', debouncedUpdate);
      
      return () => {
        clearTimeout(timeoutId);
        window.removeEventListener('resize', debouncedUpdate);
      };
    }
  }, [activeTab, text, textColor, font, backgroundEnabled, backgroundColor, backgroundOpacity, borderEnabled, borderStyle, borderThickness, borderColor, borderOffset]);

  const processImage = (file: File, scale: number = 100) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new window.Image();
        img.onload = () => {
          // Default to high DPI (scale up if image is small)
          // For high DPI, we'll use a minimum resolution
          const minWidth = 1200; // Minimum width for high DPI stamps
          const minHeight = 1200; // Minimum height for high DPI stamps
          
          let targetWidth = img.width;
          let targetHeight = img.height;
          
          // If image is smaller than minimum, scale it up
          if (img.width < minWidth || img.height < minHeight) {
            const scaleX = minWidth / img.width;
            const scaleY = minHeight / img.height;
            const scaleFactor = Math.max(scaleX, scaleY);
            targetWidth = img.width * scaleFactor;
            targetHeight = img.height * scaleFactor;
          }
          
          // Apply user's scale preference
          targetWidth = (targetWidth * scale) / 100;
          targetHeight = (targetHeight * scale) / 100;
          
          // Create canvas and draw scaled image
          const canvas = document.createElement("canvas");
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext("2d");
          
          if (!ctx) {
            reject(new Error("Could not get canvas context"));
            return;
          }
          
          // Use high quality image rendering
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
          resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = reject;
        img.src = event.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      alert("Please select an image file");
      return;
    }

    try {
      // Store original file
      setOriginalFile(file);
      
      // Process with current scale
      const processedData = await processImage(file, imageScale);
      setImageData(processedData);
    } catch (error) {
      console.error("Error processing image:", error);
      alert("Error processing image. Please try again.");
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleImageFile(file);
  };

  const handleImageScaleChange = async (scale: number) => {
    setImageScale(scale);
    if (originalFile) {
      const processedData = await processImage(originalFile, scale);
      setImageData(processedData);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const hasImage = Array.from(e.dataTransfer.items).some(
      (item) => item.type.startsWith("image/")
    );
    if (hasImage) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFile = files.find((file) => file.type.startsWith("image/"));

    if (imageFile) {
      await handleImageFile(imageFile);
    }
  };

  const handleRemoveImage = () => {
    setImageData("");
    setOriginalFile(null);
    setImageScale(100);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
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
    const scale = 6; // 6x resolution for high DPI (2400x1440 base, up to 9600x5760 for very large stamps)
    
    if (activeTab === "image" && imageData) {
      // For image stamps, return the original image data
      // The browser will handle scaling with imageRendering: "auto"
      // For better quality, users should upload high-resolution images
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
      // Helper function to draw rounded rectangle
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
      
      // First, calculate content dimensions to determine canvas size
      const tempCanvas = document.createElement("canvas");
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return "";
      
      tempCtx.font = `${56 * scale}px ${font}`;
      tempCtx.textAlign = "center";
      tempCtx.textBaseline = "middle";
      
      const lines = text.split('\n');
      const fontSize = 56 * scale;
      const lineHeight = fontSize * 1.2;
      
      // Measure text width for all lines
      let maxTextWidth = 0;
      lines.forEach((line) => {
        const metrics = tempCtx.measureText(line);
        if (metrics.width > maxTextWidth) {
          maxTextWidth = metrics.width;
        }
      });
      
      // Calculate the actual text block dimensions
      const textBlockHeight = lines.length * lineHeight;
      
      // Calculate background/border dimensions with offset
      const offset = borderOffset * scale;
      const borderThicknessScaled = borderThickness * scale;
      const contentPadding = offset;
      
      // Calculate content dimensions (text + padding)
      const contentWidth = maxTextWidth + contentPadding * 2;
      const contentHeight = textBlockHeight + contentPadding * 2;
      
      // Total dimensions include border thickness (border extends outward from content)
      const totalWidth = contentWidth + (borderEnabled ? borderThicknessScaled : 0);
      const totalHeight = contentHeight + (borderEnabled ? borderThicknessScaled : 0);
      
      // Create canvas exactly the size of the stamp (no extra padding)
      const canvas = document.createElement("canvas");
      canvas.width = totalWidth;
      canvas.height = totalHeight;
      
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      
      // Transparent background
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Content area starts after border (if enabled)
      const contentX = borderEnabled ? borderThicknessScaled / 2 : 0;
      const contentY = borderEnabled ? borderThicknessScaled / 2 : 0;
      
      // Calculate text position (centered in content area)
      const textBlockTop = contentY + contentPadding;
      const firstLineCenterY = textBlockTop + lineHeight / 2;
      const startY = firstLineCenterY;
      const textCenterX = contentX + contentWidth / 2;
        
      // Set font for text rendering
      ctx.font = `${fontSize}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      // Draw background if enabled (background fills inside the border area)
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
      
      // Draw border if enabled (border wraps around the content area)
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
      
      // Draw text (support multi-line)
      ctx.fillStyle = textColor;
      
      lines.forEach((line, index) => {
        ctx.fillText(line, textCenterX, startY + index * lineHeight);
      });
      
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
      stamp.backgroundOpacity = backgroundOpacity;
      stamp.borderEnabled = borderEnabled;
      stamp.borderStyle = borderStyle;
      stamp.borderThickness = borderThickness;
      stamp.borderColor = borderColor;
      stamp.borderOffset = borderOffset;
    } else if (activeTab === "image") {
      stamp.imageData = imageData;
    } else if (activeTab === "signature") {
      stamp.signaturePath = signaturePath;
    }

    addStamp(stamp);
    
    // Auto-select the newly created stamp for placement
    setSelectedStamp(stamp.id);
    setActiveTool("stamp");
    
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Stamp</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Stamp name */}
          <div>
            <Label htmlFor="stamp-name" className="text-sm">Stamp Name</Label>
            <Input
              id="stamp-name"
              value={stampName}
              onChange={(e) => setStampName(e.target.value)}
              placeholder="Enter stamp name"
              className="h-9"
            />
          </div>

          {/* Tab selector */}
          <div className="flex gap-2 border-b pb-2">
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
            <div className="space-y-2.5">
              <div>
                <Label htmlFor="text" className="text-sm">Text (Press Enter for new line)</Label>
                <Textarea
                  id="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Enter text (press Enter for new line)"
                  rows={2}
                  className="resize-none text-sm"
                />
              </div>

              <div>
                <Label htmlFor="font" className="text-sm">Font</Label>
                <select
                  id="font"
                  value={font}
                  onChange={(e) => setFont(e.target.value)}
                  className="w-full px-3 py-1.5 border rounded-md text-sm h-9"
                >
                  <option value="Arial">Arial</option>
                  <option value="Times New Roman">Times New Roman</option>
                  <option value="Courier New">Courier New</option>
                  <option value="Georgia">Georgia</option>
                  <option value="Verdana">Verdana</option>
                </select>
              </div>

              {/* Compact color and border controls - all on same line */}
              <div className="grid grid-cols-3 gap-2">
                {/* Text Color */}
                <div className="flex flex-col">
                  <Label className="text-xs flex items-center gap-1 h-5 mb-1">
                    <span className="w-3 h-3"></span>
                    <span>Text</span>
                  </Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="w-full h-8 border rounded-md flex items-center justify-center gap-1.5 text-xs bg-white hover:bg-gray-50">
                        <div className="w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: textColor }} />
                        <span className="text-[10px] font-mono text-gray-700">{textColor}</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-2">
                      <HexColorPicker color={textColor} onChange={setTextColor} />
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Background Color */}
                <div className="flex flex-col">
                  <Label className="text-xs flex items-center gap-1 h-5 mb-1">
                    <input
                      type="checkbox"
                      checked={backgroundEnabled}
                      onChange={(e) => setBackgroundEnabled(e.target.checked)}
                      className="w-3 h-3"
                    />
                    <span>Background</span>
                  </Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className="w-full h-8 border rounded-md flex items-center justify-center gap-1.5 text-xs bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={!backgroundEnabled}
                      >
                        <div 
                          className="w-4 h-4 rounded border border-gray-300" 
                          style={{ 
                            backgroundColor: backgroundEnabled 
                              ? `rgba(${parseInt(backgroundColor.slice(1, 3), 16)}, ${parseInt(backgroundColor.slice(3, 5), 16)}, ${parseInt(backgroundColor.slice(5, 7), 16)}, ${backgroundOpacity / 100})` 
                              : "#fff" 
                          }} 
                        />
                        <span className="text-[10px] font-mono text-gray-700">{backgroundEnabled ? `${backgroundOpacity}%` : "off"}</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-3">
                      <div className="space-y-3">
                        <div>
                          <Label className="text-xs mb-2 block">Color</Label>
                          <HexColorPicker color={backgroundColor} onChange={setBackgroundColor} />
                        </div>
                        <div>
                          <Label className="text-xs mb-2 block">Opacity: {backgroundOpacity}%</Label>
                          <Slider
                            value={[backgroundOpacity]}
                            onValueChange={([value]) => setBackgroundOpacity(value)}
                            min={0}
                            max={100}
                            step={1}
                          />
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Border */}
                <div className="flex flex-col">
                  <Label className="text-xs flex items-center gap-1 h-5 mb-1">
                    <input
                      type="checkbox"
                      checked={borderEnabled}
                      onChange={(e) => setBorderEnabled(e.target.checked)}
                      className="w-3 h-3"
                    />
                    <span>Border</span>
                  </Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        className="w-full h-8 border rounded-md flex items-center justify-center gap-1.5 text-xs bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={!borderEnabled}
                      >
                        <div className="w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: borderEnabled ? borderColor : "#fff" }} />
                        <span className="text-[10px] font-mono text-gray-700">{borderEnabled ? borderThickness + "px" : "off"}</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-3">
                      <div className="space-y-3">
                        <div>
                          <Label className="text-xs mb-2 block">Style</Label>
                          <div className="flex gap-2">
                            <Button
                              variant={borderStyle === "rounded" ? "default" : "outline"}
                              size="sm"
                              onClick={() => setBorderStyle("rounded")}
                              className="flex-1"
                            >
                              <Circle className="h-3 w-3 mr-1" />
                              Round
                            </Button>
                            <Button
                              variant={borderStyle === "square" ? "default" : "outline"}
                              size="sm"
                              onClick={() => setBorderStyle("square")}
                              className="flex-1"
                            >
                              <Square className="h-3 w-3 mr-1" />
                              Square
                            </Button>
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs mb-2 block">Thickness: {borderThickness}px</Label>
                          <Slider
                            value={[borderThickness]}
                            onValueChange={([value]) => setBorderThickness(value)}
                            min={1}
                            max={10}
                            step={1}
                          />
                        </div>
                        <div>
                          <Label className="text-xs mb-2 block">Offset: {borderOffset}px</Label>
                          <Slider
                            value={[borderOffset]}
                            onValueChange={([value]) => setBorderOffset(value)}
                            min={0}
                            max={30}
                            step={1}
                          />
                        </div>
                        <div>
                          <Label className="text-xs mb-2 block">Color</Label>
                          <HexColorPicker color={borderColor} onChange={setBorderColor} />
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              {/* Preview */}
              <div 
                ref={previewContainerRef}
                className="border rounded p-3 h-24 flex items-center justify-center bg-gray-50 overflow-hidden relative"
              >
                <div
                  ref={previewRef}
                  style={{
                    color: textColor,
                    fontFamily: font,
                    backgroundColor: backgroundEnabled 
                      ? `rgba(${parseInt(backgroundColor.slice(1, 3), 16)}, ${parseInt(backgroundColor.slice(3, 5), 16)}, ${parseInt(backgroundColor.slice(5, 7), 16)}, ${backgroundOpacity / 100})` 
                      : "transparent",
                    padding: `${6 + borderOffset}px ${12 + borderOffset}px`,
                    borderRadius: borderStyle === "rounded" ? "8px" : "0px",
                    border: borderEnabled ? `${borderThickness}px solid ${borderColor}` : "none",
                    whiteSpace: "pre-line",
                    textAlign: "center",
                    fontSize: "14px",
                    transformOrigin: "center",
                    display: "inline-block",
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
              {!imageData ? (
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                    isDragOver
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-300 bg-gray-50 hover:border-gray-400"
                  }`}
                >
                  <Upload className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    Drag and drop an image here
                  </p>
                  <p className="text-xs text-gray-500 mb-4">or</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Select Image
                  </Button>
                  <Input
                    id="image-upload"
                    type="file"
                    accept="image/*"
                    ref={fileInputRef}
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                  <p className="text-xs text-gray-400 mt-3">
                    Images default to high DPI for crisp stamps
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="border rounded p-4 bg-gray-50 flex items-center justify-center relative min-h-[200px]">
                    <img
                      src={imageData}
                      alt="Stamp preview"
                      className="max-w-full max-h-[200px] object-contain"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemoveImage}
                      className="absolute top-2 right-2 h-8 w-8 p-0 bg-white hover:bg-gray-100"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm">Image Scale: {imageScale}%</Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleImageScaleChange(100)}
                        className="h-7 text-xs"
                      >
                        Reset
                      </Button>
                    </div>
                    <Slider
                      value={[imageScale]}
                      onValueChange={([value]) => handleImageScaleChange(value)}
                      min={25}
                      max={200}
                      step={5}
                    />
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>25% (Smaller)</span>
                      <span>100% (Original/High DPI)</span>
                      <span>200% (Larger)</span>
                    </div>
                    <p className="text-xs text-gray-400">
                      Default is high DPI for crisp stamps. Reduce scale to save space.
                    </p>
                  </div>
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
          <div className="flex gap-2 justify-end pt-2 border-t">
            <Button onClick={onClose} variant="outline" size="sm">
              Cancel
            </Button>
            <Button onClick={handleSave} size="sm">Create Stamp</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

