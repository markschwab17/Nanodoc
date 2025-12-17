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
import { Search, Trash2, Plus } from "lucide-react";
import { setSelectedStamp } from "@/features/tools/StampTool";
import { useUIStore } from "@/shared/stores/uiStore";

interface StampGalleryProps {
  onCreateNew: () => void;
  onClose?: () => void;
}

export function StampGallery({ onCreateNew, onClose }: StampGalleryProps) {
  const { stamps, deleteStamp, getRecentStamps, searchStamps } = useStampStore();
  const { setActiveTool } = useUIStore();
  const [searchQuery, setSearchQuery] = useState("");

  const recentStamps = getRecentStamps(5);
  const displayStamps = searchQuery ? searchStamps(searchQuery) : stamps;

  const handleStampSelect = (stampId: string) => {
    setSelectedStamp(stampId);
    setActiveTool("stamp");
    if (onClose) onClose();
  };

  const handleDelete = (stampId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this stamp?")) {
      deleteStamp(stampId);
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
      return (
        <div
          className="w-full h-full flex items-center justify-center text-center p-2"
          style={{
            color: stamp.textColor || "#000000",
            backgroundColor: stamp.backgroundEnabled ? stamp.backgroundColor || "#FFFFFF" : "transparent",
            fontFamily: stamp.font || "Arial",
            fontSize: "10px",
            overflow: "hidden",
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

  return (
    <div className="w-full max-w-md">
      <div className="flex items-center gap-2 mb-4">
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

      {recentStamps.length > 0 && !searchQuery && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold mb-2">Recently Used</h3>
          <div className="grid grid-cols-5 gap-2">
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

      <div>
        <h3 className="text-sm font-semibold mb-2">
          {searchQuery ? "Search Results" : "All Stamps"}
        </h3>
        <ScrollArea className="h-[300px]">
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
            <div className="grid grid-cols-4 gap-2 pr-2">
              {displayStamps.map((stamp) => (
                <div
                  key={stamp.id}
                  className="aspect-square border-2 border-gray-200 rounded hover:border-blue-500 transition-colors relative group cursor-pointer"
                  title={stamp.name}
                  onClick={() => handleStampSelect(stamp.id)}
                >
                  {renderStampPreview(stamp)}
                  <button
                    onClick={(e) => handleDelete(stamp.id, e)}
                    className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity z-10"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                  <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs p-1 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                    {stamp.name}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

