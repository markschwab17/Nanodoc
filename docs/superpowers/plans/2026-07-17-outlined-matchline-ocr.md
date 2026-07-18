# Outlined-Matchline OCR + Multi-Strip Auto-Stitch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-stitch plan sets whose matchline text is outlined to vector (unreadable as text) and whose pages may hold two plan strips, by OCR-recovering edge labels and making (page, frame) the stitch unit.

**Architecture:** Frame detection finds each sheet's plan rectangle(s) from already-captured geometry; an OCR band reader (tesseract.js, fully offline) recovers "SEE SHEET n"/"MATCHLINE"/strip refs as synthetic `Label`s so the existing token/matchline/segment channels work unchanged; `stitchSheets` places units instead of pages; a two-frame page commits as two tiles masked with the existing `hiddenRegions`. OCR runs on the **main thread** (tesseract worker); the stitch probe worker requests it over a small RPC so we never nest workers.

**Tech Stack:** TypeScript, Vite, vitest (jsdom), mupdf WASM, tesseract.js v5, React (modal only).

**Spec:** `docs/superpowers/specs/2026-07-17-outlined-matchline-ocr-design.md`

## Global Constraints

- **Offline only:** no CDN fetches at runtime. tesseract worker/core/langdata are served from the app itself (`public/ocr/` + bundled node_modules URLs via Vite `?url`).
- **Vitest = jsdom:** no Worker, no mupdf WASM, no `ImageData` constructor in tests. All testable logic operates on the plain `RawImage {width,height,data}` shape and plain objects; mupdf/tesseract touchpoints stay thin and are validated via `/dev/autostitch` manually.
- **Existing suites stay green:** run `npm run test:run` at the end of every task.
- Reference PDF for manual acceptance: `~/Downloads/PG_SITE 1A.pdf` (22 pages; p1 is the two-strip sheet; expect "SEE SHEET 9/10/11" on its frame edges).
- Commit after every task (repo convention: commit directly on `main`).

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/features/stitch/autostitch/frameDetect.ts` | new | Detect plan frame rect(s) per page from geometry; slice+normalize a `PageExtract` to a frame |
| `src/features/stitch/autostitch/ocrBands.ts` | new | Pure OCR-adjacent math: band specs, raster rotation, OCR-word→page-point mapping, synthetic labels, sheet-number parse |
| `src/features/stitch/autostitch/ocrService.ts` | new | Main-thread tesseract.js wrapper (lazy singleton) + worker RPC handler |
| `src/features/stitch/autostitch/bandRender.ts` | new | mupdf band rasterizer (`RawImage` out) — thin, not unit-tested |
| `src/features/stitch/autostitch/tokens.ts` | modify | `SheetRef` gains strip refs ("SEE ABOVE RIGHT" / "SEE BELOW LEFT") |
| `src/features/stitch/autostitch/stitchCore.ts` | modify | `bandSeamPrior` floor 0.75; unit keys (`printedNo`, `siblingKey`, per-unit ref resolution) |
| `src/features/stitch/autostitch/autoStitch.ts` | modify | Build units from frames; OCR orchestration; per-unit poses |
| `src/features/stitch/autostitch/layout.ts` | modify | Frame-anchored placement; `frameMask` complement helper |
| `src/features/stitch/autostitch/stitchProbe.ts` | modify | Per-unit poses through probe result; dedupe aligned pages |
| `src/features/stitch/autostitch/stitchProbe.worker.ts` | modify | OCR RPC (worker side) |
| `src/features/stitch/AddPdfModal.tsx` | modify | Attach OCR RPC; commit per-placement tiles with `hiddenRegions` |
| `src/features/dev/AutoStitchSmokeHarness.tsx` | modify | OCR spike button; per-unit result printing |
| `public/ocr/eng.traineddata.gz` | new asset | tessdata_fast English model (~2 MB) |

---

### Task 1: OCR feasibility spike (gates the rest of the plan)

Proves tesseract.js reads the outlined SHX-italic text of PG_SITE 1A at ~200 DPI, fully offline. If this fails after tuning (DPI 150–300, PSM modes), STOP and revisit the spec with the human partner.

**Files:**
- Modify: `package.json` (dependency)
- Create: `public/ocr/eng.traineddata.gz`
- Create: `src/features/stitch/autostitch/ocrService.ts`
- Modify: `src/features/dev/AutoStitchSmokeHarness.tsx`

**Interfaces:**
- Produces: `RawImage`, `OcrWord`, `recognize(image: RawImage): Promise<OcrWord[]>` — consumed by Tasks 5, 6.

- [ ] **Step 1: Install tesseract.js and fetch the offline language model**

```bash
cd /Users/markschwab/Documents/Pdf_editor
npm install tesseract.js@^5
mkdir -p public/ocr
curl -L -o public/ocr/eng.traineddata.gz \
  https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata.gz
ls -la public/ocr/   # expect eng.traineddata.gz ≈ 2 MB
```

- [ ] **Step 2: Write `ocrService.ts`**

```typescript
/**
 * Main-thread OCR service: a lazy tesseract.js singleton, fully offline
 * (worker/core resolved from the bundle, language data from /ocr/).
 *
 * Runs on the MAIN thread only. The stitch probe worker must NOT import this —
 * it requests OCR over the RPC in `attachOcrRpc` (nested workers are not
 * portable across webviews). Vitest must not import this module either
 * (tesseract.js touches DOM/Worker APIs); all testable math lives in ocrBands.ts.
 */
// Vite turns these into bundled asset URLs — no CDN at runtime.
// (If a path 404s after a tesseract.js upgrade, check `ls node_modules/tesseract.js/dist`.)
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-simd.wasm.js?url";

export interface RawImage { width: number; height: number; data: Uint8ClampedArray }
export interface OcrWord {
  text: string;
  confidence: number; // 0..100
  bbox: { x0: number; y0: number; x1: number; y1: number }; // px in the recognized image
}

let workerPromise: Promise<any> | null = null;

async function ensureWorker(): Promise<any> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, {
        workerPath: workerUrl,
        corePath: coreUrl,
        langPath: "/ocr",
        gzip: true,
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return worker;
    })();
    // A failed init must not poison every later call.
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** OCR a raw RGBA raster. Returns [] on any failure (OCR is best-effort). */
export async function recognize(image: RawImage): Promise<OcrWord[]> {
  try {
    const worker = await ensureWorker();
    const imageData = new ImageData(image.data, image.width, image.height);
    const { data } = await worker.recognize(imageData);
    const words: OcrWord[] = [];
    for (const w of data.words ?? []) {
      if (!w.text?.trim()) continue;
      words.push({ text: w.text.trim(), confidence: w.confidence, bbox: { ...w.bbox } });
    }
    return words;
  } catch (err) {
    console.warn("[ocrService] recognize failed:", err);
    return [];
  }
}

/**
 * Answer `{kind:"ocr-req", ocrId, image}` messages from the stitch probe worker
 * with `{kind:"ocr-res", ocrId, words}`. Attach once per worker, right after
 * construction. Failures answer with [] so the worker never hangs.
 */
export function attachOcrRpc(worker: Worker): void {
  worker.addEventListener("message", async (e: MessageEvent<any>) => {
    const d = e.data;
    if (!d || d.kind !== "ocr-req") return;
    const words = await recognize(d.image as RawImage);
    worker.postMessage({ kind: "ocr-res", ocrId: d.ocrId, words });
  });
}
```

- [ ] **Step 3: Add a spike button to the dev harness**

In `src/features/dev/AutoStitchSmokeHarness.tsx`, add a second handler + button that renders the four page-edge bands of a chosen page (default 1) at 200 DPI and prints OCR words. Insert after the existing `onFile`:

```typescript
  const [ocrPage, setOcrPage] = useState(1);
  const onOcrSpike = async (file: File) => {
    setBusy(true);
    setLog("OCR spike: loading…");
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      const { recognize } = await import("@/features/stitch/autostitch/ocrService");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = mupdf.Document.openDocument(bytes, "application/pdf") as any;
      const page = doc.loadPage(ocrPage);
      const [x0, y0, x1, y1] = page.getBounds();
      const W = x1 - x0, H = y1 - y0;
      const S = 200 / 72;
      const bands: [string, number, number, number, number][] = [
        ["top",    x0, y0, x1, y0 + 0.08 * H],
        ["bottom", x0, y1 - 0.08 * H, x1, y1],
        ["left",   x0, y0, x0 + 0.06 * W, y1],
        ["right",  x1 - 0.06 * W, y0, x1, y1],
      ];
      const lines: string[] = [];
      for (const [name, bx0, by0, bx1, by1] of bands) {
        const pix = new mupdf.Pixmap(
          mupdf.ColorSpace.DeviceRGB,
          [Math.floor(bx0 * S), Math.floor(by0 * S), Math.ceil(bx1 * S), Math.ceil(by1 * S)],
          true
        );
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(S, S), pix);
        page.run(dev, mupdf.Matrix.identity);
        dev.close();
        const pw = pix.getWidth(), ph = pix.getHeight();
        const px = pix.getPixels(); // RGBA (alpha=true above)
        let img = { width: pw, height: ph, data: new Uint8ClampedArray(px) };
        const orientations = name === "left" || name === "right" ? [90, 270] : [0];
        for (const rot of orientations) {
          let toOcr = img;
          if (rot) {
            // inline 90° rotation for the spike (Task 5 productizes this)
            const { width: w, height: h, data } = img;
            const out = new Uint8ClampedArray(w * h * 4);
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
              const [dx, dy] = rot === 90 ? [h - 1 - yy, xx] : [yy, w - 1 - xx];
              const si = (yy * w + xx) * 4, di = (dy * h + dx) * 4;
              out[di] = data[si]; out[di+1] = data[si+1]; out[di+2] = data[si+2]; out[di+3] = data[si+3];
            }
            toOcr = { width: h, height: w, data: out };
          }
          const words = await recognize(toOcr);
          const strong = words.filter((w) => w.confidence >= 50);
          lines.push(`${name} rot${rot}: ` + (strong.map((w) => `${w.text}(${Math.round(w.confidence)})`).join(" ") || "—"));
        }
        pix.destroy?.();
        setLog(lines.join("\n"));
      }
      page.destroy?.();
      doc.destroy?.();
    } catch (e) {
      setLog("OCR SPIKE ERROR: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };
```

And in the JSX, next to the existing input:

```tsx
      <div style={{ marginTop: 8 }}>
        <label>OCR spike page: <input type="number" value={ocrPage} onChange={(e) => setOcrPage(Number(e.target.value))} style={{ width: 60 }} /></label>{" "}
        <input type="file" accept="application/pdf" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onOcrSpike(f); }} />
      </div>
