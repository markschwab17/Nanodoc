/**
 * Recent Files Slide-out Panel Component
 * 
 * Displays a list of recently opened PDF files in a small slide-out menu.
 */

import { useRecentFilesStore } from "@/shared/stores/recentFilesStore";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, X, Clock } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface RecentFilesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: React.RefObject<HTMLButtonElement>;
}

export function RecentFilesModal({ open, onOpenChange, triggerRef }: RecentFilesModalProps) {
  const { getRecentFiles, removeRecentFile } = useRecentFilesStore();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [loading, setLoading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const recentFiles = getRecentFiles();

  // Update position based on trigger button
  useEffect(() => {
    if (open) {
      if (triggerRef?.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        // Position to the left of the button
        // Panel's right edge should be at: button's left edge - gap
        const gap = 8; // 8px gap between button and panel
        setPosition({
          top: rect.top,
          right: window.innerWidth - rect.left + gap,
        });
      } else {
        // Default position (top right) when no trigger ref (e.g., on startup)
        setPosition({
          top: 80,
          right: 20,
        });
      }
    }
  }, [open, triggerRef]);

  // Handle escape key to close
  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, onOpenChange]);

  const handleOpenFile = async (filePath: string, fileName: string) => {
    setLoading(filePath);
    setErrors((prev) => {
      const newErrors = new Map(prev);
      newErrors.delete(filePath);
      return newErrors;
    });

    try {
      // Read file from path
      const fileData = await fileSystem.readFile(filePath);
      
      // Load PDF
      const mupdfModule = await import("mupdf");
      await loadPDF(fileData, fileName, mupdfModule.default, filePath);
      
      // Close panel on success
      onOpenChange(false);
    } catch (error) {
      console.error("Error opening recent file:", error);
      setErrors((prev) => {
        const newErrors = new Map(prev);
        newErrors.set(
          filePath,
          error instanceof Error ? error.message : "Failed to open file"
        );
        return newErrors;
      });
    } finally {
      setLoading(null);
    }
  };

  const handleRemoveFile = (filePath: string) => {
    removeRecentFile(filePath);
    setErrors((prev) => {
      const newErrors = new Map(prev);
      newErrors.delete(filePath);
      return newErrors;
    });
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    
    return date.toLocaleDateString();
  };

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-transparent"
          onClick={() => onOpenChange(false)}
          aria-hidden={!open}
        />
      )}

      {/* Slide-out Panel */}
      <div
        ref={panelRef}
        className={cn(
          "fixed z-50 w-80 bg-background border rounded-lg shadow-lg",
          "transition-all duration-300 ease-in-out",
          open ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-4 pointer-events-none",
          "max-h-[600px] flex flex-col"
        )}
        style={{
          top: `${position.top}px`,
          right: `${position.right}px`,
        }}
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b flex-shrink-0">
          <h2 className="text-sm font-semibold">Recent Files</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="h-6 w-6"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2">
            {recentFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <FileText className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No recent files</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentFiles.map((file) => {
                  const isLoading = loading === file.path;
                  const error = errors.get(file.path);

                  return (
                    <div
                      key={file.path}
                      className={cn(
                        "flex items-start gap-2 p-2 rounded-md border transition-colors",
                        "hover:bg-accent cursor-pointer",
                        isLoading && "opacity-50 pointer-events-none",
                        error && "border-destructive"
                      )}
                      onClick={() => !isLoading && handleOpenFile(file.path, file.name)}
                    >
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                      
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Clock className="h-3 w-3 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">
                            {formatDate(file.lastOpened)}
                          </p>
                        </div>
                        {error && (
                          <p className="text-xs text-destructive mt-0.5">
                            {error}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {file.path}
                        </p>
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveFile(file.path);
                        }}
                        disabled={isLoading}
                        className="h-6 w-6 flex-shrink-0"
                        title="Remove from recent"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </>
  );
}






