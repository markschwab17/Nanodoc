/**
 * Tile Smoke Harness — dev-only manual validation page.
 *
 * Reachable at /dev/tile-smoke. Generates a 4-page synthetic PDF with
 * pdf-lib, fans 64 tile renders across a 4-worker pool, and renders each
 * ImageBitmap into a small canvas so a human can visually confirm tiles
 * came back non-blank with correct geometry.
 *
 * NOT shipped to users. NOT a Vitest test (workers and mupdf wasm cannot
 * run in jsdom).
 */

import { useEffect, useRef, useState } from "react";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { WorkerPool } from "@/core/pdf/tiles/WorkerPool";
import {
  tileKeyString,
  TILE_SIZE,
  type PageDims,
  type RenderedTile,
  type TileKey,
} from "@/core/pdf/tiles/types";
import { tileGridSize } from "@/core/pdf/tiles/lod";

const PAGE_WIDTH_PT = 612; // letter
const PAGE_HEIGHT_PT = 792;
const PAGE_COUNT = 4;
const TEST_LOD = 2; // letter at LOD 2 → 4×4 grid → 16 tiles per page

async function buildTestPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < PAGE_COUNT; p++) {
    const page = pdf.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
    // Big colored block so tiles obviously have non-white content
    page.drawRectangle({
      x: 50,
      y: 50,
      width: PAGE_WIDTH_PT - 100,
      height: PAGE_HEIGHT_PT - 100,
      color: rgb(0.1 + p * 0.2, 0.4, 0.7 - p * 0.15),
    });
    page.drawText(`PAGE ${p + 1}`, {
      x: 80,
      y: PAGE_HEIGHT_PT - 100,
      size: 48,
      font,
      color: rgb(1, 1, 1),
    });
    // Grid lines so tile boundaries are visually verifiable
    for (let i = 1; i < 4; i++) {
      const xLine = (PAGE_WIDTH_PT * i) / 4;
      page.drawLine({
        start: { x: xLine, y: 0 },
        end: { x: xLine, y: PAGE_HEIGHT_PT },
        color: rgb(0, 0, 0),
        thickness: 1,
      });
      const yLine = (PAGE_HEIGHT_PT * i) / 4;
      page.drawLine({
        start: { x: 0, y: yLine },
        end: { x: PAGE_WIDTH_PT, y: yLine },
        color: rgb(0, 0, 0),
        thickness: 1,
      });
    }
  }
  return await pdf.save();
}

export default function TileSmokeHarness() {
  const [log, setLog] = useState<string[]>([]);
  const [tiles, setTiles] = useState<RenderedTile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const poolRef = useRef<WorkerPool | null>(null);

  useEffect(() => {
    let cancelled = false;
    const append = (line: string) => {
      if (!cancelled) setLog((prev) => [...prev, line]);
    };

    (async () => {
      try {
        append("Generating synthetic 4-page PDF with pdf-lib…");
        const t0 = performance.now();
        const pdfBytes = await buildTestPdf();
        append(
          `  PDF size: ${pdfBytes.byteLength} bytes (${(performance.now() - t0).toFixed(0)} ms)`,
        );

        append("Spawning WorkerPool (size=4)…");
        const pool = new WorkerPool({
          size: 4,
          pdfDataFor: () => pdfBytes,
        });
        poolRef.current = pool;

        const docId = "smoke-doc";
        const pageDims: PageDims = {
          widthPt: PAGE_WIDTH_PT,
          heightPt: PAGE_HEIGHT_PT,
        };
        const { cols, rows } = tileGridSize(pageDims, TEST_LOD);
        append(
          `Requesting ${PAGE_COUNT * cols * rows} tiles at LOD ${TEST_LOD} (grid ${cols}×${rows} per page)…`,
        );

        const requests: Promise<RenderedTile>[] = [];
        const tStart = performance.now();
        for (let page = 0; page < PAGE_COUNT; page++) {
          for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
              const key: TileKey = { docId, page, lod: TEST_LOD, x, y };
              requests.push(pool.request(key, pageDims, "visible"));
            }
          }
        }

        const results = await Promise.all(requests);
        const elapsed = performance.now() - tStart;
        append(
          `  ${results.length} tiles rendered in ${elapsed.toFixed(0)} ms (~${(elapsed / results.length).toFixed(1)} ms/tile)`,
        );

        // Smoke assertions (visible to user as PASS/FAIL lines)
        const allBitmaps = results.every((r) => r.bitmap instanceof ImageBitmap);
        append(
          `  ASSERT bitmap is ImageBitmap: ${allBitmaps ? "PASS" : "FAIL"}`,
        );

        const allRightSize = results.every(
          (r) => r.pixelWidth === TILE_SIZE && r.pixelHeight === TILE_SIZE,
        );
        append(
          `  ASSERT pixel size === ${TILE_SIZE}×${TILE_SIZE}: ${allRightSize ? "PASS" : "FAIL"}`,
        );

        // In-flight dedupe: two simultaneous requests for the same key must
        // return the same Promise reference (not merely equal results).
        const dedupeKey: TileKey = {
          docId,
          page: 1,
          lod: TEST_LOD,
          x: 0,
          y: 0,
        };
        const a = pool.request(dedupeKey, pageDims, "visible");
        const b = pool.request(dedupeKey, pageDims, "visible");
        append(
          `  ASSERT in-flight dedupe (a === b promise): ${a === b ? "PASS" : "FAIL"}`,
        );
        await Promise.all([a, b]);

        if (!cancelled) setTiles(results);
        append("All smoke checks complete. Tiles rendered below.");
      } catch (e: any) {
        const message = e?.message ?? String(e);
        append(`ERROR: ${message}`);
        if (!cancelled) setError(message);
      }
    })();

    return () => {
      cancelled = true;
      poolRef.current?.destroy();
    };
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12 }}>
      <h1 style={{ fontSize: 16, marginBottom: 8 }}>Tile Smoke Harness</h1>
      <pre
        style={{
          background: "#111",
          color: "#0f0",
          padding: 8,
          borderRadius: 4,
          maxHeight: 280,
          overflow: "auto",
        }}
      >
        {log.join("\n")}
      </pre>
      {error && (
        <div style={{ color: "red", marginTop: 8 }}>
          Smoke test FAILED — see log above.
        </div>
      )}
      <h2 style={{ fontSize: 14, marginTop: 16 }}>Rendered tiles</h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(8, 80px)",
          gap: 4,
          marginTop: 8,
        }}
      >
        {tiles.map((t) => (
          <TilePreview key={tileKeyString(t.key)} tile={t} />
        ))}
      </div>
    </div>
  );
}

function TilePreview({ tile }: { tile: RenderedTile }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = tile.pixelWidth;
    canvas.height = tile.pixelHeight;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(tile.bitmap, 0, 0);
  }, [tile]);
  return (
    <div title={tileKeyString(tile.key)}>
      <canvas
        ref={ref}
        style={{ width: 80, height: 80, border: "1px solid #ccc" }}
      />
      <div style={{ fontSize: 9, textAlign: "center" }}>
        p{tile.key.page} {tile.key.x},{tile.key.y}
      </div>
    </div>
  );
}