```

- [ ] **Step 4: Manual verification (the gate)**

Run: `npm run dev`, open `http://localhost:1420/dev/autostitch`, set page to `1`, pick `~/Downloads/PG_SITE 1A.pdf` in the spike input.

Expected: the log shows words including `SEE`, `SHEET`, and digits `9`/`10`/`11` on the top band, and readable text on at least one rotation of each side band. If not readable, try `S = 300/72` and PSM `SINGLE_BLOCK` before concluding failure. **If it still fails, stop the plan and report.** Record which rotation read the left/right bands (expected: right edge reads with rot 90, left edge with rot 270 — verify and note the actual answer for Task 6).

- [ ] **Step 5: Verify existing tests still pass, then commit**

```bash
npm run test:run
git add package.json package-lock.json public/ocr src/features/stitch/autostitch/ocrService.ts src/features/dev/AutoStitchSmokeHarness.tsx
git commit -m "feat(autostitch): offline tesseract OCR service + dev spike harness"
```

---

### Task 2: Raise `bandSeamPrior` abutment floor to 0.75·dim

**Files:**
- Modify: `src/features/stitch/autostitch/stitchCore.ts` (line ~457)
- Test: `src/features/stitch/autostitch/stitchCore.test.ts`

**Interfaces:**
- Produces: `bandSeamPrior` unchanged signature, stricter acceptance. No consumer changes.

- [ ] **Step 1: Write the failing test**

Append to `stitchCore.test.ts` (it already imports from `./stitchCore`; extend the import with `bandSeamPrior, segFeats` if not present). Build two sheets whose edge bands genuinely correlate at HALF a sheet height — the PG_SITE failure — and at 0.85·H — a true seam:

```typescript
import { bandSeamPrior } from "./stitchCore";
import type { Geom } from "./types";

/** Sheet stub for bandSeamPrior: view + pre-filtered segFeats in FEET. */
function seamSheet(segs: { mx: number; my: number; len: number; ang: number }[]) {
  // 2592x1728pt at 20 ft/in = 720x480 ft
  return { view: [0, 0, 2592, 1728] as [number, number, number, number], scale: 20, seg: segs };
}
/** A distinctive L-shaped cluster of ≥10 segments centered at (cx, cy) ft. */
function cluster(cx: number, cy: number) {
  const out = [];
  for (let i = 0; i < 6; i++) out.push({ mx: cx + i * 3, my: cy, len: 10 + i, ang: 0 });
  for (let i = 0; i < 6; i++) out.push({ mx: cx, my: cy + i * 3, len: 10 + i, ang: 90 });
  return out;
}

describe("bandSeamPrior abutment floor", () => {
  test("rejects a half-sheet-offset vertical match (PG_SITE false seam)", () => {
    // A's bottom band content == B's top band content at dy = -240 ft (0.5*H): alias.
    const a = seamSheet(cluster(360, 470));       // near A's bottom edge (H=480)
    const b = seamSheet(cluster(360, 470 + 240)); // would vote dy=-240 — but that's off B's sheet;
    // instead put B's copy in ITS top band so the vote lands at dy = -240:
    const b2 = seamSheet(cluster(360, 230));      // a.my - b.my = 240 → |dy|=240 = 0.5*H
    expect(bandSeamPrior(a, b2)).toBeNull();
    void b;
  });
  test("accepts a true abutting vertical seam (~0.85*H)", () => {
    const a = seamSheet(cluster(360, 470));
    const b = seamSheet(cluster(360, 62)); // dy = 408 = 0.85*H, within top band
    const v = bandSeamPrior(a, b);
    expect(v).not.toBeNull();
    expect(Math.abs(v!.dy)).toBeGreaterThan(400);
  });
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts -t "abutment"`
Expected: "rejects a half-sheet-offset" FAILS (current floor 0.5 accepts dy=240); "accepts a true abutting" PASSES.

- [ ] **Step 3: Change the floor**

In `stitchCore.ts` `bandSeamPrior`, change the abutting check:

```typescript
    if (perp > AX || par < 0.75 * dim || par > 1.15 * dim) continue; // axis-aligned + truly abutting (≤25% overlap)
```

(was `par < 0.5 * dim`).

- [ ] **Step 4: Run the full stitchCore suite**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts`
Expected: PASS. If a pre-existing bandSeam test asserted acceptance between 0.5 and 0.75·dim, update that test's fixture offset to ≥0.75·dim — the stricter floor is the spec'd behavior.

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/stitchCore.ts src/features/stitch/autostitch/stitchCore.test.ts
git commit -m "harden(autostitch): bandSeamPrior rejects seams with >25% claimed overlap"
```

---

### Task 3: Strip refs in `tokens.ts`

**Files:**
- Modify: `src/features/stitch/autostitch/tokens.ts`
- Test: `src/features/stitch/autostitch/tokens.test.ts`

**Interfaces:**
- Produces: `SheetRef.strip: "above" | "below" | null`, `SheetRef.stripSide: "left" | "right" | null`. Strip refs have `matchline: true` (they are matchline continuations) so `matchlinePrior` can anchor them. Consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `tokens.test.ts`:

```typescript
describe("strip refs", () => {
  const view: [number, number, number, number] = [0, 0, 1000, 800];
  const label = (text: string, x: number, y: number) =>
    ({ text, x, y, endX: x + 80, endY: y + 8, angle: 0, h: 8, font: null });

  test("SEE BELOW LEFT on the right edge parses as a strip ref", () => {
    const refs = parseSheetRefs([label("SEE BELOW LEFT", 950, 400)], view);
    expect(refs).toHaveLength(1);
    expect(refs[0].strip).toBe("below");
    expect(refs[0].stripSide).toBe("left");
    expect(refs[0].matchline).toBe(true);
    expect(refs[0].edge).toBe("right");
    expect(refs[0].sheet).toBeNull();
  });
  test("SEE ABOVE RIGHT parses symmetrically", () => {
    const refs = parseSheetRefs([label("SEE ABOVE RIGHT", 5, 400)], view);
    expect(refs[0].strip).toBe("above");
    expect(refs[0].stripSide).toBe("right");
  });
  test("plain SEE SHEET refs have strip null", () => {
    const refs = parseSheetRefs([label("SEE SHEET 12", 950, 400)], view);
    expect(refs[0].strip).toBeNull();
    expect(refs[0].sheet).toBe(12);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/stitch/autostitch/tokens.test.ts -t "strip refs"`
Expected: FAIL — `strip` is undefined.

- [ ] **Step 3: Implement**

In `tokens.ts`, extend the interface and parser:

```typescript
export interface SheetRef { text: string; at: Pt; angle: number; sheet: number | null; sheetCode: string | null; matchline: boolean; station: string | null; edge: string; edgeDist: number; strip: "above" | "below" | null; stripSide: "left" | "right" | null; }
```

In `parseSheetRefs`, add the strip match and include it in the gate and output:

```typescript
    const mStrip = l.text.match(/SEE\s+(ABOVE|BELOW)\s+(LEFT|RIGHT)/i);
    if (!mSheet && !mCode && !mMatch && !mStrip) continue;
```

```typescript
    out.push({
      text: l.text, at: c, angle: l.angle,
      sheet: mSheet ? Number(mSheet[1]) : null,
      sheetCode: (!mSheet && mCode) ? mCode[1].replace(/\s+/g, '') : null,
      matchline: !!mMatch || !!mStrip, station: mMatch && mMatch[1] ? mMatch[1] : null,
      edge: edge[1] < 0.18 ? edge[0] : 'interior', edgeDist: edge[1],
      strip: mStrip ? (mStrip[1].toLowerCase() as "above" | "below") : null,
      stripSide: mStrip ? (mStrip[2].toLowerCase() as "left" | "right") : null,
    });
```

- [ ] **Step 4: Run the tokens suite**

Run: `npx vitest run src/features/stitch/autostitch/tokens.test.ts`
Expected: PASS (including pre-existing tests — they don't read the new fields).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/tokens.ts src/features/stitch/autostitch/tokens.test.ts
git commit -m "feat(autostitch): parse intra-page strip refs (SEE ABOVE/BELOW LEFT/RIGHT)"
```

---

### Task 4: Frame detection — `frameDetect.ts`

**Files:**
- Create: `src/features/stitch/autostitch/frameDetect.ts`
- Test: `src/features/stitch/autostitch/frameDetect.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6, 7, 8):
  - `interface Frame { bbox: [number, number, number, number] }` (page pts)
  - `detectFrames(extract: PageExtract): Frame[]` — 0, 1, or 2 frames (top-first)
  - `sliceExtract(extract: PageExtract, frame: Frame, marginPt?: number): PageExtract` — contents inside the grown frame, **normalized to frame-local coordinates** (`view = [0, 0, w, h]`)

- [ ] **Step 1: Write the failing tests**

