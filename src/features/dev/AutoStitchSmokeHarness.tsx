/**
 * DEV-only smoke harness for auto-stitch. Pick a multi-page plan PDF; it runs
 * the full pipeline (mupdf capture -> scale infer -> stitch -> layout) and prints
 * per-page scale + placement and the worst seam residual. mupdf WASM cannot run
 * in vitest, so this is how the capture device + orchestrator are validated.
 *
 * Reference input: merge two adjacent Santee sheets (e.g. santee-parkvue p07.pdf
 * = sheet 14 and p08.pdf = sheet 15, a high-confidence token+segment seam) into a
 * 2-page PDF, or load any real grading/utility set.
 */
import { useState } from "react";
import { autoStitch } from "@/features/stitch/autostitch/autoStitch";

export default function AutoStitchSmokeHarness() {
  const [log, setLog] = useState<string>("Choose a multi-page plan PDF…");
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File) => {
    setBusy(true);
    setLog("Loading…");
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = mupdf.Document.openDocument(bytes, "application/pdf") as any;
      const count = doc.countPages();
      const indices = Array.from({ length: count }, (_, i) => i);
      const t0 = performance.now();
      const res = await autoStitch(mupdf, doc, indices, {
        onProgress: (done, total) => setLog(`Analyzing page ${done}/${total}…`),
      });
      const ms = Math.round(performance.now() - t0);
      const lines = res.placements.map(
        (p) => `  page ${p.pageIndex}: ${p.aligned ? "ALIGNED" : "unplaced"}  x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} w=${p.width.toFixed(0)} h=${p.height.toFixed(0)}`
      );
      setLog(
        [
          `${count} pages in ${ms} ms`,
          `rootFtPerIn=${res.rootFtPerIn}  aligned=${res.alignedCount}  unplaced=${res.unplacedCount}  worstSeam=${res.worstResidFt.toFixed(2)} ft`,
          ...lines,
        ].join("\n")
      );
      doc.destroy?.();
    } catch (e) {
      setLog("ERROR: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h1>Auto-Stitch Smoke Harness</h1>
      <input
        type="file"
        accept="application/pdf"
        disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log}</pre>
    </div>
  );
}
