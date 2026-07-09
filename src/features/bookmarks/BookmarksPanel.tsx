/**
 * Bookmarks Panel Component
 * 
 * Displays list of bookmarks for the current document.
 */

import { useEffect, useState } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { BookmarkItem } from "./BookmarkItem";
import { PDFBookmarks } from "@/core/pdf/PDFBookmarks";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BookmarksPanel() {
  const { getCurrentDocument, getBookmarks, addBookmark, setCurrentPage } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const [pdfBookmarks, setPdfBookmarks] = useState<PDFBookmarks | null>(null);
  const [appBookmarks, setAppBookmarks] = useState<any[]>([]);

  useEffect(() => {
    const initBookmarks = async () => {
      const mupdfModule = await import("mupdf");
      setPdfBookmarks(new PDFBookmarks(mupdfModule.default));
    };
    initBookmarks();
  }, []);

  useEffect(() => {
    const loadBookmarks = async () => {
      if (!currentDocument || !pdfBookmarks) return;

      // Load PDF native bookmarks
      const nativeBookmarks = await pdfBookmarks.getPDFBookmarks(currentDocument);
      
      // Get app state bookmarks
      const stateBookmarks = getBookmarks(currentDocument.getId());
      
      // Combine and deduplicate by page number and title
      const allBookmarks = [...nativeBookmarks, ...stateBookmarks];
      const uniqueBookmarks = allBookmarks.filter((bookmark, index, self) =>
        index === self.findIndex((b) => 
          b.pageNumber === bookmark.pageNumber && b.title === bookmark.title
        )
      );
      
      setAppBookmarks(uniqueBookmarks);
    };

    loadBookmarks();
  }, [currentDocument, pdfBookmarks, getBookmarks]);

  const handleAddBookmark = () => {
    if (!currentDocument) return;

    const bookmark = {
      id: `bookmark_${Date.now()}`,
      pageNumber: usePDFStore.getState().currentPage,
      title: `Page ${usePDFStore.getState().currentPage + 1}`,
      created: new Date(),
    };

    addBookmark(currentDocument.getId(), bookmark);
    setAppBookmarks([...appBookmarks, bookmark]);
  };

  const handleBookmarkClick = (pageNumber: number) => {
    setCurrentPage(pageNumber);
  };

  if (!currentDocument) {
    return null;
  }

  // Rendered as the "Bookmarks" tab content inside ThumbnailCarousel's shared
  // ScrollArea, so this only lays out the header row + list (no scroll wrapper
  // or collapsible chrome of its own).
  return (
    <div className="flex flex-col p-3 gap-2">
      {/* Header row: count + add-current-page */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {appBookmarks.length} bookmark{appBookmarks.length === 1 ? "" : "s"}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5"
          onClick={handleAddBookmark}
          title="Bookmark current page"
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {/* List */}
      {appBookmarks.length === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-8">
          No bookmarks yet
        </div>
      ) : (
        <div className="flex flex-col">
          {appBookmarks.map((bookmark) => (
            <BookmarkItem
              key={bookmark.id}
              bookmark={bookmark}
              onClick={() => handleBookmarkClick(bookmark.pageNumber)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

