# Auto-align probe determinism (nanodoc) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The browser probe on the same 4 Belcourt sheets answers differently run to run (offer 2 sheets / unavailable 168 ft / unavailable 59 ft) while the Node harness is stable. Mark's rule: "if it offers it must work." Target: a probe verdict that is the same on every run of the same input, or an honest "took too long" — never a verdict built on a timed-out read.

**Architecture:** Facts in `.superpowers/research/2026-09-05-probe-flip-facts.md` (read §1, §2, §4 and "Recommended minimal fix" first). A 20 s OCR job timeout (`ocrService.ts:54`, pool `ocrPool.ts:198-215`) is a browser-only wall-clock event. Only `readPageOcr`'s edge bands flag it via `onNoResult` (`autoStitch.ts:492-499`, retry `564-587`); `searchReciprocal`'s strip scan (`autoStitch.ts:1178-1179, 1208`) and the sheet-number read (`autoStitch.ts:504-506`) call `ocr!(...)` with no `onNoResult`, so a timed-out strip reads as "no text" and `scanStrips` (`1104-1118`) accepts a later strip's match = a different anchor = a different verdict. Fix = (1) every OCR read that feeds a decision distinguishes non-answer from empty, retries once, and if still unknown the decision is UNKNOWN (never a negative, never a later hit); (2) counters flow out to `ProbeResult` and the `[probe]` line; (3) the hook never shows a verdict that rests on unknown reads — it re-runs once, then reports "took too long".

**Tech Stack:** nanodoc TypeScript (`/Users/markschwab/Documents/Pdf_editor`, branch `feat/site-sheet-phase0`, HEAD e26b486), tesseract.js pool, vitest; harness `nice -n 19 npx vite-node scripts/stitch-eval.mjs` (four sets, sample PDFs in `~/Downloads`; baseline `.superpowers/sdd/2026-09-04-autoalign-probe-speed/baseline-v2*.{md,json}` — placements to 0.01 pt). Never push/merge `main`. Harness runs SEQUENTIALLY, one at a time.

**Spec:** Mark: "It takes way too long to tell you whether it can be auto-aligned" + "if the system says it can auto-align I want it to work"; the facts file above.

## Global Constraints

- **Same answers when nothing times out.** Harness table + placements for all four sets identical to `baseline-v2` (with the OCR cache ON; content-hash keyed, so it is the same input). Any difference = the change is wrong.
- **Determinism under faults.** Harness gains `STITCH_EVAL_FAULT_CALLS=<comma-separated OCR call indices>` (0-based count of `recognize` calls in this run): those calls return the pool's non-answer (`OCR_NO_RESULT` path, `onNoResult` fired) instead of running tesseract. With faults injected on calls that the retry then re-reads (the retry is a NEW call index), placements and verdicts must be identical to baseline-v2 for every set. Test at least `FAULT_CALLS=3`, `=7,8`, and `=<the index of the first reciprocal strip read on Belcourt>` (find it by logging call indices once).
- **Unknown is not empty.** A read that is still a non-answer after ONE retry is `unknown`: an unknown strip makes the scan result `unknown` for that seam (no reciprocal anchor claimed, no later strip accepted); an unknown sheet-number leaves `sheetNo` undefined AND marks the page `unknownSheetNo`; an unknown edge band keeps today's behaviour (retry-as-sub-clips) but is counted.
- **Never a verdict on unknown evidence.** `AutoStitchResult` gains `ocrStats: { calls, nonAnswers, retries, unknown, withheldVotes }` → `ProbeResult.ocrStats`. In `useEarnedAutoAlign.ts`: if the reply has `ocrStats.unknown > 0`, run ONE automatic re-check (fresh 60 s budget, status stays "checking", no UI flicker); if the re-check also has `unknown > 0` → status `unavailable` with the EXISTING copy `Auto-align isn't available for these sheets — the check took too long` and **Re-check** stays. `[probe]` line becomes `console.info("[probe] %s: %d ms, %d OCR calls, %d non-answers, %d retries, %d unknown, %d withheld%s", status, ms, calls, nonAnswers, retries, unknown, withheldVotes, rerun ? " (auto re-check)" : "")` — that string is the SHIPPED format and the one the tests assert.
  - `withheldVotes` is the Sep 5 deviation, ruled during the Task 1 review: a side band whose evidence is not whole does not vote in the page's rotation lock (`lockSideTextRot`), and a withheld vote can move the lock → a different strip → a different verdict. The GATES still key on `unknown` alone; the counter is informational, but a `[probe]` line without it hides the one signal that says why two runs disagreed.
- Memory budget unchanged; abort still works (a retry is skipped when aborted).
- Gates per task: `npx vitest run src/features/stitch`, `npx tsc --noEmit`; final `npm run build` + harness. Never `git add -A`. One commit per task with the message given.

---

