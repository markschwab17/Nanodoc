/**
 * Search Bar Component
 * 
 * Search input for PDF text search functionality.
 * Allows navigating through individual search matches with highlighting.
 */

import { useState, useEffect } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePDFStore, type SearchMatch, type SearchResultData } from "@/shared/stores/pdfStore";

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const { 
    getCurrentDocument, 
    setCurrentPage, 
    setSearchResults, 
    getSearchResults, 
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
  }, [query, currentDocument, setSearchResults, setCurrentSearchResult]);

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
        } catch (error) {
          console.error(`Error searching page ${i}:`, error);
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

      {(totalMatches > 0 || isSearching) && (
        <div className="flex items-center gap-2">
          {totalMatches > 0 && (
            <>
              <div className="text-xs text-muted-foreground flex-1">
                {currentResultIndex + 1} of {totalMatches} matches
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
            <div className="text-xs text-muted-foreground">Searching...</div>
          )}
        </div>
      )}
    </div>
  );
}

