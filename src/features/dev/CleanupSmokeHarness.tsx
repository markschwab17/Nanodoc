/**
 * DEV-only smoke harness for Clean-Composite detection. Pick a multi-page plan
 * PDF; it builds one tile stub per page (source bytes + page index + point
 * size from mupdf `getBounds`), runs `detectCleanupForTiles`, and prints every
 * proposed hide-region (kind, confidence, tile-local rect). mupdf WASM cannot
 * run in vitest, so this validates the detection wiring in the real browser
 * before the interactive review UI is exercised.
 *
 * Reference input: a real grading/utility set (e.g. the Rose Hill sheets) —
 * expect a high-confidence ~275pt right-edge title-block strip per sheet and at
 * least one match-margin.
 */
import { useState } from "react";
import { detectCleanupForTiles } from "@/features/stitch/cleanup/cleanupRun";

export default function CleanupSmokeHarness() {
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
      const tiles: { id: string; sourcePdfBytes: Uint8Array; sourcePageIndex: number; width: number; height: number }[] = [];
      for (let i = 0; i < count; i++) {
        const page = doc.loadPage(i);
        const b = page.getBounds();
        page.destroy?.();
        tiles.push({ id: `p${i}`, sourcePdfBytes: bytes, sourcePageIndex: i, width: b[2] - b[0], height: b[3] - b[1] });
      }
      const t0 = performance.now();
      const proposals = await detectCleanupForTiles(mupdf, tiles, (done, total) => setLog(`Analyzing page ${done}/${total}…`));
      const ms = Math.round(performance.now() - t0);
      const totalRegions = proposals.reduce((s, p) => s + p.regions.length, 0);
      const lines = proposals.map((p) => {
        const tile = tiles.find((t) => t.id === p.tileId)!;
        if (p.regions.length === 0) return `  ${p.tileId} (${tile.width.toFixed(0)}×${tile.height.toFixed(0)}pt): (no regions)`;
        const rs = p.regions.map((r) => {
          // regions are tile-local FRACTIONS (0..1); reconstruct points for readability.
          const px = (f: number, dim: number) => (f * dim).toFixed(0);
          return `      ${r.kind} [${r.confidence}]  frac x=${r.rect.x.toFixed(3)} y=${r.rect.y.toFixed(3)} w=${r.rect.w.toFixed(3)} h=${r.rect.h.toFixed(3)}  ≈pts x=${px(r.rect.x, tile.width)} y=${px(r.rect.y, tile.height)} w=${px(r.rect.w, tile.width)} h=${px(r.rect.h, tile.height)}`;
        });
        return [`  ${p.tileId} (${tile.width.toFixed(0)}×${tile.height.toFixed(0)}pt): ${p.regions.length} region(s)`, ...rs].join("\n");
      });
      setLog([`${count} pages in ${ms} ms — ${totalRegions} region(s) total`, ...lines].join("\n"));
      doc.destroy?.();
    } catch (e) {
      setLog("ERROR: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h1>Clean-Composite Smoke Harness</h1>
      <input
        type="file"
        accept="application/pdf"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log}</pre>
    </div>
  );
}