### Task 1: Non-answer everywhere OCR feeds a decision — `autoStitch.ts`

**Files:** `src/features/stitch/autostitch/autoStitch.ts` (`readPageOcr` ~L466–630 sheet-number read at ~L504–506; `searchReciprocal` ~L1150–1215 and `scanStrips` ~L1083–1118), `src/features/stitch/autostitch/autoStitch.test.ts` (or the nearest existing test file for autoStitch; mocked `ocr` function that can return a non-answer by calling `onNoResult` and returning `[]`).

- [ ] Add an `OcrStats` accumulator on the run context (`calls`, `nonAnswers`, `retries`, `unknown`); every `ocr!(...)` call site passes `{ onNoResult }` and increments.
- [ ] `scanStrips`: per strip, on non-answer → retry that strip once immediately (same image, before issuing the next chunk); still non-answer → the strip is `unknown`. Result type becomes `{ kind: 'hit', strip, ... } | { kind: 'miss' } | { kind: 'unknown' }`. Walk order: lowest index first; if an `unknown` strip precedes the first `hit` in index order → return `unknown` (a later hit is NOT accepted). `searchReciprocal` treats `unknown` as "no reciprocal claim" (falls to `oneSidedAnchor` exactly as a miss does today) AND records `unknown++`.
- [ ] Sheet-number read: non-answer → retry once → still non-answer → `sheetNo = undefined`, `page.unknownSheetNo = true`, `unknown++`.
- [ ] Edge bands: count `nonAnswers`/`retries` in the existing path; a band that is still lost after the sub-clip retry counts `unknown++`.
- [ ] Tests: (a) strip 2 non-answer then answers on retry → same hit as no-fault run; (b) strip 2 unknown after retry while strip 5 would hit → result `unknown`, not strip 5; (c) sheet-number unknown → `unknownSheetNo`; (d) stats totals.
- [ ] Commit `fix(autostitch): timed-out OCR reads are unknown, retried once, never treated as empty`.

### Task 2: Stats out to the probe + hook re-check + harness fault injection

**Files:** `src/features/stitch/autostitch/stitchProbe.ts` (`ProbeResult.ocrStats`, `toProbeResult`), `src/features/stitch/stitchProbe.worker.ts`, `src/features/stitch/useEarnedAutoAlign.ts` (+ its test with fake timers: unknown>0 → one automatic re-check; unknown>0 twice → unavailable with the exact copy; unknown=0 → verdict shown at once), `scripts/stitch-eval.mjs` (`STITCH_EVAL_FAULT_CALLS`; print `ocrStats` in the table).

- [ ] Wire `ocrStats` through; keep `ocrCalls` for compatibility (= `ocrStats.calls`).
- [ ] Hook: the automatic re-check per Global Constraints; `[probe]` line format exact.
- [ ] Harness: fault injection + stats column; run all four sets with no faults → identical to baseline-v2; run the three fault cases on Belcourt and PG_SITE → identical placements/verdicts. Record tables in `.superpowers/sdd/2026-09-05-probe-determinism/harness.md`.
- [ ] Browser check (controller): Belcourt 4 sheets × 5 consecutive probes → the same verdict every run; `[probe]` line shows the counters.
- [ ] Commit `feat(stitch): probe never answers on unknown OCR reads — auto re-check, stats in [probe], harness fault injection`.

### Task 3: Same gate in `AddPdfModal`; placements snapshot gate; forward `documentFileId`

**Files:** `src/features/stitch/AddPdfModal.tsx` (+ `commitPages.ts` if the probe result is consumed there): the non-embed auto-align probe applies the SAME rule — a result with `ocrStats.unknown > 0` is re-run once and, if still unknown, the modal falls back to "Open and place manually" with the existing "took too long" copy (never offers auto-align on unknown reads); `scripts/stitch-eval.mjs`: `STITCH_EVAL_ASSERT_PLACEMENTS=<path.json>` compares every set's placements to the file to 0.01 pt and exits non-zero on any difference (and `STITCH_EVAL_WRITE_PLACEMENTS=<path.json>` writes them); commit the reconstructed baseline as `.superpowers/sdd/2026-09-05-probe-determinism/baseline-v2-placements.json` is NOT possible (dir is git-ignored) → write it to `scripts/fixtures/stitch-eval-placements.json` (tracked) and make `npm run stitch-eval:check` run the assert; `src/features/stitch/ctoSessionSource.ts` / the save-back message builder: spread `documentFileId` from the CTO `commit-save` response into the `nanodoc-stitch-saved` message (CTO side already reads it; test).

- [ ] Tests: AddPdfModal gate with a stubbed probe (unknown → re-run → manual fallback; clean → offer); message builder forwards `documentFileId` and omits it when absent.
- [ ] Commit `feat(stitch): AddPdfModal never offers auto-align on unknown reads; placements assert in the harness; saved message carries documentFileId`.
