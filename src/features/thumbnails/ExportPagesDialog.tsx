/**
 * Export Selected Pages dialog.
 *
 * Builds a new PDF from the selected thumbnails (document order, annotations
 * baked) and saves it either to the device (Save As picker / native dialog in
 * Tauri) or back into CivilTakeoff's documents area with a target-folder
 * picker. The CTO destination only appears when nanodoc was opened from CTO;
 * the folder picker only appears when the CTO deployment supports it.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FolderIcon, HardDrive, Loader2, UploadCloud } from "lucide-react";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { PDFEditor } from "@/core/pdf/PDFEditor";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import {
  fetchCtoDocumentFolders,
  saveCurrentPdfToCto,
  type CtoDocumentFolder,
} from "@/features/toolbar/saveToCto";
import { postToCtoParent } from "@/shared/ctoBridge";
import { buildExportFileName, formatPageRanges } from "./exportSelection";

interface ExportPagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: PDFDocument;
  editor: PDFEditor;
  /** 0-based page indices to export (any order; exported in document order). */
  pages: number[];
}

type Destination = "device" | "civiltakeoff";

/** Flatten the folder tree into indented <select> options, parents first. */
function flattenFolders(
  folders: CtoDocumentFolder[],
  parentId: string | null = null,
  depth = 0
): Array<{ id: string; label: string }> {
  return folders
    .filter((f) => (f.parent_folder_id ?? null) === parentId)
    .sort(
      (a, b) =>
        (a.display_order ?? 0) - (b.display_order ?? 0) ||
        a.name.localeCompare(b.name)
    )
    .flatMap((f) => [
      { id: f.id, label: `${"  ".repeat(depth)}${f.name}` },
      ...flattenFolders(folders, f.id, depth + 1),
    ]);
}

export function ExportPagesDialog({
  open,
  onOpenChange,
  document,
  editor,
  pages,
}: ExportPagesDialogProps) {
  const { getAnnotations } = usePDFStore();
  const { showNotification } = useNotificationStore();
  const ctoContext = useCiviltakeoffContextStore((s) => s.context);
  const fileSystem = useFileSystem();

  const sortedPages = useMemo(
    () => [...new Set(pages)].sort((a, b) => a - b),
    [pages]
  );
  const [fileName, setFileName] = useState("");
  const [destination, setDestination] = useState<Destination>("device");
  const [folders, setFolders] = useState<CtoDocumentFolder[] | null>(null);
  const [folderId, setFolderId] = useState<string>("");
  const [exporting, setExporting] = useState(false);

  // Reset per open: fresh default name, default destination, fresh folders.
  useEffect(() => {
    if (!open) return;
    setFileName(buildExportFileName(document.getName(), sortedPages));
    setDestination("device");
    setFolderId("");
    setExporting(false);
  }, [open, document, sortedPages]);

  // Load the CTO folder list lazily, once per dialog open.
  useEffect(() => {
    if (!open || !ctoContext) return;
    let cancelled = false;
    setFolders(null);
    fetchCtoDocumentFolders(ctoContext)
      .then((list) => {
        if (!cancelled) setFolders(list);
      })
      .catch((error) => {
        console.error("Failed to load Pursuit folders:", error);
        if (!cancelled) setFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, ctoContext]);

  const folderOptions = useMemo(
    () => (folders ? flattenFolders(folders) : []),
    [folders]
  );

  const handleExport = async () => {
    const trimmed = fileName.trim();
    if (!trimmed) {
      showNotification("Enter a file name for the export", "error");
      return;
    }
    const finalName = trimmed.toLowerCase().endsWith(".pdf")
      ? trimmed
      : `${trimmed}.pdf`;

    setExporting(true);
    try {
      const annotations = getAnnotations(document.getId());
      const pdfData = await editor.exportPagesAsPDF(
        document,
        sortedPages,
        annotations
      );

      if (destination === "civiltakeoff" && ctoContext) {
        const { fileId } = await saveCurrentPdfToCto({
          pdfData,
          ctx: ctoContext,
          fileName: finalName,
          saveDestination: "new_file",
          displayName: finalName.replace(/\.pdf$/i, ""),
          folderId: folderId || null,
        });
        showNotification(
          `Saved ${sortedPages.length} page${sortedPages.length > 1 ? "s" : ""} to Pursuit`,
          "success"
        );
        // Tell the embedding documents page to refresh its file list so the
        // new document appears without a manual reload. The fileId lets it
        // poll until the new row is actually visible (read replicas lag).
        postToCtoParent(
          { type: "nanodoc-file-saved", success: true, fileId },
          ctoContext.api_origin
        );
      } else {
        await fileSystem.saveFile(pdfData, finalName);
        showNotification(
          `Exported ${sortedPages.length} page${sortedPages.length > 1 ? "s" : ""}`,
          "success"
        );
      }
      onOpenChange(false);
    } catch (error) {
      console.error("Error exporting selected pages:", error);
      showNotification(
        error instanceof Error ? error.message : "Failed to export pages",
        "error"
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !exporting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export selected pages</DialogTitle>
          <DialogDescription>
            Create a new PDF from page{sortedPages.length > 1 ? "s" : ""}{" "}
            {formatPageRanges(sortedPages).replace(/_/g, ", ")} of{" "}
            {document.getName()}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-pages-name">File name</Label>
            <Input
              id="export-pages-name"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleExport();
              }}
              disabled={exporting}
            />
          </div>

          {ctoContext && (
            <div className="flex flex-col gap-1.5">
              <Label>Destination</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDestination("device")}
                  disabled={exporting}
                  className={cn(
                    "flex items-center gap-2 rounded-md border-2 p-2.5 text-sm transition-colors",
                    destination === "device"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <HardDrive className="h-4 w-4 shrink-0" />
                  This device
                </button>
                <button
                  type="button"
                  onClick={() => setDestination("civiltakeoff")}
                  disabled={exporting}
                  className={cn(
                    "flex items-center gap-2 rounded-md border-2 p-2.5 text-sm transition-colors",
                    destination === "civiltakeoff"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <UploadCloud className="h-4 w-4 shrink-0" />
                  Pursuit
                </button>
              </div>
            </div>
          )}

          {destination === "civiltakeoff" && ctoContext && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export-pages-folder">Folder</Label>
              {folders === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-1.5">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading folders…
                </div>
              ) : (
                <div className="relative">
                  <FolderIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <select
                    id="export-pages-folder"
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    disabled={exporting}
                    className="w-full h-9 rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Documents (root)</option>
                    {folderOptions.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={exporting}
          >
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={exporting}>
            {exporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting…
              </>
            ) : destination === "civiltakeoff" ? (
              "Save to Pursuit"
            ) : (
              "Save As…"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