Create `frameDetect.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { detectFrames, sliceExtract } from "./frameDetect";
import type { Geom, PageExtract } from "./types";

let gid = 0;
/** Dashed axis-aligned rectangle border as individual dash segments. */
function dashedRect(x0: number, y0: number, x1: number, y1: number, dash = 20, gap = 10): Geom[] {
  const out: Geom[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number) =>
    out.push({ id: `g${gid++}`, pts: [[ax, ay], [bx, by]], closed: false });
  for (let x = x0; x < x1; x += dash + gap) seg(x, y0, Math.min(x + dash, x1), y0);
  for (let x = x0; x < x1; x += dash + gap) seg(x, y1, Math.min(x + dash, x1), y1);
  for (let y = y0; y < y1; y += dash + gap) seg(x0, y, x0, Math.min(y + dash, y1));
  for (let y = y0; y < y1; y += dash + gap) seg(x1, y, x1, Math.min(y + dash, y1));
  return out;
}
const page = (geometry: Geom[], extra: Partial<PageExtract> = {}): PageExtract => ({
  view: [0, 0, 2592, 1728], shxLabels: [], labels: [], words: [], geometry, ...extra,
});

describe("detectFrames", () => {
  test("single frame sheet", () => {
    const f = detectFrames(page(dashedRect(80, 60, 2200, 1600)));
    expect(f).toHaveLength(1);
    const [x0, y0, x1, y1] = f[0].bbox;
    expect(x0).toBeCloseTo(80, -1); expect(y0).toBeCloseTo(60, -1);
    expect(x1).toBeCloseTo(2200, -1); expect(y1).toBeCloseTo(1600, -1);
  });
  test("two stacked strips, different widths (PG_SITE p1 shape)", () => {
    const f = detectFrames(page([
      ...dashedRect(80, 40, 1500, 700),   // top strip, narrower
      ...dashedRect(60, 760, 2300, 1560), // bottom strip, wider
    ]));
    expect(f).toHaveLength(2);
    expect(f[0].bbox[3]).toBeLessThan(f[1].bbox[1]); // top-first
    expect(f[0].bbox[2]).toBeCloseTo(1500, -1);      // per-frame right edge, NOT global max
    expect(f[1].bbox[2]).toBeCloseTo(2300, -1);
  });
  test("interior long line does not split a single frame", () => {
    const road: Geom[] = [{ id: "road", pts: [[100, 800], [2100, 800]], closed: false }];
    const f = detectFrames(page([...dashedRect(80, 60, 2200, 1600), ...road]));
    expect(f).toHaveLength(1);
  });
  test("no frame (notes sheet) returns []", () => {
    const f = detectFrames(page([{ id: "x", pts: [[100, 100], [300, 100]], closed: false }]));
    expect(f).toEqual([]);
  });
});

describe("sliceExtract", () => {
  test("filters and normalizes to frame-local coordinates", () => {
    const inLbl  = { text: "SEE SHEET 9", x: 500, y: 770, endX: 580, endY: 778, angle: 0, h: 8, font: null };
    const outLbl = { text: "ELSEWHERE 1", x: 100, y: 100, endX: 180, endY: 108, angle: 0, h: 8, font: null };
    const inG: Geom  = { id: "a", pts: [[600, 900], [700, 900]], closed: false };
    const outG: Geom = { id: "b", pts: [[100, 100], [200, 100]], closed: false };
    const s = sliceExtract(page([inG, outG], { labels: [inLbl, outLbl] }), { bbox: [60, 760, 2300, 1560] });
    expect(s.view).toEqual([0, 0, 2240, 800]);
    expect(s.labels).toHaveLength(1);
    expect(s.labels[0].x).toBeCloseTo(440); // 500 - 60
    expect(s.labels[0].y).toBeCloseTo(10);  // 770 - 760
    expect(s.geometry).toHaveLength(1);
    expect(s.geometry[0].pts[0]).toEqual([540, 140]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/stitch/autostitch/frameDetect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frameDetect.ts`**

```typescript
/**
 * Plan-frame detection. A sheet's drawing area is bounded by a long (usually
 * dashed) axis-aligned border. We accumulate per-cross-coordinate dash-span
 * sums (the findEdgeStroke trick, page-wide), keep near-full-span lines, and
 * assemble 1–2 stacked frames. Strip sheets (two frames) pair consecutive
 * horizontal borders; per-frame vertical borders are re-picked from the lines
 * that actually span that frame's y-range, so strips of different widths get
 * their true edges. Returns [] when no border exists (cover/notes/details).
 */
import type { Geom, Label, PageExtract } from "./types";

export interface Frame { bbox: [number, number, number, number] }

const BIN = 4;            // pt cross-coordinate bins
const AXIS_TOL = 3;       // pt deviation for "axis-aligned"
const MIN_SPAN_FRAC = 0.5;   // a border line's dash-span sum vs its extent
const MIN_FRAME_H_FRAC = 0.18; // min frame height vs page
const MIN_FRAME_W_FRAC = 0.4;  // min frame width vs page

interface Line { cross: number; lo: number; hi: number; span: number }

/** Sum axis-aligned dash spans per cross-coordinate bin; return strong lines. */
function strongLines(geometry: Geom[], axis: "h" | "v", minExtent: number): Line[] {
  const acc = new Map<number, { span: number; lo: number; hi: number }>();
  for (const g of geometry) {
    const pts = g.pts;
    if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dCross = axis === "h" ? b[1] - a[1] : b[0] - a[0];
      if (Math.abs(dCross) > AXIS_TOL) continue;
      const cross = axis === "h" ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
      const lo = axis === "h" ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
      const hi = axis === "h" ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
      if (hi - lo < 1) continue;
      const k = Math.round(cross / BIN);
      const e = acc.get(k) || { span: 0, lo: Infinity, hi: -Infinity };
      e.span += hi - lo;
      e.lo = Math.min(e.lo, lo); e.hi = Math.max(e.hi, hi);
      acc.set(k, e);
    }
  }
  // merge adjacent bins (a border wobbles across a bin boundary)
  const keys = [...acc.keys()].sort((a, b) => a - b);
  const lines: Line[] = [];
  let cur: { k0: number; k1: number; span: number; lo: number; hi: number } | null = null;
  for (const k of keys) {
    const e = acc.get(k)!;
    if (cur && k - cur.k1 <= 1) {
      cur.k1 = k; cur.span += e.span; cur.lo = Math.min(cur.lo, e.lo); cur.hi = Math.max(cur.hi, e.hi);
    } else {
      if (cur) lines.push({ cross: ((cur.k0 + cur.k1) / 2) * BIN, lo: cur.lo, hi: cur.hi, span: cur.span });
      cur = { k0: k, k1: k, span: e.span, lo: e.lo, hi: e.hi };
    }
  }
  if (cur) lines.push({ cross: ((cur.k0 + cur.k1) / 2) * BIN, lo: cur.lo, hi: cur.hi, span: cur.span });
  return lines.filter((l) => l.hi - l.lo >= minExtent && l.span >= MIN_SPAN_FRAC * (l.hi - l.lo));
}

export function detectFrames(extract: PageExtract): Frame[] {
  const [vx0, vy0, vx1, vy1] = extract.view;
  const W = vx1 - vx0, H = vy1 - vy0;
  const hLines = strongLines(extract.geometry, "h", MIN_FRAME_W_FRAC * W)
    .sort((a, b) => a.cross - b.cross);
  const vAll = strongLines(extract.geometry, "v", MIN_FRAME_H_FRAC * H);
  if (hLines.length < 2 || vAll.length < 2) return [];

  // Pair horizontal borders into candidate frames greedily from the top, max 2
  // frames. Smallest-height-first pairing: the NEAREST bottom border that has
  // its own covering vertical borders wins, so two stacked strips pair as
  // (top1,bot1) then (top2,bot2) rather than one giant (top1,bot2) rect. An
  // interior long line (a street) fails the vertical-coverage check and is
  // skipped as a bottom candidate; as a top candidate it starts no frame.
  const frames: Frame[] = [];
  let i = 0;
  while (i < hLines.length - 1 && frames.length < 2) {
    let matched = false;
    for (let j = i + 1; j < hLines.length; j++) {
      const top = hLines[i], bot = hLines[j];
      const h = bot.cross - top.cross;
      if (h < MIN_FRAME_H_FRAC * H) continue;
      // vertical borders that cover ≥60% of this y-range
      const cover = vAll.filter((v) => {
        const lo = Math.max(v.lo, top.cross), hi = Math.min(v.hi, bot.cross);
        return hi - lo >= 0.6 * h;
      });
      if (cover.length < 2) continue;
      const left = Math.min(...cover.map((v) => v.cross));
      const right = Math.max(...cover.map((v) => v.cross));
      if (right - left < MIN_FRAME_W_FRAC * W) continue;
      frames.push({ bbox: [left, top.cross, right, bot.cross] });
      i = j + 1; // next frame starts below this one
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  return frames;
}

/**
 * Contents of `extract` inside `frame` grown by `marginPt` (matchline labels sit
 * ON the border), re-based to frame-local coordinates with view = [0,0,w,h].
 */
export function sliceExtract(extract: PageExtract, frame: Frame, marginPt = 36): PageExtract {
  const [fx0, fy0, fx1, fy1] = frame.bbox;
  const gx0 = fx0 - marginPt, gy0 = fy0 - marginPt, gx1 = fx1 + marginPt, gy1 = fy1 + marginPt;
  const inside = (x: number, y: number) => x >= gx0 && x <= gx1 && y >= gy0 && y <= gy1;
  const shift = (l: Label): Label => ({ ...l, x: l.x - fx0, y: l.y - fy0, endX: l.endX - fx0, endY: l.endY - fy0 });
  const keepL = (l: Label) => inside((l.x + l.endX) / 2, (l.y + l.endY) / 2);
  const geometry: typeof extract.geometry = [];
  for (const g of extract.geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of g.pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    if (maxX < gx0 || minX > gx1 || maxY < gy0 || minY > gy1) continue;
    geometry.push({ ...g, pts: g.pts.map((p) => [p[0] - fx0, p[1] - fy0] as [number, number]) });
  }
  return {
    view: [0, 0, fx1 - fx0, fy1 - fy0],
    labels: extract.labels.filter(keepL).map(shift),
    shxLabels: extract.shxLabels.filter(keepL).map(shift),
    words: extract.words.filter(keepL).map(shift),
    geometry,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/features/stitch/autostitch/frameDetect.test.ts`
