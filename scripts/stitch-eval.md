# Auto-stitch regression suite

`scripts/stitch-eval.mjs` is the gate for the auto-stitch solver. It runs the REAL
`autoStitch` over a small corpus of real construction PDFs and checks each set against
expectations that were **measured, not wished for** — the floor the engine must not
fall below.

Run it before merging anything that touches `src/features/stitch/autostitch/`.
It is deliberately NOT part of `npm test`: it needs local PDFs, and it takes about a
minute warm (several minutes the first time, while it OCRs).

```bash
npx vite-node scripts/stitch-eval.mjs                    # the whole corpus
npx vite-node scripts/stitch-eval.mjs --set "PG_SITE 1A" # one set
npx vite-node scripts/stitch-eval.mjs --json             # machine-readable
npx vite-node scripts/stitch-eval.mjs --manifest <path>  # a different corpus
```

Exit code 0 = every set met its expectations, 1 = something regressed (each failure is
printed as `REGRESSION · <set>: <what>`), 2 = the manifest named no runnable set.

## The corpus

`scripts/fixtures/stitch-eval-sets.json`. Paths use `~` for `$HOME`; the PDFs are not
in the repo. **A set whose PDF is missing is SKIPPED, not failed** — the suite is
meant to run on a machine that has only part of the corpus.

| set | what it proves |
|---|---|
| PG_SITE 1A (22 pp) | The reference set: 11 plan units placed, verdict at least `partial`, no suspect seam. Ground truth for placement error is `scripts/fixtures/pg-site-1a.groundtruth.json`. |
| Belcourt Grading Plans (4 pp) | Identity and callouts are OCR-only (all text outlined) and the sheets are printed 5–8, not 1–4. Aligned 0/4 before T0. |
| El Centro (12 pp) | The NEGATIVE set. Notes, details and single plans that share no ground: nothing may be placed. Produced 3 false pairs before T0. |
| Coast Guard pair (2 pp) | Outlined CAD callouts, OCR-only. Unalignable from the signals present (the one directional reference's target reads as "HEET CD1"), so nothing may be placed — but both pages must still be seen to CARRY a callout, so the app says "these sheets don't share a matchline" rather than "no callouts were found". |

The runner also prints, per set, which pages are **along-anchored** (pinned along the
matchline, not just across it) and which placed pages are **demoted** — connected, but
free to slide by up to the ± it quotes.

Each set may set any of:

| key | meaning |
|---|---|
| `minAligned` | recall floor — the fewest units the run may place |
| `maxAligned` | false-pair ceiling — used on a negative set, where any placement is wrong |
| `verdictFloor` | the weakest honesty verdict accepted (`verified` > `partial` > `unverified`) |
| `maxWorstResidFt` | worst cross-seam disagreement between a seam's own measurement and the solved layout |
| `maxSuspectSeams` | seams the post-solve verification positively believes are wrong |
| `maxSeconds` | wall-clock ceiling (unset by default — the first run is cold) |
| `groundTruth` | a hand-verified placement fixture to measure against |
| `maxTileErrorFt` | the bar for a unit the solver CLAIMS (see below) |
| `minRefPages` | the fewest pages that must carry a detected edge ref — the difference between "these sheets don't share a matchline" and "no callouts were found" |

## Ground truth, and what "claimed" means

With `groundTruth` set, the runner reports each placed unit's distance from the
fixture in feet — median, 95th percentile and per unit — after aligning the two
layouts by their MEDIAN delta (a layout has no absolute origin, and a median is not
dragged around by the one badly-placed sheet we are looking for).

`maxTileErrorFt` is checked **only against units the solver CLAIMS** — the
along-anchored ones, which are the ones offered as aligned. A unit that is not
along-anchored is demoted to unaligned by the commit and placed below for the user, so
its error is reported and never failed. That asymmetry is the whole invariant: the
engine may be wrong about a sheet, it may not be wrong about a sheet it is offering.

PG_SITE currently claims nothing: its cross-seam residuals are all ≤1.33 ft, but no
unit is pinned ALONG the matchline, and its measured ground-truth errors run 0–52 ft
(p8 42, p11 52, strips 24/17). The check therefore passes with nothing to check —
and will fail the moment a change starts claiming any of them.

### The origin convention (settled)

A fixture declares `originConvention`, `ptPerFt` and `rootFtPerIn`. The only supported
convention is `"page"`: **every** entry, strips included, is where the WHOLE PAGE's
top-left corner belongs. A solver pose reports the origin of the FRAME it anchors —
the same point for a whole page, offset by the frame origin for a strip — so the
runner subtracts `frame[0], frame[1]` (page pt × `scale / rootFtPerIn`) before
comparing. Comparing frame origins straight against the fixture read PG_SITE's lower
strip as 170.7 ft out when it is 16.6 ft out: a 646 pt inset is 179 ft at 1"=20'.

Strip keys are per page — `<pageIndex>s<n>`, numbered from 1 in ascending frame order
(top strip first) — so a second split page cannot collide with the first. A fixture key
that matches no placed unit is a REGRESSION, not a note: either the solver stopped
placing that unit or the two sides disagree about naming, and both silently turn the
ground-truth check into a no-op that passes. A fixture/solve `rootFtPerIn` mismatch
fails the same way.

An expectation that is absent is not checked. Belcourt has no `verdictFloor` because
its verdict is honestly `unverified`: every cross-seam axis is confirmed to 0.00 ft,
but the along-matchline axis is only a weak vote on two of its three seams.

## Adding a set

Drop the PDF somewhere local, add an entry with its path, page range and scale, run
the suite once to see what the engine actually does, then write those numbers in as
the expectations — with a `notes` line saying what the set is for. Never write an
expectation the engine does not currently meet: a permanently red suite is a suite
nobody reads.

## Relationship to the other harnesses

- `scripts/stitch-diag.mjs` — the detail view for ONE file: anchors, per-pair channels
  and residuals, seam quality, crossing registration, the joint sweep, the verdict, and
  the skipped/scale-warning lines. This is the debugging loop; `stitch-eval` is the gate.
- `src/features/dev/AutoStitchSmokeHarness.tsx` — the browser equivalent of the diag,
  run by hand.
- Both share `scratch-diag/ocr-cache.json` (keyed by image content), so a set OCR'd by
  one is warm for the other.
