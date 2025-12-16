/**
 * Export Dialog
 * 
 * Provides UI for exporting PDFs to different formats (PNG, JPEG, TXT).
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { PDFDocument } from "@/core/pdf/PDFDocument";
import { PDFConverter, type ExportFormat, type ConvertOptions } from "@/core/pdf/PDFConverter";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { Download, Loader2 } from "lucide-react";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: PDFDocument | null;
}

export function ExportDialog({
  open,
  onOpenChange,
  document,
}: ExportDialogProps) {
  const fileSystem = useFileSystem();
  const { showNotification } = useNotificationStore();
  const [format, setFormat] = useState<ExportFormat>("png");
  const [dpi, setDpi] = useState<number>(150);
  const [jpegQuality, setJpegQuality] = useState<number>(0.9);
  const [webpQuality, setWebpQuality] = useState<number>(0.9);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [converter, setConverter] = useState<PDFConverter | null>(null);

  // Initialize converter when dialog opens
  useEffect(() => {
    if (open && !converter) {
      const initConverter = async () => {
        try {
          const mupdfModule = await import("mupdf");
          const newConverter = new PDFConverter(mupdfModule.default);
          setConverter(newConverter);
        } catch (error) {
          console.error("Error initializing converter:", error);
          showNotification("Failed to initialize converter", "error");
        }
      };
      initConverter();
    }
  }, [open, converter, showNotification]);

  const handleExport = async () => {
    if (!document || !converter) {
      showNotification("No document or converter available", "error");
      return;
    }

    setIsExporting(true);
    setProgress({ current: 0, total: document.getPageCount() });

    try {
      const options: ConvertOptions = {
        dpi,
        jpegQuality: format === "jpeg" ? jpegQuality : undefined,
        webpQuality: format === "webp" ? webpQuality : undefined,
      };

      let convertedPages;
      
      if (format === "png") {
        convertedPages = await converter.convertToPNG(document, options);
      } else if (format === "jpeg") {
        convertedPages = await converter.convertToJPEG(document, options);
      } else if (format === "webp") {
        convertedPages = await converter.convertToWebP(document, options);
      } else if (format === "tiff") {
        convertedPages = await converter.convertToTIFF(document, options);
      } else if (format === "bmp") {
        convertedPages = await converter.convertToBMP(document, options);
      } else if (format === "svg") {
        convertedPages = await converter.convertToSVG(document, options);
      } else if (format === "html") {
        convertedPages = await converter.convertToHTML(document, options);
      } else if (format === "txt") {
        convertedPages = await converter.convertToTXT(document, options);
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      setProgress({ current: document.getPageCount(), total: document.getPageCount() });

      // Handle export based on format
      const baseName = document.getName().replace(/\.pdf$/i, "");
      
      if (format === "txt" || format === "html") {
        // Single text/HTML file
        const textData = convertedPages[0].data as string;
        const extension = format === "txt" ? "txt" : "html";
        await fileSystem.saveTextFile(textData, `${baseName}.${extension}`);
        showNotification(`${format.toUpperCase()} file exported successfully`, "success");
      } else if (format === "svg") {
        // SVG files - can be single or multiple
        if (convertedPages.length === 1) {
          const svgData = convertedPages[0].data as string;
          await fileSystem.saveTextFile(svgData, convertedPages[0].fileName);
          showNotification("SVG file exported successfully", "success");
        } else {
          // Multiple SVG files - save as ZIP
          const files = convertedPages.map((page) => {
            const encoder = new TextEncoder();
            return {
              data: encoder.encode(page.data as string),
              name: page.fileName,
            };
          });
          await fileSystem.saveMultipleFilesAsZip(files, `${baseName}_export`);
          showNotification(`${convertedPages.length} SVG pages exported`, "success");
        }
      } else {
        // Multiple image files - save as ZIP
        const files = convertedPages.map((page) => ({
          data: page.data as Uint8Array,
          name: page.fileName,
        }));
        
        await fileSystem.saveMultipleFilesAsZip(files, `${baseName}_export`);
        showNotification(`${convertedPages.length} pages exported as ${format.toUpperCase()}`, "success");
      }

      onOpenChange(false);
    } catch (error) {
      console.error("Error exporting:", error);
      showNotification(`Failed to export: ${error instanceof Error ? error.message : "Unknown error"}`, "error");
    } finally {
      setIsExporting(false);
      setProgress(null);
    }
  };

  const pageCount = document?.getPageCount() || 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Export PDF</DialogTitle>
          <DialogDescription>
            Export your PDF to different file formats. {pageCount > 0 && `${pageCount} page${pageCount !== 1 ? "s" : ""} will be exported.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Format Selection */}
          <div className="space-y-2">
            <Label htmlFor="format">Export Format</Label>
            <Select
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
              disabled={isExporting}
            >
              <SelectTrigger id="format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">PNG (High Quality)</SelectItem>
                <SelectItem value="jpeg">JPEG (Compressed)</SelectItem>
                <SelectItem value="webp">WebP (Modern Format)</SelectItem>
                <SelectItem value="tiff">TIFF (Archival)</SelectItem>
                <SelectItem value="bmp">BMP (Bitmap)</SelectItem>
                <SelectItem value="svg">SVG (Vector)</SelectItem>
                <SelectItem value="html">HTML (Web Page)</SelectItem>
                <SelectItem value="txt">TXT (Plain Text)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* DPI Setting (for images) */}
          {(format === "png" || format === "jpeg" || format === "webp" || format === "tiff" || format === "bmp" || format === "svg") && (
            <div className="space-y-2">
              <Label htmlFor="dpi">Resolution (DPI)</Label>
              <Select
                value={dpi.toString()}
                onValueChange={(value) => setDpi(parseInt(value, 10))}
                disabled={isExporting}
              >
                <SelectTrigger id="dpi">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="72">72 DPI (Screen Quality)</SelectItem>
                  <SelectItem value="150">150 DPI (Standard)</SelectItem>
                  <SelectItem value="300">300 DPI (Print Quality)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* JPEG Quality Setting */}
          {format === "jpeg" && (
            <div className="space-y-2">
              <Label htmlFor="quality">JPEG Quality: {Math.round(jpegQuality * 100)}%</Label>
              <Slider
                id="quality"
                min={0.5}
                max={1.0}
                step={0.05}
                value={[jpegQuality]}
                onValueChange={(values) => setJpegQuality(values[0])}
                disabled={isExporting}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Lower Size</span>
                <span>Higher Quality</span>
              </div>
            </div>
          )}

          {/* WebP Quality Setting */}
          {format === "webp" && (
            <div className="space-y-2">
              <Label htmlFor="webp-quality">WebP Quality: {Math.round(webpQuality * 100)}%</Label>
              <Slider
                id="webp-quality"
                min={0.5}
                max={1.0}
                step={0.05}
                value={[webpQuality]}
                onValueChange={(values) => setWebpQuality(values[0])}
                disabled={isExporting}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Lower Size</span>
                <span>Higher Quality</span>
              </div>
            </div>
          )}

          {/* Progress Indicator */}
          {isExporting && progress && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Exporting...</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isExporting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={isExporting || !document || !converter}
          >
            {isExporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

