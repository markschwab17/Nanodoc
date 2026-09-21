/**
 * The one save in takeoff-v2 mode: confirm adding the composed site sheet to
 * the CTO project as a new page.
 *
 * Everything the user is about to change is named up front — the page that will
 * appear (under the title CTO will actually give it), the source sheets that
 * will drop out of the page list, and the scale the sheet carries — because the
 * page-list change is the surprising half and it happens somewhere the user
 * isn't looking. It is reversible, and the chip says so.
 *
 * Rows the session can't fill are omitted rather than shown empty: a planless
 * session knows no page numbers, and an uncalibrated composition has no scale.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { siteSheetTitlePreview, hiddenPagesSentence } from "./addToProjectCopy";

export interface AddToProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** CTO's project name (`project_name` URL param); falls back to "this project". */
  projectName?: string | null;
  /** Labels of the plan entries that still have a tile, in tile order. */
  labels: readonly (string | null | undefined)[];
  /** Sheets on the canvas — the count CTO's own title falls back to. */
  sheetCount: number;
  /** 1-based page-list numbers of the takeoff sources that will be hidden. */
  hiddenPageNumbers: readonly number[];
  /** Whole feet per inch the composition ACTUALLY reads at — the reference scale
   *  divided by the composition scale factor, rounded as the toolbar rounds it.
   *  Null when the composition is uncalibrated, which omits the row. */
  effectiveScaleFeetPerInch: number | null;
  /** True while the save is in flight: both buttons go dead, the dialog cannot
   *  be dismissed out from under the upload, and the primary reads "Adding…". */
  busy?: boolean;
  onConfirm: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <span className="w-[110px] shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="flex flex-1 flex-wrap items-center gap-2 text-sm text-foreground">
        {children}
      </span>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-full border border-border bg-background px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

export function AddToProjectDialog({
  open,
  onOpenChange,
  projectName,
  labels,
  sheetCount,
  hiddenPageNumbers,
  effectiveScaleFeetPerInch,
  busy,
  onConfirm,
}: AddToProjectDialogProps) {
  const title = siteSheetTitlePreview(labels, sheetCount);
  const hidden = hiddenPagesSentence(hiddenPageNumbers);
  const project = projectName?.trim() ? projectName.trim() : "this project";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Add to project</DialogTitle>
        </DialogHeader>
        <p className="pb-2 text-sm text-muted-foreground">
          Adds this site sheet as a new page in <b className="text-foreground">{project}</b>.
          Snapping and the PNG render are prepared automatically.
        </p>
        <div>
          <Row label="New page">
            <span>{title}</span>
            <Chip>
              {sheetCount} sheet{sheetCount === 1 ? "" : "s"}
            </Chip>
          </Row>
          {hidden && (
            <Row label="Source sheets">
              <span>{hidden}</span>
              <Chip>reversible</Chip>
            </Row>
          )}
          {effectiveScaleFeetPerInch != null && (
            <Row label="Scale">
              <span>1&quot; = {effectiveScaleFeetPerInch}&#39;</span>
            </Row>
          )}
        </div>
        <DialogFooter className="gap-2 pt-2 sm:gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Keep arranging
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? "Adding…" : "Add to project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
