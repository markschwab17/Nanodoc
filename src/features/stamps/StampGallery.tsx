/**
 * Stamp Gallery Component
 * 
 * Grid view of saved stamps with search and selection
 */

import { useState } from "react";
import { useStampStore } from "@/shared/stores/stampStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Search, Trash2, Plus, Minus, Pencil } from "lucide-react";
import { setSelectedStamp } from "@/features/tools/StampTool";
import { useUIStore } from "@/shared/stores/uiStore";
import { StampEditor } from "./StampEditor";
import type { StampData } from "@/core/pdf/PDFEditor";

interface StampGalleryProps {
  onCreateNew: () => void;
  onClose?: () => void;
}

export function StampGallery({ onCreateNew, onClose: _onClose }: StampGalleryProps) {
  const { stamps, deleteStamp, updateStamp, getRecentStamps, searchStamps, stampSizeMultiplier, setStampSizeMultiplier } = useStampStore();
  const { setActiveTool } = useUIStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [editingStamp, setEditingStamp] = useState<StampData | null>(null);

  const recentStamps = getRecentStamps(5);
  const displayStamps = searchQuery ? searchStamps(searchQuery) : stamps;

  const handleStampSelect = (stampId: string) => {
    setSelectedStamp(stampId);
    setActiveTool("stamp");
  };

  const handleDelete = (stampId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this stamp?")) {
      deleteStamp(stampId);
    }
  };

  const handleEdit = (stamp: StampData, e: React.MouseEvent) => {
    e.stopPropagation();
    if (stamp.type === "text") {
      setEditingStamp(stamp);
    }
  };

  const handleSaveEdit = (updatedStampData: StampData) => {
    if (editingStamp) {
      updateStamp(editingStamp.id, updatedStampData);
      setEditingStamp(null);
    }
  };

  const renderStampPreview = (stamp: any) => {
    if (stamp.thumbnail) {
      return (
        <img
          src={stamp.thumbnail}
          alt={stamp.name}
          className="w-full h-full object-contain"
        />
      );
    }

    if (stamp.type === "text" && stamp.text) {
      const bgColor = stamp.backgroundEnabled && stamp.backgroundColor
        ? (() => {
            const r = parseInt(stamp.backgroundColor.slice(1, 3), 16);
            const g = parseInt(stamp.backgroundColor.slice(3, 5), 16);
            const b = parseInt(stamp.backgroundColor.slice(5, 7), 16);
            const opacity = stamp.backgroundOpacity !== undefined ? stamp.backgroundOpacity / 100 : 1;
            return `rgba(${r}, ${g}, ${b}, ${opacity})`;
          })()
        : "transparent";
      const padding = stamp.borderOffset !== undefined ? `${2 + stamp.borderOffset}px` : "2px";
      
      return (
        <div
          className="w-full h-full flex items-center justify-center text-center"
          style={{
            color: stamp.textColor || "#000000",
            backgroundColor: bgColor,
            fontFamily: stamp.font || "Arial",
            fontSize: "10px",
            overflow: "hidden",
            borderRadius: stamp.borderStyle === "rounded" ? "4px" : "0px",
            border: stamp.borderEnabled ? `${stamp.borderThickness || 2}px solid ${stamp.borderColor || "#000000"}` : "none",
            whiteSpace: "pre-line",
            padding,
          }}
        >
          {stamp.text}
        </div>
      );
    }

    if (stamp.type === "signature" && stamp.signaturePath) {
      return (
        <svg className="w-full h-full" viewBox="0 0 100 60">
          <path
            d={`M ${stamp.signaturePath.map((p: any) => `${p.x},${p.y}`).join(" L ")}`}
            stroke="#000000"
            strokeWidth="2"
            fill="none"
          />
        </svg>
      );
    }

    return (
      <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
        {stamp.type}
      </div>
    );
  };

  const handleSizeChange = (value: number[]) => {
    setStampSizeMultiplier(value[0]);
  };

  const handleSizeButton = (delta: number) => {
    const newValue = Math.max(0.1, Math.min(2.0, stampSizeMultiplier + delta));
    setStampSizeMultiplier(newValue);
  };

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center gap-2 mb-4 flex-shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search stamps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button onClick={onCreateNew} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          New
        </Button>
      </div>

      {/* Size Control */}
      <div className="mb-4 flex-shrink-0 space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <Label className="text-sm">Stamp Size: {Math.round(stampSizeMultiplier * 100)}%</Label>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleSizeButton(-0.1)}
              disabled={stampSizeMultiplier <= 0.1}
            >
              <Minus className="h-3 w-3" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => handleSizeButton(0.1)}
              disabled={stampSizeMultiplier >= 2.0}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <Slider
          value={[stampSizeMultiplier]}
          onValueChange={handleSizeChange}
          min={0.1}
          max={2.0}
          step={0.1}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>10%</span>
          <span>100%</span>
          <span>200%</span>
        </div>
      </div>

      {recentStamps.length > 0 && !searchQuery && (
        <div className="mb-4 flex-shrink-0">
          <h3 className="text-sm font-semibold mb-2">Recently Used</h3>
          <div className="grid grid-cols-6 gap-2">
            {recentStamps.map((stamp) => (
              <div
                key={stamp.id}
                onClick={() => handleStampSelect(stamp.id)}
                className="aspect-square border-2 border-gray-200 rounded hover:border-blue-500 transition-colors relative group cursor-pointer"
                title={stamp.name}
              >
                {renderStampPreview(stamp)}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0">
        <h3 className="text-sm font-semibold mb-2 flex-shrink-0">
          {searchQuery ? "Search Results" : "All Stamps"}
        </h3>
        <ScrollArea className="flex-1">
          {displayStamps.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <p className="text-sm">
                {searchQuery ? "No stamps found" : "No stamps yet"}
              </p>
              {!searchQuery && (
                <Button onClick={onCreateNew} variant="link" size="sm" className="mt-2">
                  Create your first stamp
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-2 pr-2">
              {displayStamps.map((stamp) => (
                <div
                  key={stamp.id}
                  className="aspect-square border-2 border-gray-200 rounded hover:border-blue-500 transition-colors relative group cursor-pointer"
                  title={stamp.name}
                  onClick={() => handleStampSelect(stamp.id)}
                >
                  {renderStampPreview(stamp)}
                  <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    {stamp.type === "text" && (
                      <button
                        onClick={(e) => handleEdit(stamp, e)}
                        className="p-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDelete(stamp.id, e)}
                      className="p-1 bg-red-500 text-white rounded hover:bg-red-600"
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs p-1 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {stamp.name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Stamp Editor Dialog */}
      <StampEditor
        open={editingStamp !== null}
        onClose={() => setEditingStamp(null)}
        stampData={editingStamp}
        onSave={handleSaveEdit}
      />
    </div>
  );
}

