/**
 * Signature Capture Dialog
 *
 * Modal with Draw and Type tabs for capturing a signature or initials.
 * Only used for signature/initials fields — text/name/date use inline editing.
 *
 * The canvas matches the field's aspect ratio so the drawn/typed content
 * fills the placed box exactly without distortion.
 */

import { useState, useRef, useCallback, useEffect } from "react";

interface Props {
  fieldType: "signature" | "initials" | "date" | "name" | "text";
  /** PDF-unit width of the field box */
  fieldWidth: number;
  /** PDF-unit height of the field box */
  fieldHeight: number;
  signerName?: string;
  onConfirm: (imageData: string) => void;
  onCancel: () => void;
}

/** Scale factor so the internal canvas is crisp on high-DPI screens */
const PX_PER_PT = 3;

export default function SignatureCaptureDialog({
  fieldType,
  fieldWidth,
  fieldHeight,
  signerName,
  onConfirm,
  onCancel,
}: Props) {
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [typedText, setTypedText] = useState(() => {
    if (fieldType === "initials" && signerName) {
      return signerName.split(" ").map(w => w[0]?.toUpperCase() || "").join("");
    }
    return "";
  });

  // Internal canvas dimensions derived from field aspect ratio
  const CANVAS_W = Math.round(fieldWidth * PX_PER_PT);
  const CANVAS_H = Math.round(fieldHeight * PX_PER_PT);

  // Display height in the dialog — keep it reasonable
  const DISPLAY_H = Math.min(Math.max(CANVAS_H / PX_PER_PT * 2, 80), 200);

  // Drawing canvas state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const hasDrawnRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }, [CANVAS_W, CANVAS_H]);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  }, [CANVAS_W, CANVAS_H]);

  function handleCanvasMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    isDrawingRef.current = true;
    lastPointRef.current = getCanvasCoords(e);
    hasDrawnRef.current = true;
  }

  function handleCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current || !lastPointRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const point = getCanvasCoords(e);
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(point.x, point.y);
    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = Math.max(2, CANVAS_H * 0.02);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    lastPointRef.current = point;
  }

  function handleCanvasMouseUp() {
    isDrawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearCanvas() {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    hasDrawnRef.current = false;
  }

  function handleConfirm() {
    if (tab === "draw") {
      if (!hasDrawnRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      onConfirm(canvas.toDataURL("image/png"));
    } else {
      if (!typedText.trim()) return;
      // Render typed text to canvas sized to the field
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = "#1a1a2e";
      const padding = Math.round(CANVAS_W * 0.04);
      const maxTextWidth = CANVAS_W - padding * 2;
      // Start large, shrink until text fits width
      let fontSize = Math.round(CANVAS_H * 0.6);
      const minFontSize = 8;
      ctx.textBaseline = "middle";
      while (fontSize > minFontSize) {
        ctx.font = `${fontSize}px 'Dancing Script', cursive`;
        if (ctx.measureText(typedText).width <= maxTextWidth) break;
        fontSize -= 1;
      }
      ctx.font = `${fontSize}px 'Dancing Script', cursive`;
      ctx.fillText(typedText, padding, CANVAS_H / 2);
      onConfirm(canvas.toDataURL("image/png"));
    }
  }

  const title = fieldType === "signature" ? "Add Your Signature" : "Add Your Initials";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          width: 560,
          maxWidth: "95vw",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e2e8f0" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1a1a2e" }}>
            {title}
          </h2>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0" }}>
          <button
            onClick={() => setTab("draw")}
            style={{
              flex: 1,
              padding: "10px 0",
              border: "none",
              borderBottom: tab === "draw" ? "2px solid #5070ff" : "2px solid transparent",
              background: "transparent",
              color: tab === "draw" ? "#5070ff" : "#666",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Draw
          </button>
          <button
            onClick={() => setTab("type")}
            style={{
              flex: 1,
              padding: "10px 0",
              border: "none",
              borderBottom: tab === "type" ? "2px solid #5070ff" : "2px solid transparent",
              background: "transparent",
              color: tab === "type" ? "#5070ff" : "#666",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Type
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: 20 }}>
          {tab === "draw" ? (
            <div>
              <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                style={{
                  width: "100%",
                  height: DISPLAY_H,
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  cursor: "crosshair",
                  touchAction: "none",
                }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
              />
              <div style={{ textAlign: "center", marginTop: 8 }}>
                <button
                  onClick={clearCanvas}
                  style={{
                    background: "transparent",
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    padding: "6px 16px",
                    cursor: "pointer",
                    color: "#666",
                    fontSize: 13,
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
                placeholder={fieldType === "initials" ? "Your initials" : "Type your signature..."}
                autoFocus
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  fontSize: 28,
                  fontFamily: "'Dancing Script', cursive",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 20px",
            borderTop: "1px solid #e2e8f0",
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: "8px 20px",
              border: "1px solid #ddd",
              borderRadius: 6,
              background: "#fff",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            style={{
              padding: "8px 24px",
              border: "none",
              borderRadius: 6,
              background: "#5070ff",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
