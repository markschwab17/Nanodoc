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

export function PageTools() {
  const { currentDocument } = usePDF();
  const { currentPage, setCurrentPage } = usePDFStore();
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
      setShowDeleteDialog(false);
      
      // Adjust current page if needed
      const newPageCount = currentDocument.getPageCount() - 1;
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
    if (!currentDocument || !editor) return;

    try {
      await editor.insertBlankPage(currentDocument, currentPage + 1);
      setShowInsertDialog(false);
      setCurrentPage(currentPage + 1);
    } catch (error) {
      console.error("Error inserting page:", error);
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

