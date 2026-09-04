/**
 * The step strip shown above the toolbar when the stitch editor is embedded in
 * CTO's takeoff panel (site-sheet builder, `embed=1`).
 *
 * The user arrives here mid-flow — CTO already picked the sheets and this view
 * already placed them — so the strip's job is to say where they are (step 2 of
 * 3), what is left to do (sheets still needing a home), and where the one exit
 * is. Step 3 is marked optional because trimming title blocks is a nicety, not
 * a gate: "Add to project" is live from the moment there is a sheet on the
 * canvas.
 */

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface TakeoffModeStripProps {
  /** Sheets currently on the canvas (scale stamps excluded). */
  sheetCount: number;
  /** Sheets the last auto-align run could not place; 0 once dismissed. */
  unplacedCount: number;
  /** False when there is nothing to add — the primary action goes disabled. */
  canAdd: boolean;
  onAddToProject: () => void;
}

/** One step pill. `state` drives the marker and whether it reads as current. */
function Step({
  state,
  marker,
  label,
  suffix,
}: {
  state: "done" | "now" | "todo";
  marker: React.ReactNode;
  label: string;
  suffix?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3.5 h-full border-b-2 text-xs font-medium ${
        state === "now"
          ? "text-foreground border-primary"
          : "text-muted-foreground border-transparent"
      }`}
      aria-current={state === "now" ? "step" : undefined}
    >
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] text-[10px] font-bold ${
          state === "done"
            ? "border-emerald-600 bg-emerald-600 text-white"
            : state === "now"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border"
        }`}
        aria-hidden
      >
        {marker}
      </span>
      <span className="whitespace-nowrap">
        {label}
        {suffix ? <span className="font-normal text-muted-foreground">{suffix}</span> : null}
      </span>
    </div>
  );
}

export function TakeoffModeStrip({
  sheetCount,
  unplacedCount,
  canAdd,
  onAddToProject,
}: TakeoffModeStripProps) {
  // While anything is unplaced that is the only number worth showing — the
  // sheet count is reassurance, the unplaced count is a task.
  const arrangeSuffix =
    unplacedCount > 0
      ? ` · ${unplacedCount} need${unplacedCount === 1 ? "s" : ""} placing`
      : ` · ${sheetCount} sheet${sheetCount === 1 ? "" : "s"}`;

  return (
    <nav
      aria-label="Site sheet steps"
      className="flex h-[52px] shrink-0 items-center gap-0 border-b border-border bg-background px-4"
    >
      <Step state="done" marker={<Check className="h-2.5 w-2.5 stroke-[3]" />} label="Sheets chosen" />
      <Step state="now" marker="2" label="Arrange" suffix={arrangeSuffix} />
      <Step state="todo" marker="3" label="Trim title blocks" suffix=" · optional" />
      <span className="flex-1" />
      <Button
        size="sm"
        className="h-8 shrink-0"
        disabled={!canAdd}
        title={canAdd ? "Add this site sheet to the project" : "Place at least one sheet first"}
        onClick={onAddToProject}
      >
        Add to project →
      </Button>
    </nav>
  );
}
