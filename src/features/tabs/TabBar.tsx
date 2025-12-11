/**
 * Tab Bar Component
 * 
 * Displays and manages PDF tabs with reordering support.
 */

import { useTabStore } from "@/shared/stores/tabStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { TabItem } from "./TabItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { usePDF } from "@/shared/hooks/usePDF";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, removeTab } =
    useTabStore();
  const { setCurrentDocument } = usePDFStore();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleTabClick = (documentId: string) => {
    const tab = tabs.find((t) => t.documentId === documentId);
    if (tab) {
      setActiveTab(tab.id);
      setCurrentDocument(documentId);
    }
  };

  const handleTabClose = (tabId: string) => {
    removeTab(tabId);
  };

  const handleOpenNewPDF = async () => {
    const result = await fileSystem.openFile();
    if (result) {
      try {
        // Initialize mupdf
        const mupdfModule = await import("mupdf");
        await loadPDF(result.data, result.name, mupdfModule.default, result.path || null);
      } catch (error) {
        console.error("Error loading PDF:", error);
      }
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const pdfFile = files.find(
      (file) => file.type === "application/pdf" || file.name.endsWith(".pdf")
    );

    if (pdfFile) {
      try {
        const arrayBuffer = await pdfFile.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const mupdfModule = await import("mupdf");
        await loadPDF(data, pdfFile.name, mupdfModule.default);
      } catch (error) {
        console.error("Error loading dropped PDF:", error);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const hasPdf = Array.from(e.dataTransfer.items).some(
      (item) => item.type === "application/pdf" || item.type === ""
    );
    if (hasPdf) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  return (
    <div>
      <ScrollArea className="w-full">
        <div className="flex items-center gap-1">
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onClick={() => handleTabClick(tab.documentId)}
              onClose={() => handleTabClose(tab.id)}
              onRename={(newName) => {
                // Update tab name
                useTabStore.getState().updateTab(tab.id, { name: newName });
                // Update PDF document name
                const document = usePDFStore.getState().documents.get(tab.documentId);
                if (document) {
                  document.setName(newName);
                }
              }}
            />
          ))}
          {/* Plus button to open new PDF - supports drag and drop */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleOpenNewPDF}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            data-plus-button="true"
            className={cn(
              "h-7 w-7 min-w-[28px] opacity-70 hover:opacity-100 border border-dashed transition-colors",
              isDragOver
                ? "border-primary bg-primary/10 opacity-100"
                : "border-border/50 hover:border-border"
            )}
            title="Open PDF (or drag PDF here)"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </ScrollArea>
    </div>
  );
}

