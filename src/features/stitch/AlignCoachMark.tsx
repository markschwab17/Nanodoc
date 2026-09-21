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
  /** Sheets the run could not auto-align. May be 0: a run can place every sheet and
   *  still be unable to VERIFY the seams, which the user needs telling about before
   *  they press Add to project. */
  count: number;
  /** WHY, in plain words (see `autoAlignExplanation`). Shown above the what-to-do
   *  line, because "it didn't work" without a reason reads as a broken feature — and
   *  the three reasons call for three different responses from the user. */
  explanation?: string | null;
  onDismiss: () => void;
}

export function AlignCoachMark({ count, explanation, onDismiss }: AlignCoachMarkProps) {
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
        {count > 0 ? count : "!"}
      </span>
      <div className="text-xs text-popover-foreground">
        <b className="block text-[13px] font-semibold">
          {count > 0
            ? `${count} sheet${count === 1 ? "" : "s"} could not be auto-aligned`
            : "Check the alignment before adding"}
        </b>
        {explanation ? (
          <span className="mt-0.5 block text-muted-foreground">{explanation}</span>
        ) : null}
        <span className="mt-0.5 block text-muted-foreground">
          {count === 0
            ? "Every sheet was placed. Look along the seams — if they line up, press Add to project; if not, drag a sheet or use Two-point align."
            : count === 1
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
