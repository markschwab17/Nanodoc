/**
 * Flatten Dialog Component
 * 
 * Dialog for flattening PDF annotations permanently
 */

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertTriangle } from "lucide-react";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { PDFEditor } from "@/core/pdf/PDFEditor";

interface FlattenDialogProps {
  open: boolean;
  onClose: () => void;
  document: PDFDocument | null;
  editor: PDFEditor | null;
  annotationCount: number;
  currentPage: number;
  onFlatten: (currentPageOnly: boolean) => Promise<void>;
}

export function FlattenDialog({
  open,
  onClose,
  document,
  editor,
  annotationCount,
  currentPage,
  onFlatten,
}: FlattenDialogProps) {
  const [currentPageOnly, setCurrentPageOnly] = useState(false);
  const [isFlattening, setIsFlattening] = useState(false);

  const handleFlatten = async () => {
    if (!document || !editor) return;

    setIsFlattening(true);
    try {
      await onFlatten(currentPageOnly);
      onClose();
    } catch (error) {
      console.error("Error flattening document:", error);
      alert("Failed to flatten document. See console for details.");
    } finally {
      setIsFlattening(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Flatten Document</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Warning message */}
          <div className="flex gap-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold mb-1">Warning: This action cannot be undone</p>
              <p>
                Flattening will permanently merge all annotations into the page content.
                After flattening:
              </p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Annotations cannot be edited or removed</li>
                <li>Form fields become non-interactive</li>
                <li>Text and drawings become part of the page</li>
              </ul>
            </div>
          </div>

          {/* Annotation count */}
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
            <p className="text-sm text-blue-900">
              <span className="font-semibold">Annotations to flatten:</span> {annotationCount}
            </p>
          </div>

          {/* Options */}
          <div className="space-y-3">
            <Label className="text-base font-semibold">Flatten Options</Label>
            
            <div className="space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={!currentPageOnly}
                  onChange={() => setCurrentPageOnly(false)}
                  className="mt-1"
                />
                <div>
                  <div className="font-medium">All Pages</div>
                  <div className="text-sm text-gray-600">
                    Flatten annotations on all pages in the document
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  checked={currentPageOnly}
                  onChange={() => setCurrentPageOnly(true)}
                  className="mt-1"
                />
                <div>
                  <div className="font-medium">Current Page Only</div>
                  <div className="text-sm text-gray-600">
                    Flatten annotations on page {currentPage + 1} only
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Recommendation */}
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-md">
            <p className="text-sm text-gray-700">
              <span className="font-semibold">Recommendation:</span> Save a backup copy of your
              document before flattening, or use "Save As" after flattening to preserve the
              original.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button onClick={onClose} variant="outline" disabled={isFlattening}>
            Cancel
          </Button>
          <Button
            onClick={handleFlatten}
            variant="destructive"
            disabled={isFlattening || !document || !editor}
          >
            {isFlattening ? "Flattening..." : "Flatten Document"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

