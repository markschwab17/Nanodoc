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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Trash2, Plus } from "lucide-react";
import { usePDF } from "@/shared/hooks/usePDF";
import { useTabStore } from "@/shared/stores/tabStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { wrapPageOperation } from "@/shared/stores/undoHelpers";

export function PageTools() {
  const { currentDocument } = usePDF();
  const { currentPage, setCurrentPage, documents, getAnnotations } = usePDFStore();
  const { showNotification } = useNotificationStore();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showInsertDialog, setShowInsertDialog] = useState(false);
  const [editor, setEditor] = useState<PDFEditor | null>(null);
  const [insertMode, setInsertMode] = useState<"blank" | "fromPdf">("blank");
  const [insertPosition, setInsertPosition] = useState<"before" | "after">("after");
  const [targetPageNumber, setTargetPageNumber] = useState<number>(1);
  const [selectedSourceDocumentId, setSelectedSourceDocumentId] = useState<string | null>(null);
  const [selectedPages, setSelectedPages] = useState<number[] | "all">("all");
  const [pageRangeStart, setPageRangeStart] = useState<number>(1);
  const [pageRangeEnd, setPageRangeEnd] = useState<number>(1);
  const [pageSelectionMode, setPageSelectionMode] = useState<"all" | "range">("all");

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
      // Convert 1-indexed page number to 0-indexed, then adjust for before/after
      const targetPageIndex = targetPageNumber - 1;
      const insertIndex = insertPosition === "before" ? targetPageIndex : targetPageIndex + 1;
      
      // Validate insert index
      const pageCount = currentDocument.getPageCount();
      if (insertIndex < 0 || insertIndex > pageCount) {
        showNotification(`Invalid insertion position. Must be between 1 and ${pageCount + 1}`, "error");
        return;
      }
      
      console.log(`Inserting blank page at index ${insertIndex}`);
      
      // Get current page dimensions from document
      let pageWidth = 612; // Default fallback
      let pageHeight = 792; // Default fallback
      
      const currentPageMetadata = currentDocument.getPageMetadata(currentPage);
      if (currentPageMetadata) {
        pageWidth = currentPageMetadata.width;
        pageHeight = currentPageMetadata.height;
        console.log(`Using current page dimensions: ${pageWidth}x${pageHeight}`);
      } else {
        // Fall back to first page if current page metadata unavailable
        const firstPageMetadata = currentDocument.getPageMetadata(0);
        if (firstPageMetadata) {
          pageWidth = firstPageMetadata.width;
          pageHeight = firstPageMetadata.height;
          console.log(`Using first page dimensions: ${pageWidth}x${pageHeight}`);
        } else {
          console.warn("No page metadata available, using default dimensions");
        }
      }
      
      await editor.insertBlankPage(currentDocument, insertIndex, pageWidth, pageHeight);
      
      // CRITICAL: Force reload the page in mupdf to clear its internal cache
      // This ensures the new page is visible immediately
      const mupdfDoc = currentDocument.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      if (pdfDoc) {
        // Force reload by loading the inserted page
        // This clears mupdf's internal page cache
        try {
          pdfDoc.loadPage(insertIndex);
          console.log(`Force reloaded page ${insertIndex} in mupdf`);
        } catch (reloadError) {
          console.warn("Could not force reload page after insertion:", reloadError);
        }
      }
      
      // Refresh document metadata to update page count and page info
      currentDocument.refreshPageMetadata();
      
      // Force a second refresh after a small delay to ensure thumbnails update
      // This triggers the thumbnail useEffect dependencies to refresh
      setTimeout(() => {
        currentDocument.refreshPageMetadata();
        // Force page reload again to ensure cache is cleared
        if (pdfDoc) {
          try {
            pdfDoc.loadPage(insertIndex);
          } catch (e) {
            // Ignore errors on second reload
          }
        }
      }, 100);
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDocument.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
      
      // Force store update to trigger re-render
      // Use a small delay to ensure metadata refresh completes first
      setTimeout(() => {
        usePDFStore.getState().setCurrentPage(insertIndex);
      }, 0);
      
      setShowInsertDialog(false);
      const positionText = insertPosition === "before" ? "before" : "after";
      showNotification(`Blank page inserted ${positionText} page ${targetPageNumber}`, "success");
      
      console.log(`Successfully inserted page. New page count: ${currentDocument.getPageCount()}`);
    } catch (error) {
      console.error("Error inserting page:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      showNotification(`Failed to insert page: ${errorMessage}`, "error");
    }
  };

  const handleInsertFromPDF = async () => {
    if (!currentDocument) {
      showNotification("No document is open", "error");
      return;
    }

    if (!editor) {
      showNotification("PDF editor is not initialized. Please try again.", "error");
      return;
    }

    if (!selectedSourceDocumentId) {
      showNotification("Please select a source PDF", "error");
      return;
    }

    const sourceDocument = documents.get(selectedSourceDocumentId);
    if (!sourceDocument) {
      showNotification("Source document not found", "error");
      return;
    }

    // Verify both documents are loaded
    if (!currentDocument.isDocumentLoaded()) {
      showNotification("Current document is not fully loaded", "error");
      return;
    }

    if (!sourceDocument.isDocumentLoaded()) {
      showNotification("Source document is not fully loaded", "error");
      return;
    }

    // Verify both documents are PDFs by checking if asPDF() works
    try {
      const currentMupdf = currentDocument.getMupdfDocument();
      const sourceMupdf = sourceDocument.getMupdfDocument();
      
      const currentPdf = currentMupdf.asPDF();
      const sourcePdf = sourceMupdf.asPDF();
      
      if (!currentPdf) {
        showNotification("Current document is not a valid PDF", "error");
        return;
      }
      
      if (!sourcePdf) {
        showNotification("Source document is not a valid PDF", "error");
        return;
      }
    } catch (error) {
      console.error("Error verifying PDF documents:", error);
      showNotification("Failed to verify PDF documents", "error");
      return;
    }

    try {
      // Convert 1-indexed page number to 0-indexed, then adjust for before/after
      const targetPageIndex = targetPageNumber - 1;
      const insertIndex = insertPosition === "before" ? targetPageIndex : targetPageIndex + 1;
      
      // Validate insert index
      const pageCount = currentDocument.getPageCount();
      if (insertIndex < 0 || insertIndex > pageCount) {
        showNotification(`Invalid insertion position. Must be between 1 and ${pageCount + 1}`, "error");
        return;
      }
      
      const sourcePageCount = sourceDocument.getPageCount();
      
      // Determine which pages to insert
      let pagesToInsert: number[];
      if (selectedPages === "all") {
        pagesToInsert = Array.from({ length: sourcePageCount }, (_, i) => i);
      } else if (pageSelectionMode === "range") {
        const start = Math.max(0, Math.min(pageRangeStart - 1, sourcePageCount - 1));
        const end = Math.max(start, Math.min(pageRangeEnd - 1, sourcePageCount - 1));
        pagesToInsert = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      } else {
        pagesToInsert = selectedPages;
      }

      if (pagesToInsert.length === 0) {
        showNotification("No pages selected", "error");
        return;
      }

      const documentId = currentDocument.getId();
      
      // Wrap with undo/redo
      await wrapPageOperation(
        async () => {
          await editor.insertPagesFromDocument(
            currentDocument,
            sourceDocument,
            insertIndex,
            pagesToInsert
          );

          // Refresh document metadata
          if (typeof (currentDocument as any).refreshPageMetadata === 'function') {
            (currentDocument as any).refreshPageMetadata();
          }

          // Remap annotations that are after the insertion point
          const existingAnnotations = getAnnotations(documentId);
          const insertedPageCount = pagesToInsert.length;
          
          const remappedAnnotations = existingAnnotations.map((ann) => {
            if (ann.pageNumber >= insertIndex) {
              return {
                ...ann,
                pageNumber: ann.pageNumber + insertedPageCount,
              };
            }
            return ann;
          });

          // Update annotations in store
          const pdfStore = usePDFStore.getState();
          const currentAnnotations = new Map(pdfStore.annotations);
          currentAnnotations.set(documentId, remappedAnnotations);
          usePDFStore.setState({ annotations: currentAnnotations });

          // Move to first inserted page
          setCurrentPage(insertIndex);
        },
        "insertPages",
        documentId,
        pagesToInsert,
        insertIndex,
        selectedSourceDocumentId
      );

      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(documentId);
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }

      setShowInsertDialog(false);
      const positionText = insertPosition === "before" ? "before" : "after";
      showNotification(
        `Inserted ${pagesToInsert.length} page${pagesToInsert.length > 1 ? "s" : ""} from "${sourceDocument.getName()}" ${positionText} page ${targetPageNumber}`,
        "success"
      );
    } catch (error) {
      console.error("Error inserting pages from PDF:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      showNotification(`Failed to insert pages: ${errorMessage}`, "error");
    }
  };

  const handleInsertConfirm = async () => {
    if (insertMode === "blank") {
      await handleInsertBlankPage();
    } else {
      await handleInsertFromPDF();
    }
  };

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (showInsertDialog) {
      setInsertMode("blank");
      setInsertPosition("after");
      // Set target page to current page + 1 (1-indexed) by default
      setTargetPageNumber(currentPage + 1);
      setSelectedSourceDocumentId(null);
      setSelectedPages("all");
      setPageSelectionMode("all");
      // Set default range to all pages of first available source document
      const otherDocs = Array.from(documents.values()).filter(
        (doc) => doc.getId() !== currentDocument?.getId()
      );
      if (otherDocs.length > 0) {
        const firstDoc = otherDocs[0];
        setPageRangeStart(1);
        setPageRangeEnd(firstDoc.getPageCount());
      }
    }
  }, [showInsertDialog, documents, currentDocument, currentPage]);

  // Get list of other open PDFs (excluding current document)
  const otherDocuments = Array.from(documents.values()).filter(
    (doc) => doc.getId() !== currentDocument?.getId()
  );

  // Update page range end when source document changes
  useEffect(() => {
    if (selectedSourceDocumentId) {
      const sourceDoc = documents.get(selectedSourceDocumentId);
      if (sourceDoc) {
        const pageCount = sourceDoc.getPageCount();
        setPageRangeEnd(Math.min(pageRangeEnd, pageCount));
        setPageRangeStart(Math.min(pageRangeStart, pageCount));
      }
    }
  }, [selectedSourceDocumentId, documents]);

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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Insert Page</DialogTitle>
            <DialogDescription>
              Insert page(s) at the selected position.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {/* Target Page Number Input */}
            <div className="space-y-2">
              <Label htmlFor="targetPage">Target Page Number</Label>
              <Input
                id="targetPage"
                type="number"
                min="1"
                max={currentDocument ? currentDocument.getPageCount() + 1 : 1}
                value={targetPageNumber}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 1;
                  const maxPage = currentDocument ? currentDocument.getPageCount() + 1 : 1;
                  setTargetPageNumber(Math.max(1, Math.min(maxPage, val)));
                }}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Current document has {currentDocument?.getPageCount() || 0} page{currentDocument?.getPageCount() !== 1 ? "s" : ""}. 
                You can insert at page 1 through {currentDocument ? currentDocument.getPageCount() + 1 : 1}.
              </p>
            </div>

            {/* Insert Position Selection */}
            <div className="space-y-2">
              <Label>Insert Position</Label>
              <RadioGroup 
                value={insertPosition} 
                onValueChange={(value) => setInsertPosition(value as "before" | "after")}
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="before" id="before" />
                  <Label htmlFor="before" className="cursor-pointer">
                    Before page {targetPageNumber}
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="after" id="after" />
                  <Label htmlFor="after" className="cursor-pointer">
                    After page {targetPageNumber}
                  </Label>
                </div>
              </RadioGroup>
              <p className="text-xs text-muted-foreground pl-6">
                {insertPosition === "before" 
                  ? `Pages will be inserted at position ${targetPageNumber} (before page ${targetPageNumber})`
                  : `Pages will be inserted at position ${targetPageNumber + 1} (after page ${targetPageNumber})`
                }
              </p>
            </div>

            {/* Insert Type Selection */}
            <div className="space-y-2">
              <Label>Insert Type</Label>
              <RadioGroup value={insertMode} onValueChange={(value) => setInsertMode(value as "blank" | "fromPdf")}>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="blank" id="blank" />
                  <Label htmlFor="blank" className="cursor-pointer">
                    Insert Blank Page
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="fromPdf" id="fromPdf" />
                  <Label htmlFor="fromPdf" className="cursor-pointer">
                    Insert from Other PDF
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {insertMode === "fromPdf" && (
              <div className="space-y-4 pl-6 border-l-2">
                {otherDocuments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No other PDFs are currently open.
                  </p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="sourceDocument">Source PDF</Label>
                      <Select
                        value={selectedSourceDocumentId || ""}
                        onValueChange={setSelectedSourceDocumentId}
                      >
                        <SelectTrigger id="sourceDocument">
                          <SelectValue placeholder="Select a PDF" />
                        </SelectTrigger>
                        <SelectContent>
                          {otherDocuments.map((doc) => (
                            <SelectItem key={doc.getId()} value={doc.getId()}>
                              {doc.getName()} ({doc.getPageCount()} page{doc.getPageCount() !== 1 ? "s" : ""})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {selectedSourceDocumentId && (
                      <div className="space-y-2">
                        <Label>Pages to Insert</Label>
                        <RadioGroup
                          value={pageSelectionMode}
                          onValueChange={(value) => setPageSelectionMode(value as "all" | "range")}
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="all" id="allPages" />
                            <Label htmlFor="allPages" className="cursor-pointer">
                              All Pages
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="range" id="pageRange" />
                            <Label htmlFor="pageRange" className="cursor-pointer">
                              Page Range
                            </Label>
                          </div>
                        </RadioGroup>

                        {pageSelectionMode === "range" && selectedSourceDocumentId && (
                          <div className="grid grid-cols-2 gap-2 pl-6">
                            <div className="space-y-1.5">
                              <Label htmlFor="rangeStart" className="text-xs">From Page</Label>
                              <Input
                                id="rangeStart"
                                type="number"
                                min="1"
                                max={documents.get(selectedSourceDocumentId)?.getPageCount() || 1}
                                value={pageRangeStart}
                                onChange={(e) => {
                                  const val = Math.max(1, Math.min(
                                    documents.get(selectedSourceDocumentId)?.getPageCount() || 1,
                                    parseInt(e.target.value) || 1
                                  ));
                                  setPageRangeStart(val);
                                  if (val > pageRangeEnd) {
                                    setPageRangeEnd(val);
                                  }
                                }}
                                className="h-9"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="rangeEnd" className="text-xs">To Page</Label>
                              <Input
                                id="rangeEnd"
                                type="number"
                                min={pageRangeStart}
                                max={documents.get(selectedSourceDocumentId)?.getPageCount() || 1}
                                value={pageRangeEnd}
                                onChange={(e) => {
                                  const maxPages = documents.get(selectedSourceDocumentId)?.getPageCount() || 1;
                                  const val = Math.max(pageRangeStart, Math.min(maxPages, parseInt(e.target.value) || pageRangeStart));
                                  setPageRangeEnd(val);
                                }}
                                className="h-9"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInsertDialog(false)}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleInsertConfirm}
              disabled={insertMode === "fromPdf" && (!selectedSourceDocumentId || otherDocuments.length === 0)}
            >
              <Plus className="h-4 w-4 mr-2" />
              {insertMode === "blank" ? "Insert Blank Page" : "Insert Pages"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

