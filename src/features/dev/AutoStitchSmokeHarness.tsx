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

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h1>Auto-Stitch Smoke Harness</h1>
      <input
        type="file"
        accept="application/pdf"
        disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
      <div style={{ marginTop: 8 }}>
        <label>OCR spike page: <input type="number" value={ocrPage} onChange={(e) => setOcrPage(Number(e.target.value))} style={{ width: 60 }} /></label>{" "}
        <input type="file" accept="application/pdf" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onOcrSpike(f); }} />
      </div>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log}</pre>
    </div>
  );
}