Expected: PASS (5 tests). Iterate on constants only if a test exposes an off-by-one in binning (adjust expectations' precision, not the algorithm's intent).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/frameDetect.ts src/features/stitch/autostitch/frameDetect.test.ts
git commit -m "feat(autostitch): detect 1-2 plan frames per page from border geometry"
```

---

### Task 5: OCR band math — `ocrBands.ts`

**Files:**
- Create: `src/features/stitch/autostitch/ocrBands.ts`
- Test: `src/features/stitch/autostitch/ocrBands.test.ts`

**Interfaces:**
- Consumes: `RawImage`, `OcrWord` from `ocrService.ts` (types only — safe for vitest).
- Produces (consumed by Task 6):
  - `interface BandSpec { edge: "top" | "bottom" | "left" | "right"; clip: [number, number, number, number] }`
  - `edgeBands(bbox, bandPt?): BandSpec[]` — 4 bands centered on the frame edges
  - `sheetNoBand(view): BandSpec` — bottom-right title-block cell
  - `rotateRaw(img: RawImage, rot: 90 | 270): RawImage` — 90 = clockwise
  - `wordsToLabels(words, band, scale, imgW, imgH, rot, minConf?): Label[]` — OCR px → page-pt `Label`s
  - `parseSheetNumber(words): number | null`

- [ ] **Step 1: Write the failing tests**

Create `ocrBands.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { edgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber } from "./ocrBands";

describe("edgeBands", () => {
  test("bands straddle the frame edges", () => {
    const b = edgeBands([100, 200, 1100, 900], 60);
    const by = Object.fromEntries(b.map((s) => [s.edge, s.clip]));
    expect(by.top).toEqual([100, 140, 1100, 260]);    // y: 200±60
    expect(by.bottom).toEqual([100, 840, 1100, 960]);
    expect(by.left).toEqual([40, 200, 160, 900]);
    expect(by.right).toEqual([1040, 200, 1160, 900]);
  });
});

describe("sheetNoBand", () => {
  test("bottom-right corner cell", () => {
    const s = sheetNoBand([0, 0, 1000, 800]);
    expect(s.edge).toBe("bottom");
    expect(s.clip).toEqual([800, 704, 1000, 800]); // right 20% x bottom 12%
  });
});

describe("rotateRaw", () => {
  // 2x3 image, distinct pixel values in the red channel
  const src = { width: 2, height: 3, data: new Uint8ClampedArray(2 * 3 * 4) };
  // red channel row-major: [[1,2],[3,4],[5,6]]
  [1, 2, 3, 4, 5, 6].forEach((v, i) => { src.data[i * 4] = v; src.data[i * 4 + 3] = 255; });
  const red = (img: { width: number; height: number; data: Uint8ClampedArray }) =>
    Array.from({ length: img.height }, (_, y) =>
      Array.from({ length: img.width }, (_, x) => img.data[(y * img.width + x) * 4]));

  test("90 (clockwise): first src row becomes last dst column", () => {
    const d = rotateRaw(src, 90);
    expect(d.width).toBe(3); expect(d.height).toBe(2);
    expect(red(d)).toEqual([[5, 3, 1], [6, 4, 2]]);
  });
  test("270 (counter-clockwise)", () => {
    const d = rotateRaw(src, 270);
    expect(red(d)).toEqual([[2, 4, 6], [1, 3, 5]]);
  });
});

describe("wordsToLabels", () => {
  const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90) =>
    ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  test("unrotated band maps px back to page pts", () => {
    const band = { edge: "top" as const, clip: [100, 140, 1100, 260] as [number, number, number, number] };
    // scale 2 px/pt; word at image px (40, 20)-(120, 36)
    const ls = wordsToLabels([word("SEE", 40, 20, 120, 36)], band, 2, 2000, 240, 0);
    expect(ls).toHaveLength(1);
    expect(ls[0].x).toBeCloseTo(120);  // 100 + 40/2
    expect(ls[0].y).toBeCloseTo(150);  // 140 + 20/2
    expect(ls[0].endX).toBeCloseTo(160);
    expect(ls[0].endY).toBeCloseTo(158);
    expect(ls[0].text).toBe("SEE");
  });
  test("rot-90 band maps through the inverse rotation", () => {
    // left band clip [40,200]-[160,900], scale 1 → image 120x700, rotated CW → 700x120.
    const band = { edge: "left" as const, clip: [40, 200, 160, 900] as [number, number, number, number] };
    // In the ROTATED image a word occupies (10, 30)-(50, 46).
    // Inverse of CW90: srcX = y, srcY = (rotW - 1) - x  where rotW = 700.
    const ls = wordsToLabels([word("SHEET", 10, 30, 50, 46)], band, 1, 120, 700, 90);
    expect(ls).toHaveLength(1);
    // corners map to src: (30, 689) and (46, 649) → bbox src x:[30,46] y:[649,689]
    expect(ls[0].x).toBeCloseTo(40 + 30);
    expect(ls[0].endX).toBeCloseTo(40 + 46);
    expect(ls[0].y).toBeCloseTo(200 + 649);
    expect(ls[0].endY).toBeCloseTo(200 + 689);
  });
  test("low-confidence words are dropped", () => {
    const band = { edge: "top" as const, clip: [0, 0, 100, 10] as [number, number, number, number] };
    expect(wordsToLabels([word("junk", 0, 0, 5, 5, 30)], band, 1, 100, 10, 0)).toEqual([]);
  });
});

