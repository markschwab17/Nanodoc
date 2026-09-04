/**
 * Bottom-centre coach mark shown after an auto-align run that could not place
 * every sheet.
 *
 * Auto-align drops the sheets it can't match BELOW the composition rather than
 * failing the run, which is silent and easy to miss — the user sees a tidy
 * composite and a stray sheet off to one side with no explanation. This says
 * what happened, where the strays are, and the two ways out (drag, or two-point
 * align), then names the finish line so the mark doesn't read as a blocker.
 *
 * z-30 deliberately: it sits above the canvas but UNDER the clean-up scrim and
 * review bar (z-40), which own the same bottom-centre slot while they are up.
 */

import { X } from "lucide-react";

export interface AlignCoachMarkProps {
  /** Sheets the run could not auto-align — always ≥ 1 when this is rendered. */
  count: number;
  onDismiss: () => void;
}

export function AlignCoachMark({ count, onDismiss }: AlignCoachMarkProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-[18px] left-1/2 z-30 flex max-w-[720px] -translate-x-1/2 items-center gap-3.5 rounded-[10px] border border-border bg-popover px-3.5 py-2.5 shadow-lg"
    >
      <span
        className="grid h-7 w-7 flex-none place-items-center rounded-full bg-amber-50 text-sm font-bold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
        aria-hidden
      >
        {count}
      </span>
      <div className="text-xs text-popover-foreground">
        <b className="block text-[13px] font-semibold">
          {count} sheet{count === 1 ? "" : "s"} could not be auto-aligned
        </b>
        <span className="text-muted-foreground">
          {count === 1
            ? "It is placed below. Drag it into position, or pick Two-point align and click two matching points on each sheet. Then press Add to project."
            : "They are placed below. Drag them into position, or pick Two-point align and click two matching points on each sheet. Then press Add to project."}
        </span>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        className="ml-1 grid h-6 w-6 flex-none place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
