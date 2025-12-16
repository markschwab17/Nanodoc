/**
 * Search Bar Component
 * 
 * Search input for PDF text search functionality.
 */

import { useState, useEffect } from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePDFStore } from "@/shared/stores/pdfStore";

interface SearchResult {
  pageNumber: number;
  quads: number[][]; // Array of quads for each match
  text: string;
}

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const { getCurrentDocument, setCurrentPage, setSearchResults, getSearchResults, currentSearchResult, setCurrentSearchResult } = usePDFStore();
  
  const results = getCurrentDocument() ? getSearchResults(getCurrentDocument()!.getId()) : [];
  const currentResultIndex = currentSearchResult;

  const currentDocument = getCurrentDocument();

  // Debounced search
  useEffect(() => {
    if (!currentDocument) return;
    
    if (!query.trim()) {
      setSearchResults(currentDocument.getId(), []);
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
      const allResults: SearchResult[] = [];

      for (let i = 0; i < pageCount; i++) {
        try {
          const page = mupdfDoc.loadPage(i);
          const matches = page.search(searchQuery, 100); // Max 100 matches per page

          if (matches && matches.length > 0) {
            allResults.push({
              pageNumber: i,
              quads: matches,
              text: searchQuery,
            });
          }
        } catch (error) {
          console.error(`Error searching page ${i}:`, error);
        }
      }

      if (currentDocument) {
        setSearchResults(currentDocument.getId(), allResults);
      }
    } catch (error) {
      console.error("Error performing search:", error);
      if (currentDocument) {
        setSearchResults(currentDocument.getId(), []);
      }
    } finally {
      setIsSearching(false);
    }
  };

  const handleNext = () => {
    if (results.length === 0) return;
    const nextIndex = (currentResultIndex + 1) % results.length;
    setCurrentSearchResult(nextIndex);
    navigateToResult(nextIndex);
  };

  const handlePrevious = () => {
    if (results.length === 0) return;
    const prevIndex = currentResultIndex <= 0 ? results.length - 1 : currentResultIndex - 1;
    setCurrentSearchResult(prevIndex);
    navigateToResult(prevIndex);
  };

  const navigateToResult = (index: number) => {
    if (index < 0 || index >= results.length) return;
    const result = results[index];
    setCurrentPage(result.pageNumber);
    // TODO: Scroll to and highlight the result
  };

  const handleClear = () => {
    setQuery("");
    if (currentDocument) {
      setSearchResults(currentDocument.getId(), []);
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
          placeholder="Search page number or page label"
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

      {(results.length > 0 || isSearching) && (
        <div className="flex items-center gap-2">
          {results.length > 0 && (
            <>
              <div className="text-xs text-muted-foreground flex-1">
                {currentResultIndex + 1} of {results.length}
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={handlePrevious}
                disabled={results.length === 0}
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={handleNext}
                disabled={results.length === 0}
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

