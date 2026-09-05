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

import { Check, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AUTO_ALIGN_CHECKING,
  AUTO_ALIGN_MOVED,
  autoAlignButtonLabel,
  autoAlignUnavailableNote,
  autoAlignUnavailableTitle,
  type AutoAlignUnavailableReason,
} from "./addToProjectCopy";

/**
 * The earned Auto-align offer. The sheets are already on the canvas in a grid; this is
 * the background check's answer about them, and it is the whole reason the strip has a
 * second action. `"idle"` renders nothing at all — no chip, no greyed-out button — so a
 * canvas the check has nothing to say about is not cluttered by it.
 */
export interface TakeoffModeAutoAlign {
  status: "idle" | "checking" | "offer" | "unavailable" | "stale" | "aligning";
  /** Sheets the offer would claim. */
  sheets: number;
  reason?: AutoAlignUnavailableReason;
  /** The fuller sentence behind the short reason. Rendered as a SECOND LINE, not a
   *  tooltip: the along-matchline case ("they may slide up to 48 ft") is the one fact
   *  the short reason drops, and a fact only a hover reveals is a fact most people
   *  never see. */
  detail?: string;
  onRun: () => void;
  /** Re-run the check over the canvas as it now stands (the stale state's action). */
  onRecheck: () => void;
}

export interface TakeoffModeStripProps {
  /** Sheets currently on the canvas (scale stamps excluded). */
  sheetCount: number;
  /** Sheets the last auto-align run could not place; 0 once dismissed. */
  unplacedCount: number;
  /** False when there is nothing to add — the primary action goes disabled. */
  canAdd: boolean;
  onAddToProject: () => void;
  autoAlign?: TakeoffModeAutoAlign;
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

/** The chip / button / note the background check turns into. */
function AutoAlignOffer({ status, sheets, reason, detail, onRun, onRecheck }: TakeoffModeAutoAlign) {
  if (status === "idle") return null;
  if (status === "checking") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {AUTO_ALIGN_CHECKING}
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {AUTO_ALIGN_MOVED}
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRecheck}>
          Re-check
        </Button>
      </span>
    );
  }
  if (status === "unavailable" && reason) {
    const note = (
      <span
        className="flex flex-col items-end leading-tight text-xs text-muted-foreground"
        title={autoAlignUnavailableTitle(reason, detail)}
        aria-live="polite"
      >
        <span>{autoAlignUnavailableNote(reason)}</span>
        {detail && <span className="text-[11px] opacity-80">{detail}</span>}
      </span>
    );
    if (reason !== "too_slow") return note;
    // The budget gave up on the probe, not a verdict about the sheets — trying again
    // is likely to just work, so this is the one unavailable reason that keeps the
    // Re-check action (unbudgeted: see useEarnedAutoAlign's `recheck`).
    return (
      <span className="flex items-center gap-2" aria-live="polite">
        {note}
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRecheck}>
          Re-check
        </Button>
      </span>
    );
  }
  if (status === "offer" || status === "aligning") {
    const aligning = status === "aligning";
    return (
      <Button size="sm" className="h-8 shrink-0" disabled={aligning} onClick={onRun}>
        {aligning ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        )}
        {aligning ? "Aligning…" : autoAlignButtonLabel(sheets)}
      </Button>
    );
  }
  return null;
}

export function TakeoffModeStrip({
  sheetCount,
  unplacedCount,
  canAdd,
  onAddToProject,
  autoAlign,
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
      {autoAlign && (
        <div className="mr-3 flex min-w-0 items-center">
          <AutoAlignOffer {...autoAlign} />
        </div>
      )}
      <Button
        size="sm"
        variant={autoAlign?.status === "offer" ? "outline" : "default"}
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