describe("parseSheetNumber", () => {
  const w = (text: string) => ({ text, confidence: 80, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
  test("reads 'SHEET 2 OF 22' shapes", () => {
    expect(parseSheetNumber([w("SHEET"), w("2"), w("OF"), w("22")])).toBe(2);
  });
  test("reads a joined '2 OF 22'", () => {
    expect(parseSheetNumber([w("2 OF 22")])).toBe(2);
  });
  test("null when absent", () => {
    expect(parseSheetNumber([w("ADKAN"), w("ENGINEERS")])).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/stitch/autostitch/ocrBands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ocrBands.ts`**

```typescript
/**
 * Pure math for the OCR band channel: where to raster, how to rotate vertical
 * bands upright, and how OCR word boxes map back to page points as synthetic
 * Labels. No mupdf, no tesseract — everything here runs under vitest.
 * Conventions: page space is points y-down; `rot` 90 = the raster was rotated
 * CLOCKWISE before OCR (so a bottom-up vertical text reads left-to-right).
 */
import type { Label } from "./types";
import type { OcrWord, RawImage } from "./ocrService";

export interface BandSpec { edge: "top" | "bottom" | "left" | "right"; clip: [number, number, number, number] }

/** Four bands straddling a frame's edges (labels sit ON the border). */
export function edgeBands(bbox: [number, number, number, number], bandPt = 60): BandSpec[] {
  const [x0, y0, x1, y1] = bbox;
  return [
    { edge: "top",    clip: [x0, y0 - bandPt, x1, y0 + bandPt] },
    { edge: "bottom", clip: [x0, y1 - bandPt, x1, y1 + bandPt] },
    { edge: "left",   clip: [x0 - bandPt, y0, x0 + bandPt, y1] },
    { edge: "right",  clip: [x1 - bandPt, y0, x1 + bandPt, y1] },
  ];
}

/** Title-block sheet-number cell: bottom-right corner of the PAGE. */
export function sheetNoBand(view: [number, number, number, number]): BandSpec {
  const [x0, y0, x1, y1] = view;
  const W = x1 - x0, H = y1 - y0;
  return { edge: "bottom", clip: [x1 - 0.2 * W, y1 - 0.12 * H, x1, y1] };
}

/** Rotate an RGBA raster. 90 = clockwise, 270 = counter-clockwise. */
export function rotateRaw(img: RawImage, rot: 90 | 270): RawImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [dx, dy] = rot === 90 ? [h - 1 - y, x] : [y, w - 1 - x];
      const si = (y * w + x) * 4, di = (dy * h + dx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { width: h, height: w, data: out };
}

/**
 * Map OCR words (px in the possibly-rotated image) to page-pt Labels.
 * `imgW/imgH` are the dimensions of the image GIVEN TO OCR (post-rotation);
 * `scale` is raster px per page pt. Words under `minConf` are dropped.
 */
export function wordsToLabels(
  words: OcrWord[], band: BandSpec, scale: number,
  imgW: number, imgH: number, rot: 0 | 90 | 270, minConf = 60
): Label[] {
  const [cx0, cy0] = band.clip;
  const out: Label[] = [];
  for (const w of words) {
    if (w.confidence < minConf || !w.text.trim()) continue;
    // corners in the OCR image
    const corners: [number, number][] = [
      [w.bbox.x0, w.bbox.y0], [w.bbox.x1, w.bbox.y0], [w.bbox.x0, w.bbox.y1], [w.bbox.x1, w.bbox.y1],
    ];
    // undo the rotation → pre-rotation raster px
    const src = corners.map(([x, y]): [number, number] => {
      if (rot === 90) return [y, imgW - 1 - x];        // inverse of CW90 (dst = src rotated CW)
      if (rot === 270) return [imgH - 1 - y, x];       // inverse of CCW90
      return [x, y];
    });
    const xs = src.map((p) => p[0]), ys = src.map((p) => p[1]);
    const x = cx0 + Math.min(...xs) / scale, endX = cx0 + Math.max(...xs) / scale;
    const y = cy0 + Math.min(...ys) / scale, endY = cy0 + Math.max(...ys) / scale;
    out.push({ text: w.text.trim(), x, y, endX, endY, angle: 0, h: endY - y, font: "ocr" });
  }
  return out;
}

/** "SHEET 2 OF 22" / "2 OF 22" (words may arrive split) → 2, else null. */
export function parseSheetNumber(words: OcrWord[]): number | null {
  const joined = words.map((w) => w.text).join(" ").toUpperCase();
  const m = joined.match(/(?:SHEET\s+)?(\d{1,3})\s+OF\s+\d{1,3}/);
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/features/stitch/autostitch/ocrBands.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/ocrBands.ts src/features/stitch/autostitch/ocrBands.test.ts
git commit -m "feat(autostitch): OCR band geometry, rotation, and word->label mapping"
```

---

### Task 6: Band rasterizer + OCR orchestration + worker RPC

**Files:**
- Create: `src/features/stitch/autostitch/bandRender.ts`
- Modify: `src/features/stitch/autostitch/autoStitch.ts` (add `ocr` option + per-page OCR recovery; unit building comes in Task 7)
- Modify: `src/features/stitch/autostitch/stitchProbe.worker.ts` (RPC client + pass `ocr` to autoStitch)
- Modify: `src/features/stitch/AddPdfModal.tsx` (attach RPC; pass `ocr` on the main-thread fallback; ignore RPC messages in the existing handler)
- Test: none runnable in vitest (mupdf + tesseract); validated via the harness in Task 10. Keep this task purely mechanical.

**Interfaces:**
- Consumes: `edgeBands`, `sheetNoBand`, `rotateRaw`, `wordsToLabels`, `parseSheetNumber` (Task 5); `recognize`, `attachOcrRpc`, `RawImage`, `OcrWord` (Task 1).
- Produces:
  - `renderBand(mupdf, page, clip, dpi?): { image: RawImage; scale: number }` in `bandRender.ts`
  - `AutoStitchOptions.ocr?: (image: RawImage) => Promise<OcrWord[]>`
  - `recoverLabels(mupdf, page, frames, view, ocr): Promise<{ labels: Label[]; printedNo: number | null }>` exported from `autoStitch.ts`
  - Worker RPC protocol: worker→main `{kind:"ocr-req", ocrId, image}`, main→worker `{kind:"ocr-res", ocrId, words}`.

- [ ] **Step 1: Write `bandRender.ts`**

```typescript
/**
 * Rasterize a page clip to a RawImage for OCR. Thin mupdf shim — everything
 * downstream of the pixels is pure and tested in ocrBands.test.ts. Runs
 * wherever the mupdf document lives (probe worker, or main thread in the
 * modal's fallback path). Pixmaps are created and destroyed per call.
 */
import type { RawImage } from "./ocrService";

export function renderBand(
  mupdf: any, page: any, clip: [number, number, number, number], dpi = 200
): { image: RawImage; scale: number } {
  const S = dpi / 72;
  const bbox = [Math.floor(clip[0] * S), Math.floor(clip[1] * S), Math.ceil(clip[2] * S), Math.ceil(clip[3] * S)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true /* alpha */);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(S, S), pix);
    page.run(dev, mupdf.Matrix.identity);
    dev.close();
    return {
      image: { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8ClampedArray(pix.getPixels()) },
      scale: S,
    };
  } finally {
    pix.destroy?.();
  }
}
```

- [ ] **Step 2: Add OCR recovery to `autoStitch.ts`**

Add imports and the option, and export the recovery helper (used by the pipeline in Task 7 — for THIS task it only needs to compile):

```typescript
import { edgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber } from "./ocrBands";
import { renderBand } from "./bandRender";
import type { OcrWord, RawImage } from "./ocrService";
import type { Frame } from "./frameDetect";
import type { Label } from "./types";
```

```typescript
export interface AutoStitchOptions {
  userScale?: number | null;
  onProgress?: (done: number, total: number) => void;
  /** OCR callback (main thread: ocrService.recognize; worker: the RPC shim). Absent → no OCR channel. */
  ocr?: (image: RawImage) => Promise<OcrWord[]>;
}
```

```typescript
/**
 * OCR the edge bands of each frame + the title-block cell of one page.
 * Vertical bands are OCR'd at 90 AND 270 and the higher-total-confidence
 * orientation wins (sets differ in which way side text runs). Returns
 * synthetic page-space Labels and the printed sheet number (null unless read).
 */
export async function recoverLabels(
  mupdf: any, page: any, frames: Frame[],
  view: [number, number, number, number],
  ocr: (image: RawImage) => Promise<OcrWord[]>
): Promise<{ labels: Label[]; printedNo: number | null }> {
  const labels: Label[] = [];
  for (const f of frames) {
    for (const band of edgeBands(f.bbox)) {
      const { image, scale } = renderBand(mupdf, page, band.clip);
      if (band.edge === "left" || band.edge === "right") {
        const cands: { rot: 90 | 270; words: OcrWord[] }[] = [];
        for (const rot of [90, 270] as const) {
          const r = rotateRaw(image, rot);
          cands.push({ rot, words: await ocr(r) });
        }
        const score = (ws: OcrWord[]) => ws.reduce((s, w) => s + Math.max(0, w.confidence - 50), 0);
        const best = cands.sort((a, b) => score(b.words) - score(a.words))[0];
        labels.push(...wordsToLabels(best.words, band, scale, image.height, image.width, best.rot));
      } else {
        labels.push(...wordsToLabels(await ocr(image), band, scale, image.width, image.height, 0));
      }
    }
  }
  const nb = sheetNoBand(view);
  const { image, scale } = renderBand(mupdf, page, nb.clip);
  void scale;
  const printedNo = parseSheetNumber(await ocr(image));
  return { labels, printedNo };
}
```

(Note the rotated call passes `imgW = image.height, imgH = image.width` — the post-rotation dimensions, matching the Task 5 contract.)

- [ ] **Step 3: Worker-side RPC in `stitchProbe.worker.ts`**

Replace the file's message handling with:

```typescript
import { autoStitch } from "./autoStitch";
import { toProbeResult, type ProbeRequest, type ProbeMessage } from "./stitchProbe";
import type { OcrWord, RawImage } from "./ocrService";

let mupdf: any = null;
async function ensureMupdf() {
  if (!mupdf) mupdf = (await import("mupdf")).default;
}

// ── OCR over RPC to the main thread (tesseract cannot nest here portably) ──
let ocrSeq = 0;
const ocrPending = new Map<number, (words: OcrWord[]) => void>();
const OCR_TIMEOUT_MS = 30_000;
function ocrViaMain(image: RawImage): Promise<OcrWord[]> {
  return new Promise((resolve) => {
    const id = ++ocrSeq;
    const timer = setTimeout(() => { ocrPending.delete(id); resolve([]); }, OCR_TIMEOUT_MS);
    ocrPending.set(id, (words) => { clearTimeout(timer); resolve(words); });
    (self as any).postMessage({ kind: "ocr-req", ocrId: id, image }, [image.data.buffer]);
  });
}

let latestDocId = 0;
let queue: Promise<void> = Promise.resolve();

async function handle(req: ProbeRequest) {
  const { docId, pdfBytes, pageIndices, userScale } = req;
  if (docId !== latestDocId) return;
  try {
    await ensureMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    let res;
    try {
      res = await autoStitch(mupdf, doc, pageIndices, { userScale, ocr: ocrViaMain });
    } finally {
      doc.destroy?.();
    }
    const msg: ProbeMessage = toProbeResult(res, docId);
    self.postMessage(msg);
  } catch (err) {
    const msg: ProbeMessage = { docId, error: String(err) };
    self.postMessage(msg);
  }
}

self.onmessage = (e: MessageEvent<any>) => {
  if (e.data && e.data.kind === "ocr-res") {
    const cb = ocrPending.get(e.data.ocrId);
    ocrPending.delete(e.data.ocrId);
    cb?.(e.data.words as OcrWord[]);
    return;
  }
  latestDocId = (e.data as ProbeRequest).docId;
  // .catch keeps the chain self-healing (see prior comment history).
  queue = queue.then(() => handle(e.data as ProbeRequest)).catch(() => {});
};
```

- [ ] **Step 4: Main-thread hookup in `AddPdfModal.tsx`**

At worker construction (line ~135, `const w = new Worker(...)`), attach the RPC immediately after:

```typescript
    const w = new Worker(new URL("./autostitch/stitchProbe.worker.ts", import.meta.url), { type: "module" });
    attachOcrRpc(w);
```

with import `import { attachOcrRpc, recognize } from "./autostitch/ocrService";`.

In the worker's existing `onmessage` result handler (where it reads `ProbeMessage`), ignore RPC frames — add as the first line:

```typescript
      if ((e.data as any)?.kind) return; // ocr-req frames are handled by attachOcrRpc
```

In `handleAddAndAutoAlign`'s live fallback path, pass OCR to the main-thread run:

```typescript
        const result = await autoStitch(mupdf, mupdfDoc, selected, {
          userScale: Number.isFinite(userScaleNum) && userScaleNum > 0 ? userScaleNum : null,
          onProgress: (done, total) => setAddingProgress({ done, total }),
          ocr: recognize,
        });
```

- [ ] **Step 5: Typecheck, run tests, commit**

```bash
npx tsc --noEmit
npm run test:run
git add src/features/stitch/autostitch/bandRender.ts src/features/stitch/autostitch/autoStitch.ts \
        src/features/stitch/autostitch/stitchProbe.worker.ts src/features/stitch/AddPdfModal.tsx
git commit -m "feat(autostitch): OCR band recovery + main-thread OCR RPC for the probe worker"
```

---

### Task 7: Units through the pipeline — `autoStitch.ts` + `stitchSheets`

The core structural change: the stitch unit becomes (page, frame). `autoStitch` builds one `SheetInput` per frame (normalized extracts, OCR-recovered labels merged in), wires printed numbers and sibling links; `stitchSheets` resolves refs against printed numbers and adds sibling pairs.

**Files:**
- Modify: `src/features/stitch/autostitch/autoStitch.ts` (full rewrite below)
- Modify: `src/features/stitch/autostitch/stitchCore.ts` (`SheetInput` fields; ref resolution; sibling pairs; `matchlineStrokePrior` printed-no check)
- Test: `src/features/stitch/autostitch/stitchCore.test.ts`

**Interfaces:**
- Consumes: `detectFrames`, `sliceExtract` (Task 4); `recoverLabels` (Task 6); strip refs (Task 3).
- Produces:
  - `SheetInput` gains: `printedNo: number` (printed sheet number, shared by both strips of a page), `siblingKey?: number` (the other unit of the same page), `pageIndex: number`, `frame?: [number,number,number,number]` (page-pt bbox; absent = whole page).
  - `AutoStitchResult.poses: PlacedSheetPose[]` becomes per-unit, each carrying `frame?` (Task 8 consumes).

- [ ] **Step 1: Write the failing stitchCore test (synthetic PG_SITE topology)**

Append to `stitchCore.test.ts`:

```typescript
import { stitchSheets, type SheetInput } from "./stitchCore";

describe("unit stitching (frames + printed numbers + strip refs)", () => {
  // Strip-plan chain, all horizontal (west→east) so the test does not depend
  // on the solver's vertical-axis naming convention:
  //   unit1 = top strip of printed sheet 2 ("SEE BELOW LEFT" on its right edge)
  //   unit2 = bottom strip of sheet 2 (continues east; "SEE ABOVE RIGHT" left
  //           edge, "SEE SHEET 9" right edge)
  //   unit3 = printed sheet 9 ("SEE SHEET 2" on its left edge)
  // World layout (feet): unit1 at (0,0); unit2 at (170,10); unit3 at (340,20).
  // Each adjacent pair shares a distinctive zigzag polyline in its ~30ft overlap.
  const view: [number, number, number, number] = [0, 0, 720, 480]; // 200x133 ft at scale 20
  const lbl = (text: string, x: number, y: number) =>
    ({ text, x, y, endX: x + 60, endY: y + 8, angle: 0, h: 8, font: null, atoms: 3 });
  const SCALE = 20;
  const ftToPt = (ft: number) => (ft / SCALE) * 72;
  /** Irregular polyline (distinct segment len/angle signatures) starting at world x. */
  const zig = (worldX0: number, worldY0: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 14; i++) pts.push([worldX0 + i * 7 + (i % 3) * 2, worldY0 + 30 + (i % 5) * 11]);
    return pts;
  };
  /** Materialize a world-ft polyline into a unit whose frame origin sits at (ox, oy) world-ft. */
  const geomFor = (id: string, world: [number, number][], ox: number, oy: number) => [{
    id, closed: false,
    pts: world.map(([wx, wy]): [number, number] => [ftToPt(wx - ox), ftToPt(wy - oy)]),
  }];
  const zA = zig(175, 15);  // in the unit1/unit2 overlap band
  const zB = zig(345, 25);  // in the unit2/unit3 overlap band
  const unit1: SheetInput = {
    id: "p1f0", no: 1, printedNo: 2, pageIndex: 1, siblingKey: 2, scale: SCALE, view,
    frame: [100, 60, 820, 540],
    extract: { view, words: [], shxLabels: [],
      labels: [lbl("SEE BELOW LEFT", 640, 300)],
      geometry: geomFor("zA1", zA, 0, 0) },
  };
  const unit2: SheetInput = {
    id: "p1f1", no: 2, printedNo: 2, pageIndex: 1, siblingKey: 1, scale: SCALE, view,
    frame: [100, 620, 820, 1100],
    extract: { view, words: [], shxLabels: [],
      labels: [lbl("SEE ABOVE RIGHT", 5, 100), lbl("SEE SHEET 9", 640, 200)],
      geometry: [...geomFor("zA2", zA, 170, 10), ...geomFor("zB2", zB, 170, 10)] },
  };
  const unit3: SheetInput = {
    id: "p8f0", no: 3, printedNo: 9, pageIndex: 8, scale: SCALE, view,
    frame: [100, 60, 820, 540],
    extract: { view, words: [], shxLabels: [],
      labels: [lbl("SEE SHEET 2", 5, 200)],
      geometry: geomFor("zB3", zB, 340, 20) },
  };

  test("strip + numeric refs place the chain west-to-east", () => {
    const res = stitchSheets([unit1, unit2, unit3]);
    expect(res.method).toBe("geometric");
    const p1 = res.placements.get(1)!, p2 = res.placements.get(2)!, p3 = res.placements.get(3)!;
    expect(p1).toBeDefined(); expect(p2).toBeDefined(); expect(p3).toBeDefined();
    expect(p2.x - p1.x).toBeGreaterThan(150); expect(p2.x - p1.x).toBeLessThan(190);
    expect(Math.abs(p2.y - p1.y)).toBeLessThan(30);
    expect(p3.x - p1.x).toBeGreaterThan(320); expect(p3.x - p1.x).toBeLessThan(360);
    expect(Math.abs(p3.y - p1.y)).toBeLessThan(40);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts -t "unit stitching"`
Expected: FAIL — `printedNo` not a `SheetInput` property (TS error) → then, after the interface exists, refs resolving `9`/`2` fail because resolution still keys on `no`.

- [ ] **Step 3: `stitchCore.ts` modifications**

3a. `SheetInput` and `DriverSheet`:

```typescript
export interface SheetInput {
  id: string; no: number; scale: number; view: [number, number, number, number]; extract: PageExtract;
  /** Printed sheet number (title block); both strips of a page share it. Defaults to `no`. */
  printedNo?: number;
  /** Key (`no`) of the other frame on the same page, when the page has two. */
  siblingKey?: number;
  pageIndex?: number;
  /** Page-pt bbox of this unit's frame; absent = whole page. */
  frame?: [number, number, number, number];
}
```

In the `sheets` mapping inside `stitchSheets`, carry the new fields:

```typescript
    return {
      id: s.id, no: s.no, scale: s.scale, view: s.view,
      raw: { shxLabels: text, labels: s.extract.labels || [], geometry: s.extract.geometry || [], view: s.view },
      key: s.no, sheetCode: label.sheetCode,
      printedNo: s.printedNo ?? s.no, siblingKey: s.siblingKey, pageIndex: s.pageIndex,
    };
```

and add to `DriverSheet`: `printedNo: number; siblingKey?: number; pageIndex?: number;`.

3b. Printed-number resolution. After `const byNo = new Map(...)`, add:

```typescript
  // printed sheet number -> units carrying it (both strips of a page share one)
  const byPrinted = new Map<number, DriverSheet[]>();
  for (const s of sheets) (byPrinted.get(s.printedNo) || byPrinted.set(s.printedNo, []).get(s.printedNo)!).push(s);
```

3c. Replace the `relOf` construction loop body's target resolution ("resolve the neighbor" block) with printed-number + strip resolution:

```typescript
  for (const s of sheets) {
    const refs = parseSheetRefs(s.raw.shxLabels, s.raw.view).filter((r) => r.edge !== "interior");
    for (const r of refs) {
      const targets: DriverSheet[] = [];
      if (r.strip && s.siblingKey != null && byNo.has(s.siblingKey)) {
        targets.push(byNo.get(s.siblingKey)!);
      } else if (r.sheet != null) {
        for (const t of byPrinted.get(r.sheet) || []) if (t.pageIndex !== s.pageIndex) targets.push(t);
      } else if (r.sheetCode) {
        const t = codeToNo.get(r.sheetCode.toUpperCase());
        if (t != null && t !== s.no && byNo.has(t)) targets.push(byNo.get(t)!);
      }
      for (const t of targets) {
        if (!relOf.has(`${s.no}-${t.no}`)) relOf.set(`${s.no}-${t.no}`, EDGE2REL[r.edge]);
        pairKeys.add(s.no < t.no ? `${s.no}-${t.no}` : `${t.no}-${s.no}`);
      }
    }
  }
```

Note this now also feeds `pairKeys` directly (refs are adjacency evidence), so **move the `const pairKeys = new Set<string>();` declaration above this loop** and delete the old `for (const k of relOf.keys()) {...}` seeding loop below (it's subsumed).

3d. `matchlineStrokePrior` printed-number check — in its `refs` closure change `other.no` to the printed number:

```typescript
  const refs = (r: any, other: any) =>
    (r.sheet != null && r.sheet === (other.printedNo ?? other.no)) ||
    (r.sheetCode && other.sheetCode && r.sheetCode.toUpperCase() === other.sheetCode.toUpperCase());
```

3e. Guard the keymap early-return: key-map grids are keyed by printed/synthetic sheet `no` and are whole-page; a document that produced multi-frame units skips the grid path. At the top of the `if (grid && grid.size >= 2)` block add:

```typescript
  const hasSplitPages = sheets.some((s) => s.siblingKey != null);
  if (grid && grid.size >= 2 && !hasSplitPages) {
```

(and adjust the closing brace accordingly).

- [ ] **Step 4: Rewrite `autoStitch.ts` (complete file)**

```typescript
import type { PageExtract, Label } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10 of the original
// roadmap. Do not import it yet.
import { stitchSheets, type SheetInput, type StitchMethod } from "./stitchCore";
import { detectKeymapGrid } from "./keymap";
import { detectFrames, sliceExtract, type Frame } from "./frameDetect";
import { layoutPlacements, type TilePlacement, type PlacedSheetPose } from "./layout";
import { edgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber } from "./ocrBands";
import { renderBand } from "./bandRender";
import { parseSheetRefs } from "./tokens";
import type { OcrWord, RawImage } from "./ocrService";

const DEFAULT_SCALE = 20;

export interface AutoStitchOptions {
  userScale?: number | null;
  onProgress?: (done: number, total: number) => void;
  /** OCR callback (main thread: ocrService.recognize; worker: the RPC shim). Absent → no OCR channel. */
  ocr?: (image: RawImage) => Promise<OcrWord[]>;
}
export interface AutoStitchResult {
  placements: TilePlacement[];
  rootFtPerIn: number;
  alignedCount: number;
  unplacedCount: number;
  worstResidFt: number;
  method: StitchMethod;
  poses: PlacedSheetPose[];
}

/** Yield to the event loop so the tab stays responsive between page extractions. */
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** True when the page's existing text already provides edge refs (no OCR needed). */
function hasEdgeRefs(extract: PageExtract): boolean {
  const all = [...extract.shxLabels, ...extract.labels];
  return parseSheetRefs(all, extract.view).some((r) => r.edge !== "interior");
}

interface Unit {
  pageIndex: number;
  frame: Frame | null;      // null = whole page
  extract: PageExtract;     // frame-local when frame != null
  sizePt: { w: number; h: number }; // FULL page size
  scale: number;
  printedNo: number;
  key: number;              // unique numeric key (assigned after uniquify)
}

export async function autoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions = {}
): Promise<AutoStitchResult> {
  const total = pageIndices.length;
  const units: Unit[] = [];
  const pageSize = new Map<number, { w: number; h: number }>();

  for (let i = 0; i < pageIndices.length; i++) {
    const pageIndex = pageIndices[i];
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    let frames: Frame[] = [];
    let printedNo: number | null = null;
    let recovered: Label[] = [];
    try {
      extract = capturePage(mupdf, page);
      frames = detectFrames(extract);
      // OCR recovery: only when the text channels are starved AND we have frames.
      if (opts.ocr && frames.length && !hasEdgeRefs(extract)) {
        for (const f of frames) {
          for (const band of edgeBands(f.bbox)) {
            const { image, scale } = renderBand(mupdf, page, band.clip);
            if (band.edge === "left" || band.edge === "right") {
              const cands: { rot: 90 | 270; words: OcrWord[] }[] = [];
              for (const rot of [90, 270] as const) cands.push({ rot, words: await opts.ocr(rotateRaw(image, rot)) });
              const score = (ws: OcrWord[]) => ws.reduce((s, w) => s + Math.max(0, w.confidence - 50), 0);
              const best = cands.sort((a, b) => score(b.words) - score(a.words))[0];
              recovered.push(...wordsToLabels(best.words, band, scale, image.height, image.width, best.rot));
            } else {
              recovered.push(...wordsToLabels(await opts.ocr(image), band, scale, image.width, image.height, 0));
            }
          }
        }
        const nb = sheetNoBand(extract.view);
        const { image } = renderBand(mupdf, page, nb.clip);
        printedNo = parseSheetNumber(await opts.ocr(image));
      }
    } finally {
      page.destroy?.();
    }
    if (recovered.length) extract = { ...extract, labels: [...extract.labels, ...recovered] };

    // Printed sheet number: OCR > "SHEET n OF m" text > page order.
    if (printedNo == null) {
      for (const l of [...extract.shxLabels, ...extract.labels]) {
        const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
        if (m) { printedNo = Number(m[1]); break; }
      }
    }
    if (printedNo == null) printedNo = pageIndex + 1;

    const w = extract.view[2] - extract.view[0];
    const h = extract.view[3] - extract.view[1];
    pageSize.set(pageIndex, { w, h });
    // Scale inference is deferred; uniform scale (user-entered or default).
    const scale = opts.userScale && opts.userScale > 0 ? opts.userScale : DEFAULT_SCALE;

    if (frames.length >= 2) {
      for (const f of frames.slice(0, 2)) {
        units.push({ pageIndex, frame: f, extract: sliceExtract(extract, f), sizePt: { w, h }, scale, printedNo, key: 0 });
      }
    } else if (frames.length === 1) {
      units.push({ pageIndex, frame: frames[0], extract: sliceExtract(extract, frames[0]), sizePt: { w, h }, scale, printedNo, key: 0 });
    } else {
      units.push({ pageIndex, frame: null, extract, sizePt: { w, h }, scale, printedNo, key: 0 });
    }
    opts.onProgress?.(i + 1, total);
  }

  if (!units.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0, method: "none", poses: [] };

  // Unique numeric keys, stable order.
  units.forEach((u, i) => { u.key = i + 1; });
  const rootFtPerIn = units[0].scale;

  let placementsByKey = new Map<number, { x: number; y: number }>();
  let worstResidFt = 0;
  let method: StitchMethod = "none";
  if (units.length >= 2) {
    const byPage = new Map<number, Unit[]>();
    for (const u of units) (byPage.get(u.pageIndex) || byPage.set(u.pageIndex, []).get(u.pageIndex)!).push(u);
    const inputs: SheetInput[] = units.map((u) => ({
      id: `p${u.pageIndex}f${u.frame ? "1" : "0"}k${u.key}`, no: u.key, scale: u.scale,
      view: u.extract.view, extract: u.extract,
      printedNo: u.printedNo, pageIndex: u.pageIndex,
      siblingKey: byPage.get(u.pageIndex)!.find((o) => o.key !== u.key)?.key,
      frame: u.frame?.bbox,
    }));
    // Key-map site grid (whole-page sets only; stitchSheets ignores it when
    // any page produced two units). Grid is keyed by unit key here.
    let grid: Map<number, { col: number; row: number }> | undefined;
    try {
      const byPageGrid = detectKeymapGrid(mupdf, doc, pageIndices);
      if (byPageGrid) {
        grid = new Map();
        for (const u of units) { const g = byPageGrid.get(u.pageIndex); if (g) grid.set(u.key, g); }
        if (grid.size < 2) grid = undefined;
      }
    } catch (e) {
      console.warn("[autoStitch] key-map detection failed:", e);
    }
    const res = stitchSheets(inputs, grid);
    placementsByKey = res.placements;
    worstResidFt = res.worstResidFt;
    method = res.method;
  }

  // Per-unit poses for placed units; ONE whole-page null pose per fully-unplaced page.
  const poses: PlacedSheetPose[] = [];
  const pagesEmitted = new Set<number>();
  for (const u of units) {
    const pos = placementsByKey.get(u.key) ?? null;
    if (pos) {
      poses.push({ pageIndex: u.pageIndex, scale: u.scale, sizePt: u.sizePt, posFt: pos, frame: u.frame?.bbox });
      pagesEmitted.add(u.pageIndex);
    }
  }
  for (const u of units) {
    if (pagesEmitted.has(u.pageIndex)) continue;
    pagesEmitted.add(u.pageIndex);
    poses.push({ pageIndex: u.pageIndex, scale: u.scale, sizePt: u.sizePt, posFt: null });
  }

  const placements = layoutPlacements(poses, rootFtPerIn);
  const alignedCount = placements.filter((p) => p.aligned).length;
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt, method, poses };
}
```

This rewrite inlines Task 6's `recoverLabels` helper into the capture loop; delete the standalone `recoverLabels` export while applying it (the listing above is the complete final file).

- [ ] **Step 5: Run the target test, then the full suite**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts`
Expected: the new "unit stitching" test PASSES; all pre-existing stitchCore tests PASS (whole-page callers set none of the new optional fields, so `printedNo` defaults to `no` and behavior is unchanged).

Run: `npx tsc --noEmit && npm run test:run`
Expected: layout tests still pass (poses without `frame` behave as before — `frame` is optional until Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/features/stitch/autostitch/autoStitch.ts src/features/stitch/autostitch/stitchCore.ts src/features/stitch/autostitch/stitchCore.test.ts
git commit -m "feat(autostitch): stitch (page,frame) units with printed-number and strip-ref resolution"
```

---

### Task 8: Frame-anchored layout + `frameMask`

**Files:**
- Modify: `src/features/stitch/autostitch/layout.ts`
- Test: `src/features/stitch/autostitch/layout.test.ts`

**Interfaces:**
- Consumes: per-unit poses with optional `frame` (Task 7).
- Produces (consumed by Task 9):
  - `PlacedSheetPose.frame?: [number, number, number, number]`
  - `TilePlacement.sourceFrame?: [number, number, number, number]` (copied through)
  - `frameMask(frame, pageW, pageH): { x: number; y: number; w: number; h: number }[]` — fractional complement masks (≤4, may overlap at corners)

- [ ] **Step 1: Write the failing tests**

Append to `layout.test.ts`:

```typescript
import { frameMask } from "./layout";

describe("frame-anchored layout", () => {
  test("page origin is offset so the FRAME lands at the solved position", () => {
    // Two units, same scale: root frame at (0,0)ft, second at (100,0)ft.
    // Frames are inset 100pt from their page origins → page tiles must sit
    // 100*si pt left of where a whole-page pose would.
    const poses = [
      { pageIndex: 0, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 0, y: 0 }, frame: [100, 50, 700, 450] as [number, number, number, number] },
      { pageIndex: 1, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 100, y: 0 }, frame: [100, 50, 700, 450] as [number, number, number, number] },
    ];
    const out = layoutPlacements(poses, 20, { margin: 0 });
    // P = 72/20 = 3.6 pt/ft; si = 1
    expect(out[0].x).toBeCloseTo(-100);       // 0*P - frameX*si
    expect(out[0].y).toBeCloseTo(-50);
    expect(out[1].x).toBeCloseTo(100 * 3.6 - 100);
    expect(out[0].sourceFrame).toEqual([100, 50, 700, 450]);
  });
  test("two units of one page yield two placements for that pageIndex", () => {
    const poses = [
      { pageIndex: 3, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 0, y: 0 }, frame: [50, 40, 700, 220] as [number, number, number, number] },
      { pageIndex: 3, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 0, y: 60 }, frame: [50, 260, 700, 440] as [number, number, number, number] },
    ];
    const out = layoutPlacements(poses, 20, { margin: 0 });
    expect(out.filter((p) => p.pageIndex === 3)).toHaveLength(2);
    expect(out[0].aligned && out[1].aligned).toBe(true);
  });
});

describe("frameMask", () => {
  test("complement of an inset frame is 4 fractional bands", () => {
    const m = frameMask([100, 50, 700, 450], 720, 480);
    expect(m).toEqual([
      { x: 0, y: 0, w: 1, h: 50 / 480 },                    // top
      { x: 0, y: 450 / 480, w: 1, h: 1 - 450 / 480 },       // bottom
      { x: 0, y: 0, w: 100 / 720, h: 1 },                   // left
      { x: 700 / 720, y: 0, w: 1 - 700 / 720, h: 1 },       // right
    ]);
  });
  test("full-page frame yields no masks", () => {
    expect(frameMask([0, 0, 720, 480], 720, 480)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/stitch/autostitch/layout.test.ts`
Expected: FAIL — `frameMask` not exported; `sourceFrame` undefined.

- [ ] **Step 3: Implement in `layout.ts`**

Extend the interfaces:

```typescript
export interface PlacedSheetPose {
  pageIndex: number;
  scale: number; // ftPerIn
  sizePt: { w: number; h: number };
  posFt: { x: number; y: number } | null; // null => could not be placed
  /** Page-pt bbox of the frame this pose anchors; absent = whole page. */
  frame?: [number, number, number, number];
}
export interface TilePlacement {
  pageIndex: number;
  x: number; y: number; width: number; height: number;
  aligned: boolean;
  /** Copied from the pose: the frame this tile shows (mask the rest). */
  sourceFrame?: [number, number, number, number];
}
```

In `layoutPlacements`, the placed loop becomes:

```typescript
    for (const s of placed) {
      const si = (P * s.scale) / 72; // == s.scale / rootFtPerIn
      const width = s.sizePt.w * si;
      const height = s.sizePt.h * si;
      const fx = s.frame ? s.frame[0] : 0;
      const fy = s.frame ? s.frame[1] : 0;
      const x = (s.posFt!.x - minX) * P + MARGIN - fx * si;
      const y = (s.posFt!.y - minY) * P + MARGIN - fy * si;
      out.push({ pageIndex: s.pageIndex, x, y, width, height, aligned: true, sourceFrame: s.frame });
      maxYCanvas = Math.max(maxYCanvas, y + height);
    }
```

Append the mask helper:

```typescript
/**
 * Fractional hiddenRegions masking everything OUTSIDE `frame` on a page of
 * pageW x pageH pts. Full-height side bands + full-width top/bottom bands
 * (overlapping at corners — harmless for masks). Empty for a full-page frame.
 */
export function frameMask(
  frame: [number, number, number, number], pageW: number, pageH: number
): { x: number; y: number; w: number; h: number }[] {
  const [fx0, fy0, fx1, fy1] = frame;
  const EPS = 1e-3;
  const out: { x: number; y: number; w: number; h: number }[] = [];
  if (fy0 / pageH > EPS) out.push({ x: 0, y: 0, w: 1, h: fy0 / pageH });
  if (1 - fy1 / pageH > EPS) out.push({ x: 0, y: fy1 / pageH, w: 1, h: 1 - fy1 / pageH });
  if (fx0 / pageW > EPS) out.push({ x: 0, y: 0, w: fx0 / pageW, h: 1 });
  if (1 - fx1 / pageW > EPS) out.push({ x: fx1 / pageW, y: 0, w: 1 - fx1 / pageW, h: 1 });
  return out;
}
```

- [ ] **Step 4: Run the layout suite**

Run: `npx vitest run src/features/stitch/autostitch/layout.test.ts`
Expected: PASS (new + pre-existing — poses without `frame` get `fx = fy = 0`, identical math to before).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/layout.ts src/features/stitch/autostitch/layout.test.ts
git commit -m "feat(autostitch): frame-anchored tile layout + hiddenRegions frame masks"
```

---

### Task 9: Probe result + modal commit path

**Files:**
- Modify: `src/features/stitch/autostitch/stitchProbe.ts`
- Modify: `src/features/stitch/AddPdfModal.tsx`
- Test: `src/features/stitch/autostitch/stitchProbe.test.ts`

**Interfaces:**
- Consumes: `TilePlacement.sourceFrame`, `frameMask` (Task 8); per-unit poses (Task 7).
- Produces: `ProbeResult.alignedPageIndices` deduped; tiles committed one per PLACEMENT with `hiddenRegions` masks. `deriveFeasibility` is unchanged (page-level indices still).

- [ ] **Step 1: Write the failing test**

Append to `stitchProbe.test.ts`:

```typescript
test("alignedPageIndices dedupes two placed units of one page", () => {
  const placement = (pageIndex: number) =>
    ({ pageIndex, x: 0, y: 0, width: 10, height: 10, aligned: true });
  const res = toProbeResult({
    placements: [placement(3), placement(3), placement(5)],
    rootFtPerIn: 20, alignedCount: 3, unplacedCount: 0, worstResidFt: 0.1,
    method: "geometric",
    poses: [],
  } as any, 7);
  expect(res.alignedPageIndices).toEqual([3, 5]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/stitch/autostitch/stitchProbe.test.ts`
Expected: FAIL — receives `[3, 3, 5]`.

- [ ] **Step 3: Dedupe in `toProbeResult`**

```typescript
    alignedPageIndices: [...new Set(res.placements.filter((p) => p.aligned).map((p) => p.pageIndex))],
```

- [ ] **Step 4: Commit tiles per placement in `AddPdfModal.tsx`**

Add `frameMask` to the layout import: `import { layoutPlacements, frameMask, type TilePlacement } from "./autostitch/layout";`

In `handleAddAndAutoAlign`, replace step 3 ("Build aligned tiles...") — the `byPage`/`newTiles` block (currently `const byPage = new Map(...)` through `addTiles(newTiles);`) — with:

```typescript
      // 3. Build one tile per PLACEMENT (a two-strip page commits twice, each
      //    masked to its own frame) and commit as one undo step.
      const newTiles = placements.map((p) => {
        const page = mupdfDoc.loadPage(p.pageIndex);
        const bounds = page.getBounds();
        page.destroy?.();
        const pw = bounds[2] - bounds[0], ph = bounds[3] - bounds[1];
        return {
          sourcePdfBytes: pdfBytes,
          sourcePageIndex: p.pageIndex,
          sourceFileName: pdfFileName || undefined,
          x: p.x, y: p.y,
          width: p.width, height: p.height,
          imageDataUrl: rasters.get(p.pageIndex),
          hiddenRegions: p.sourceFrame ? frameMask(p.sourceFrame, pw, ph) : undefined,
        };
      });
      addTiles(newTiles);
```

Step 4 of the handler ("Leave unaligned tiles selected") uses `added = tiles.slice(-selected.length)` — placements can now exceed `selected.length`; change to:

```typescript
      const added = useStitchStore.getState().tiles.slice(-newTiles.length);
```

(the `alignedSet`-by-`sourcePageIndex` logic below it is still correct — both strips of a page are aligned together or not at all).

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npx tsc --noEmit
npm run test:run
git add src/features/stitch/autostitch/stitchProbe.ts src/features/stitch/autostitch/stitchProbe.test.ts src/features/stitch/AddPdfModal.tsx
git commit -m "feat(stitch): commit per-unit tiles with frame masks; dedupe probe page indices"
```

---

### Task 10: Harness upgrade + acceptance on PG_SITE 1A + regression

**Files:**
- Modify: `src/features/dev/AutoStitchSmokeHarness.tsx`

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Harness prints per-unit results and passes OCR**

In `AutoStitchSmokeHarness.tsx`'s `onFile`, pass OCR and print frames:

```typescript
      const { recognize } = await import("@/features/stitch/autostitch/ocrService");
      const res = await autoStitch(mupdf, doc, indices, {
        ocr: recognize,
        onProgress: (done, total) => setLog(`Analyzing page ${done}/${total}…`),
      });
```

and the line formatter:

```typescript
      const lines = res.placements.map(
        (p) => `  page ${p.pageIndex}${p.sourceFrame ? ` frame[${p.sourceFrame.map((v) => v.toFixed(0)).join(",")}]` : ""}: ${p.aligned ? "ALIGNED" : "unplaced"}  x=${p.x.toFixed(0)} y=${p.y.toFixed(0)}`
      );
```

- [ ] **Step 2: Acceptance run — PG_SITE 1A**

Run: `npm run dev` → `http://localhost:1420/dev/autostitch` → main input → `~/Downloads/PG_SITE 1A.pdf`.

Expected (all must hold):
- `method=geometric`; plan pages p1–p10 and p13–p16 report ALIGNED (p1 twice, as two frames).
- Cover (p0), details (p11, p12, p17), notes (p18–p21) report unplaced.
- `worstSeam` < 1 ft.
- Placements are non-overlapping: no two ALIGNED frames within 200 canvas pt of each other unless truly adjacent (eyeball the x/y list — the Task-0 failure mode was six sheets within ~100 pt).

If frames misdetect or refs misresolve, debug via the browser console with `import('/src/features/stitch/autostitch/frameDetect.ts')` against `window`-stashed extracts (see memory note `pg-site-1a-autostitch-failure` for the technique) — fix, re-run, do NOT skip to Step 3 with a partial pass.

- [ ] **Step 3: End-to-end in the real modal**

In the app: open a document → Stitch PDFs → pick PG_SITE 1A → select all pages → the auto-align button should enable (feasibility gate) → Add & auto-align.
Expected: canvas shows the aligned site plan; p1's two strips appear as two tiles, each showing only its own strip (masks working); no console errors. Verify one strip tile: select it — moving it moves only that strip.

- [ ] **Step 4: Regression — known-good set**

Re-run the harness on a token-rich set that stitched before (e.g. the Santee pair referenced in the harness docstring, or any set from prior audits). Expected: same aligned count as before this plan; `method=geometric`; no new unplaced pages.

- [ ] **Step 5: Full suite + commit**

```bash
npx tsc --noEmit
npm run test:run
git add src/features/dev/AutoStitchSmokeHarness.tsx
git commit -m "feat(autostitch): OCR-aware smoke harness; acceptance on outlined-text strip set"
```

- [ ] **Step 6: Update memory note**

Update `~/.claude/projects/-Users-markschwab-Documents-Pdf-editor/memory/pg-site-1a-autostitch-failure.md`: append that the OCR + multi-strip support landed (commit hashes) and the set now stitches; keep the diagnosis for reference.

---

## Self-Review Notes

- **Spec coverage:** frame detection (T4), OCR bands offline (T1, T5, T6), synthetic labels into existing channels (T6, T7), strip refs (T3), units + printed numbers + sibling pairs (T7), frame-anchored layout + hiddenRegions commit (T8, T9), seam floor 0.75 (T2), error handling (RPC timeout T6; OCR best-effort [] T1; frameless fallback T7), testing strategy incl. acceptance (T10). Keymap-vs-units interaction guarded (T7 step 3e).
- **Type consistency:** `RawImage`/`OcrWord` defined once in `ocrService.ts`, imported as types elsewhere (vitest-safe — type-only imports don't execute the module). `SheetInput.printedNo/siblingKey/pageIndex/frame` (T7) match the test fixtures and `autoStitch` call sites. `PlacedSheetPose.frame` / `TilePlacement.sourceFrame` names used consistently in T7/T8/T9.
- **Known risks called out to executors:** tesseract.js asset URL paths (T1 step 2) and side-band reading orientation (T1 step 4) are validated by the spike before anything depends on them; mupdf `Pixmap`/`DrawDevice` construction is exercised first in the spike too.
