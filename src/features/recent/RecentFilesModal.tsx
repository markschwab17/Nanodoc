/**
 * Recent Files Modal Component
 * 
 * Displays a list of recently opened PDF files and allows opening them.
 */

import { useRecentFilesStore } from "@/shared/stores/recentFilesStore";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, X, Clock } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface RecentFilesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RecentFilesModal({ open, onOpenChange }: RecentFilesModalProps) {
  const { getRecentFiles, removeRecentFile } = useRecentFilesStore();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [loading, setLoading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  const recentFiles = getRecentFiles();

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
      
      // Close modal on success
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Recent Files</DialogTitle>
          <DialogDescription>
            Select a file to open it, or remove it from the recent list.
          </DialogDescription>
        </DialogHeader>
        
        {recentFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No recent files</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-2">
              {recentFiles.map((file) => {
                const isLoading = loading === file.path;
                const error = errors.get(file.path);

                return (
                  <div
                    key={file.path}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-lg border transition-colors",
                      "hover:bg-accent",
                      isLoading && "opacity-50 pointer-events-none",
                      error && "border-destructive"
                    )}
                  >
                    <FileText className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{file.name}</p>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <p className="text-xs text-muted-foreground">
                          {formatDate(file.lastOpened)}
                        </p>
                      </div>
                      {error && (
                        <p className="text-xs text-destructive mt-1">
                          {error}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground truncate mt-1">
                        {file.path}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenFile(file.path, file.name)}
                        disabled={isLoading}
                        className="h-8"
                      >
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveFile(file.path)}
                        disabled={isLoading}
                        className="h-8 w-8"
                        title="Remove from recent"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

