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
  const { tabs, activeTabId, setActiveTab, removeTab, reorderTabs } =
    useTabStore();
  const { setCurrentDocument } = usePDFStore();
  const fileSystem = useFileSystem();
  const { loadPDF } = usePDF();
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

  const handleTabClick = (documentId: string) => {
    const tab = tabs.find((t) => t.documentId === documentId);
    if (tab) {
      setActiveTab(tab.id);
      setCurrentDocument(documentId);
    }
  };

  const handleTabClose = (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      // Clean up print settings for this document
      import("@/shared/stores/printStore").then(({ usePrintStore }) => {
        usePrintStore.getState().removeDocumentSettings(tab.documentId);
      });
      
      // Remove the document from PDF store
      const { removeDocument } = usePDFStore.getState();
      removeDocument(tab.documentId);
    }
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

  const handleTabDragStart = (e: React.DragEvent, tabId: string) => {
    // Store the dragged tab ID
    setDraggedTabId(tabId);
  };

  const handleTabDragOver = (e: React.DragEvent, index: number) => {
    // Only handle if dragging a tab (not a PDF file)
    if (e.dataTransfer.types.includes("application/x-tab-id") && draggedTabId) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDragOverTabIndex(index);
    }
  };

  const handleTabDragLeave = () => {
    setDragOverTabIndex(null);
  };

  const handleTabDrop = (e: React.DragEvent, dropIndex: number) => {
    // Only handle if this is a tab drag
    if (!e.dataTransfer.types.includes("application/x-tab-id") || !draggedTabId) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    // Use the stored draggedTabId instead of reading from dataTransfer
    const fromIndex = tabs.findIndex(t => t.id === draggedTabId);
    if (fromIndex !== -1 && fromIndex !== dropIndex) {
      reorderTabs(fromIndex, dropIndex);
    }
    
    setDraggedTabId(null);
    setDragOverTabIndex(null);
  };

  const handleTabDragEnd = () => {
    setDraggedTabId(null);
    setDragOverTabIndex(null);
  };

  const handleContainerDragOver = (e: React.DragEvent) => {
    // Handle drag over on the container (for dropping after the last tab)
    if (e.dataTransfer.types.includes("application/x-tab-id") && draggedTabId) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      // Set drag over index to the end (after last tab)
      setDragOverTabIndex(tabs.length);
    }
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    // Handle drop on the container (for dropping after the last tab)
    if (!e.dataTransfer.types.includes("application/x-tab-id") || !draggedTabId) {
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    // Use the stored draggedTabId
    const fromIndex = tabs.findIndex(t => t.id === draggedTabId);
    if (fromIndex !== -1 && fromIndex !== tabs.length) {
      // Drop at the end
      reorderTabs(fromIndex, tabs.length);
    }
    
    setDraggedTabId(null);
    setDragOverTabIndex(null);
  };

  return (
    <div>
      <ScrollArea className="w-full">
        <div 
          className="flex items-center gap-1"
          onDragOver={handleContainerDragOver}
          onDrop={handleContainerDrop}
        >
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              onDragOver={(e) => handleTabDragOver(e, index)}
              onDragLeave={handleTabDragLeave}
              onDrop={(e) => handleTabDrop(e, index)}
              className={cn(
                "transition-all relative",
                dragOverTabIndex === index && "opacity-50"
              )}
            >
              <TabItem
                tab={tab}
                isActive={tab.id === activeTabId}
                onClick={() => handleTabClick(tab.documentId)}
                onClose={() => handleTabClose(tab.id)}
                onDragStart={handleTabDragStart}
                onDragEnd={handleTabDragEnd}
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
            </div>
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

