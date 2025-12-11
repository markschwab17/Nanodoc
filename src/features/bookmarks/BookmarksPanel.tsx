/**
 * Bookmarks Panel Component
 * 
 * Displays list of bookmarks for the current document.
 */

import { useEffect, useState } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { BookmarkItem } from "./BookmarkItem";
import { PDFBookmarks } from "@/core/pdf/PDFBookmarks";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BookmarkPlus, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function BookmarksPanel() {
  const { getCurrentDocument, getBookmarks, addBookmark, setCurrentPage } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const [pdfBookmarks, setPdfBookmarks] = useState<PDFBookmarks | null>(null);
  const [appBookmarks, setAppBookmarks] = useState<any[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);

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

  return (
    <div className={cn(
      "flex flex-col border-t bg-background transition-all duration-300",
      isExpanded ? "max-h-[50vh]" : "max-h-[40px]"
    )}>
      {/* Header - always visible */}
      <div className="p-2 border-b bg-background flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2 flex-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? "Collapse bookmarks" : "Expand bookmarks"}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronUp className="h-4 w-4" />
            )}
          </Button>
          <h2 className="text-sm font-semibold">Bookmarks</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleAddBookmark}
          title="Bookmark current page"
        >
          <BookmarkPlus className="h-4 w-4" />
        </Button>
      </div>
      
      {/* Content - expands/collapses */}
      {isExpanded && (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-2">
            {appBookmarks.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">
                No bookmarks yet
              </div>
            ) : (
              appBookmarks.map((bookmark) => (
                <BookmarkItem
                  key={bookmark.id}
                  bookmark={bookmark}
                  onClick={() => handleBookmarkClick(bookmark.pageNumber)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

