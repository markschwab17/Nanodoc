/**
 * Tiled Page Smoke Harness — dev-only at /dev/tiled-page-smoke.
 *
 * Demonstrates TiledPageRenderer end-to-end:
 *   - Synthetic PDF with rich visual content per page (so different LODs
 *     show different detail).
 *   - Zoom slider: drag to change displayPxPerPoint. Crossing an LOD
 *     threshold triggers fresh tile requests; coarser-LOD ancestors are
 *     used as fallback (highlighted with an orange dashed outline) until
 *     the new LOD's primary tiles arrive.
 *   - Live counts of primary / fallback / missing tiles.
 *   - Log of every viewport change and tile arrival.
 *
 * NOT shipped to users. Workers + mupdf wasm cannot run in jsdom, so this
 * is the only place TiledPageRenderer can be exercised end-to-end.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { TiledPageRenderer, type VisibleTilesResult } from "@/core/pdf/tiles/TiledPageRenderer";
import { tilePointSize } from "@/core/pdf/tiles/lod";
import {
  tileKeyString,
  type PageDims,
  type PdfRect,
  type RenderedTile,
} from "@/core/pdf/tiles/types";

const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;
const PAGE_INDEX = 0;
const VIEWPORT_FIT_PX = 600;
const DOC_ID = "tiled-page-smoke-doc";

async function buildTestPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([PAGE_WIDTH_PT, PAGE_HEIGHT_PT]);
  // Background block
  page.drawRectangle({
    x: 30,
    y: 30,
    width: PAGE_WIDTH_PT - 60,
    height: PAGE_HEIGHT_PT - 60,
    color: rgb(0.93, 0.95, 1.0),
  });
  // Big title (visible at low LODs)
  page.drawText("TILED PAGE SMOKE", {
    x: 60,
    y: PAGE_HEIGHT_PT - 110,
    size: 40,
    font,
    color: rgb(0.1, 0.2, 0.5),
  });
  // Tile-grid lines (LOD 2 grid: 4×4)
  for (let i = 1; i < 8; i++) {
    page.drawLine({
      start: { x: (PAGE_WIDTH_PT * i) / 8, y: 30 },
      end: { x: (PAGE_WIDTH_PT * i) / 8, y: PAGE_HEIGHT_PT - 30 },
      color: rgb(0.85, 0.85, 0.85),
      thickness: 0.5,
    });
    page.drawLine({
      start: { x: 30, y: (PAGE_HEIGHT_PT * i) / 8 },
      end: { x: PAGE_WIDTH_PT - 30, y: (PAGE_HEIGHT_PT * i) / 8 },
      color: rgb(0.85, 0.85, 0.85),
      thickness: 0.5,
    });
  }
  // Fine detail visible only at high LODs
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 12; col++) {
      const cx = 60 + col * 40 + 20;
      const cy = 60 + row * 40 + 20;
      page.drawCircle({
        x: cx,
        y: cy,
        size: 4,
        color: rgb(
          (col % 4) / 3,
          (row % 4) / 3,
          ((col + row) % 4) / 3,
        ),
      });
      page.drawText(`${col},${row}`, {
        x: cx - 12,
        y: cy - 16,
        size: 5,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    }
  }
  // Per-quadrant labels (visible at LOD 1+)
  const quadLabels = ["TOP-LEFT", "TOP-RIGHT", "BOT-LEFT", "BOT-RIGHT"];
  const positions: Array<[number, number]> = [
    [80, PAGE_HEIGHT_PT - 200],
    [PAGE_WIDTH_PT / 2 + 40, PAGE_HEIGHT_PT - 200],
    [80, PAGE_HEIGHT_PT / 2 - 40],
    [PAGE_WIDTH_PT / 2 + 40, PAGE_HEIGHT_PT / 2 - 40],
  ];
  for (let i = 0; i < 4; i++) {
    page.drawText(quadLabels[i], {
      x: positions[i][0],
      y: positions[i][1],
      size: 18,
      font,
      color: rgb(0.4, 0.1, 0.3),
    });
  }
  return await pdf.save();
}

const PAGE_DIMS: PageDims = { widthPt: PAGE_WIDTH_PT, heightPt: PAGE_HEIGHT_PT };
const FIT_PX_PER_POINT = VIEWPORT_FIT_PX / Math.max(PAGE_WIDTH_PT, PAGE_HEIGHT_PT);
const PAGE_VIEWPORT: PdfRect = {
  x: 0,
  y: 0,
  w: PAGE_WIDTH_PT,
  h: PAGE_HEIGHT_PT,
};

export default function TiledPageSmokeHarness() {
  const [zoom, setZoom] = useState(1.0);
  const [renderTick, setRenderTick] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rendererRef = useRef<TiledPageRenderer | null>(null);

  // Bootstrap: build PDF, create renderer
  useEffect(() => {
    let cancelled = false;
    const append = (line: string) => {
      if (!cancelled) {
        setLog((prev) => [...prev.slice(-50), line]);
      }
    };

    (async () => {
      try {
        append("Generating synthetic PDF…");
        const t0 = performance.now();
        const pdfBytes = await buildTestPdf();
        append(
          `  PDF built (${pdfBytes.byteLength} bytes, ${(performance.now() - t0).toFixed(0)} ms)`,
        );

        const renderer = new TiledPageRenderer({
          docId: DOC_ID,
          pdfBytes,
          pageDims: () => PAGE_DIMS,
          workerCount: 4,
          cacheCapacity: 200,
        });

        renderer.onTileReady((tile) => {
          if (cancelled) return;
          append(`  ⤷ tile ready: ${tileKeyString(tile.key)}`);
          setRenderTick((t) => t + 1);
        });

        rendererRef.current = renderer;
        if (!cancelled) setReady(true);
        append("Renderer up. Move the zoom slider to exercise LOD changes.");
      } catch (e: any) {
        const message = e?.message ?? String(e);
        append(`ERROR: ${message}`);
        if (!cancelled) setError(message);
      }
    })();

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  // setViewport whenever zoom changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !ready) return;
    const displayPxPerPoint = FIT_PX_PER_POINT * zoom;
    setLog((prev) => [
      ...prev.slice(-50),
      `setViewport(zoom=${zoom.toFixed(2)}, pxPerPt=${displayPxPerPoint.toFixed(2)})`,
    ]);
    renderer.setViewport(PAGE_INDEX, PAGE_VIEWPORT, displayPxPerPoint);
    setRenderTick((t) => t + 1);
  }, [zoom, ready]);

  const displayPxPerPoint = FIT_PX_PER_POINT * zoom;

  // Synchronous read of the renderer's current state
  const visible: VisibleTilesResult | null = useMemo(() => {
    const renderer = rendererRef.current;
    if (!renderer || !ready) return null;
    return renderer.getVisibleTiles(PAGE_INDEX, PAGE_VIEWPORT, displayPxPerPoint);
    // renderTick included so the memo refreshes when tiles arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, ready, renderTick]);

  const pageCssWidth = PAGE_WIDTH_PT * displayPxPerPoint;
  const pageCssHeight = PAGE_HEIGHT_PT * displayPxPerPoint;

  return (
    <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12 }}>
      <h1 style={{ fontSize: 16, marginBottom: 8 }}>Tiled Page Smoke Harness</h1>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <label>Zoom:</label>
        <input
          type="range"
          min={0.25}
          max={5}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          style={{ width: 320 }}
          disabled={!ready}
        />
        <span style={{ minWidth: 60 }}>{zoom.toFixed(2)}×</span>
        {visible && (
          <span style={{ marginLeft: 16 }}>
            LOD <strong>{visible.lod}</strong> · primary{" "}
            <strong>{visible.primary.length}</strong> · fallback{" "}
            <strong style={{ color: "#c80" }}>{visible.fallback.length}</strong> ·
            missing <strong style={{ color: "#a00" }}>{visible.missing.length}</strong>
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div
          style={{
            position: "relative",
            width: pageCssWidth,
            height: pageCssHeight,
            overflow: "hidden",
            background: "white",
            border: "1px solid #999",
            flexShrink: 0,
          }}
        >
          {/* Fallback tiles render UNDER primary so primary overlays them
              as it arrives — the "never blank" trick. */}
          {visible?.fallback.map((t) => (
            <TileCanvas
              key={"f-" + tileKeyString(t.key)}
              tile={t}
              pageDims={PAGE_DIMS}
              displayPxPerPoint={displayPxPerPoint}
              kind="fallback"
            />
          ))}
          {visible?.primary.map((t) => (
            <TileCanvas
              key={"p-" + tileKeyString(t.key)}
              tile={t}
              pageDims={PAGE_DIMS}
              displayPxPerPoint={displayPxPerPoint}
              kind="primary"
            />
          ))}
          {/* Placeholders for genuinely missing tiles (no primary, no ancestor) */}
          {visible?.missing.map((k) => {
            const tilePt = tilePointSize(PAGE_DIMS, k.lod);
            return (
              <div
                key={"m-" + tileKeyString(k)}
                style={{
                  position: "absolute",
                  left: k.x * tilePt * displayPxPerPoint,
                  top: k.y * tilePt * displayPxPerPoint,
                  width: tilePt * displayPxPerPoint,
                  height: tilePt * displayPxPerPoint,
                  background: "rgba(255,0,0,0.05)",
                  border: "1px dashed rgba(255,0,0,0.4)",
                  boxSizing: "border-box",
                }}
              />
            );
          })}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <pre
            style={{
              background: "#111",
              color: "#0f0",
              padding: 8,
              borderRadius: 4,
              maxHeight: 600,
              overflow: "auto",
              margin: 0,
              fontSize: 11,
            }}
          >
            {log.join("\n")}
          </pre>
          {error && (
            <div style={{ color: "red", marginTop: 8 }}>
              Smoke test FAILED — see log above.
            </div>
          )}
        </div>
      </div>

      <p style={{ marginTop: 12, color: "#555" }}>
        Tip: drag zoom up rapidly. As you cross an LOD threshold, primary
        tile count briefly drops to 0 and orange-dashed fallback tiles
        appear (coarser-LOD ancestors). They're replaced as the new LOD's
        tiles render in. That swap is the "never blank" guarantee.
      </p>
    </div>
  );
}

function TileCanvas({
  tile,
  pageDims,
  displayPxPerPoint,
  kind,
}: {
  tile: RenderedTile;
  pageDims: PageDims;
  displayPxPerPoint: number;
  kind: "primary" | "fallback";
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = tile.pixelWidth;
    canvas.height = tile.pixelHeight;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(tile.bitmap, 0, 0);
  }, [tile]);

  const tilePt = tilePointSize(pageDims, tile.key.lod);
  const cssSize = tilePt * displayPxPerPoint;
  // Tile origin in PDF points = key.{x,y} * tilePt. pdfRect is page-clipped
  // so it can't be used for size; use tilePt for the bitmap's full footprint.
  const left = tile.key.x * tilePt * displayPxPerPoint;
  const top = tile.key.y * tilePt * displayPxPerPoint;

  return (
    <canvas
      ref={ref}
      style={{
        position: "absolute",
        left,
        top,
        width: cssSize,
        height: cssSize,
        opacity: kind === "fallback" ? 0.7 : 1,
        outline:
          kind === "fallback" ? "1px dashed rgba(255,140,0,0.8)" : "none",
        outlineOffset: -1,
        pointerEvents: "none",
      }}
    />
  );
}
