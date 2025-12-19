/**
 * Bookmark Item Component
 * 
 * Individual bookmark in the bookmarks list.
 */

import { Bookmark } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Bookmark as BookmarkType } from "@/core/pdf/PDFBookmarks";

interface BookmarkItemProps {
  bookmark: BookmarkType;
  onClick: () => void;
}

export function BookmarkItem({ bookmark, onClick }: BookmarkItemProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-muted transition-colors"
      )}
      onClick={onClick}
    >
      <Bookmark className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{bookmark.title}</div>
        {bookmark.text && (
          <div className="text-xs text-muted-foreground truncate">
            {bookmark.text}
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          Page {bookmark.pageNumber + 1}
        </div>
      </div>
    </div>
  );
}












