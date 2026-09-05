/**
 * Coach mark shown the first time a session enters Clean-up review from step 3
 * of the takeoff strip ("Trim title blocks").
 *
 * The step used to be inert with no explanation of what "trimming" even means
 * once boxes appear — this names what the boxes are and the one manual escape
 * hatch (the eraser) before the user has to guess. Shown once per session (the
 * caller tracks that in component state, not persisted) so it never nags on a
 * later re-run.
 *
 * Top-centre, not bottom: the Clean-up review bar already owns bottom-centre
 * (z-40) with its own Cancel/Apply actions, and stacking two bars there would
 * crowd the one place the user is about to click.
 */

import { Button } from "@/components/ui/button";
import { TRIM_COACH_BODY } from "./addToProjectCopy";

export interface TrimCoachMarkProps {
  onDismiss: () => void;
}

export function TrimCoachMark({ onDismiss }: TrimCoachMarkProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-4 left-1/2 z-30 flex max-w-[380px] -translate-x-1/2 flex-col gap-2 rounded-[10px] border border-border bg-popover px-4 py-3 text-popover-foreground shadow-lg"
    >
      <b className="text-[13px] font-semibold">Trim title blocks</b>
      <span className="text-xs leading-relaxed text-muted-foreground">{TRIM_COACH_BODY}</span>
      <div className="flex justify-end">
        <Button size="sm" className="h-7" onClick={onDismiss}>
          Got it
        </Button>
      </div>
    </div>
  );
}
