/**
 * Search Bar Component
 * 
 * Search input for PDF text search functionality.
 * Allows navigating through individual search matches with highlighting.
 */

import { useState, useEffect } from "react";
import { Search, X, ChevronUp, ChevronDown, CaseSensitive, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePDFStore, type SearchMatch, type SearchResultData } from "@/shared/stores/pdfStore";

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [searchAnnotations, setSearchAnnotations] = useState(false);
  const {
    getCurrentDocument,
    setCurrentPage,
    setSearchResults,
    getSearchResults,
    getAnnotations,
    currentSearchResult,
    setCurrentSearchResult
  } = usePDFStore();
  
  const currentDocument = getCurrentDocument();
  const searchData = currentDocument ? getSearchResults(currentDocument.getId()) : null;
  const totalMatches = searchData?.matches.length ?? 0;
  const currentResultIndex = currentSearchResult;

  // Debounced search
  useEffect(() => {
    if (!currentDocument) return;
    
    if (!query.trim()) {
      setSearchResults(currentDocument.getId(), { matches: [], query: "" });
      setCurrentSearchResult(-1);
      return;
    }

    const timeoutId = setTimeout(async () => {
      await performSearch(query);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [query, currentDocument, caseSensitive, searchAnnotations, setSearchResults, setCurrentSearchResult]);

  const performSearch = async (searchQuery: string) => {
    if (!currentDocument) return;

    setIsSearching(true);
    try {
      const mupdfDoc = currentDocument.getMupdfDocument();
      const pageCount = currentDocument.getPageCount();
      const allMatches: SearchMatch[] = [];
      let matchIndex = 0;

      for (let i = 0; i < pageCount; i++) {
        try {
          const page = mupdfDoc.loadPage(i);
          const matches = page.search(searchQuery, 100); // Max 100 matches per page

          if (matches && matches.length > 0) {
            if (caseSensitive) {
              // mupdf search is case-insensitive; extract page text and verify case
              const pageText: string = page.toSText("text") ?? "";
              for (const quad of matches) {
                // Check if the exact-case query exists on this page
                if (pageText.includes(searchQuery)) {
                  allMatches.push({
                    pageNumber: i,
                    quad: quad,
                    text: searchQuery,
                    matchIndex: matchIndex++,
                  });
                }
              }
            } else {
              // Flatten: create one SearchMatch per quad
              for (const quad of matches) {
                allMatches.push({
                  pageNumber: i,
                  quad: quad,
                  text: searchQuery,
                  matchIndex: matchIndex++,
                });
              }
            }
          }
        } catch (error) {
          console.error(`Error searching page ${i}:`, error);
        }
      }

      // Search in annotations if enabled
      if (searchAnnotations) {
        const docId = currentDocument.getId();
        const annotations = getAnnotations(docId);
        for (const annotation of annotations) {
          const content = annotation.content ?? "";
          const selectedText = annotation.selectedText ?? "";
          const textToSearch = content || selectedText;
          if (!textToSearch) continue;

          const matches = caseSensitive
            ? textToSearch.includes(searchQuery)
            : textToSearch.toLowerCase().includes(searchQuery.toLowerCase());

          if (matches) {
            // Use annotation position as a synthetic quad
            const x = annotation.x;
            const y = annotation.y;
            const w = annotation.width ?? 100;
            const h = annotation.height ?? 20;
            allMatches.push({
              pageNumber: annotation.pageNumber,
              quad: [[x, y, x + w, y, x + w, y + h, x, y + h]],
              text: searchQuery,
              matchIndex: matchIndex++,
            });
          }
        }
      }

      if (currentDocument) {
        const resultData: SearchResultData = {
          matches: allMatches,
          query: searchQuery,
        };
        setSearchResults(currentDocument.getId(), resultData);
      }
    } catch (error) {
      console.error("Error performing search:", error);
      if (currentDocument) {
        setSearchResults(currentDocument.getId(), { matches: [], query: "" });
      }
    } finally {
      setIsSearching(false);
    }
  };

  const handleNext = () => {
    if (totalMatches === 0) return;
    const nextIndex = (currentResultIndex + 1) % totalMatches;
    setCurrentSearchResult(nextIndex);
    navigateToResult(nextIndex);
  };

  const handlePrevious = () => {
    if (totalMatches === 0) return;
    const prevIndex = currentResultIndex <= 0 ? totalMatches - 1 : currentResultIndex - 1;
    setCurrentSearchResult(prevIndex);
    navigateToResult(prevIndex);
  };

  const navigateToResult = (index: number) => {
    if (!searchData || index < 0 || index >= searchData.matches.length) return;
    const match = searchData.matches[index];
    setCurrentPage(match.pageNumber);
  };

  const handleClear = () => {
    setQuery("");
    if (currentDocument) {
      setSearchResults(currentDocument.getId(), { matches: [], query: "" });
    }
    setCurrentSearchResult(-1);
  };

  if (!currentDocument) return null;

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="relative w-full">
        <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search text in document"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8 pr-8 w-full"
        />
        {query && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 transform -translate-y-1/2 h-6 w-6"
            onClick={handleClear}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant={caseSensitive ? "secondary" : "ghost"}
          size="icon"
          className="h-7 w-7"
          onClick={() => setCaseSensitive((v) => !v)}
          title="Case sensitive"
        >
          <CaseSensitive className="h-4 w-4" />
        </Button>
        <Button
          variant={searchAnnotations ? "secondary" : "ghost"}
          size="icon"
          className="h-7 w-7"
          onClick={() => setSearchAnnotations((v) => !v)}
          title="Search in annotations"
        >
          <StickyNote className="h-3.5 w-3.5" />
        </Button>

        {totalMatches > 0 && (
          <>
            <div className="text-xs text-muted-foreground flex-1 ml-1">
              {currentResultIndex + 1} of {totalMatches}
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={handlePrevious}
              disabled={totalMatches === 0}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={handleNext}
              disabled={totalMatches === 0}
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </>
        )}
        {isSearching && (
          <div className="text-xs text-muted-foreground ml-1">Searching...</div>
        )}
      </div>
    </div>
  );
}

