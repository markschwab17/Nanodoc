/**
 * Page Tools Component
 * 
 * UI for page manipulation: delete, insert, reorder.
 */

import { useState, useEffect } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Trash2, Plus } from "lucide-react";
import { usePDF } from "@/shared/hooks/usePDF";
import { useTabStore } from "@/shared/stores/tabStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";

export function PageTools() {
  const { currentDocument } = usePDF();
  const { currentPage, setCurrentPage } = usePDFStore();
  const { showNotification } = useNotificationStore();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showInsertDialog, setShowInsertDialog] = useState(false);
  const [editor, setEditor] = useState<PDFEditor | null>(null);

  // Initialize editor
  useEffect(() => {
    const initEditor = async () => {
      try {
        const mupdfModule = await import("mupdf");
        setEditor(new PDFEditor(mupdfModule.default));
      } catch (error) {
        console.error("Error initializing PDF editor:", error);
      }
    };
    initEditor();
  }, []);

  const handleDeletePage = async () => {
    if (!currentDocument || !editor) return;

    try {
      await editor.deletePages(currentDocument, [currentPage]);
      
      // Refresh document metadata to update page count and page info
      currentDocument.refreshPageMetadata();
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDocument.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
      
      setShowDeleteDialog(false);
      
      // Adjust current page if needed
      const newPageCount = currentDocument.getPageCount();
      if (currentPage >= newPageCount && newPageCount > 0) {
        setCurrentPage(newPageCount - 1);
      } else if (newPageCount === 0) {
        setCurrentPage(0);
      }
    } catch (error) {
      console.error("Error deleting page:", error);
    }
  };

  const handleInsertBlankPage = async () => {
    if (!currentDocument) {
      showNotification("No document is open", "error");
      return;
    }

    if (!editor) {
      showNotification("PDF editor is not initialized. Please try again.", "error");
      console.error("Editor is not initialized");
      return;
    }

    try {
      const insertIndex = currentPage + 1;
      console.log(`Inserting blank page at index ${insertIndex}`);
      
      await editor.insertBlankPage(currentDocument, insertIndex);
      
      // Refresh document metadata to update page count and page info
      currentDocument.refreshPageMetadata();
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDocument.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
      
      // Force store update to trigger re-render
      usePDFStore.getState().setCurrentPage(insertIndex);
      
      setShowInsertDialog(false);
      showNotification(`Blank page inserted after page ${currentPage + 1}`, "success");
      
      console.log(`Successfully inserted page. New page count: ${currentDocument.getPageCount()}`);
    } catch (error) {
      console.error("Error inserting page:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      showNotification(`Failed to insert page: ${errorMessage}`, "error");
    }
  };

  if (!currentDocument) return null;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowInsertDialog(true)}
      >
        <Plus className="h-4 w-4 mr-2" />
        Insert Page
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowDeleteDialog(true)}
        disabled={currentDocument.getPageCount() <= 1}
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete Page
      </Button>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Page</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete page {currentPage + 1}? This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeletePage}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Insert Page Dialog */}
      <Dialog open={showInsertDialog} onOpenChange={setShowInsertDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert Page</DialogTitle>
            <DialogDescription>
              Insert a blank page after page {currentPage + 1}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInsertDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleInsertBlankPage}>
              <Plus className="h-4 w-4 mr-2" />
              Insert Blank Page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

