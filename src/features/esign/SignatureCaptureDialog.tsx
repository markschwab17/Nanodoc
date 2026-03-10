/**
 * Signature Capture Dialog
 *
 * Modal with Draw and Type tabs for capturing a signature.
 * Used in signing mode when the recipient clicks a signature field.
 */

import { useState, useRef, useCallback, useEffect } from "react";

interface Props {
  fieldType: "signature" | "initials" | "date" | "name" | "text";
  signerName?: string;
  onConfirm: (imageData: string) => void;
  onCancel: () => void;
}

export default function SignatureCaptureDialog({ fieldType, signerName, onConfirm, onCancel }: Props) {
  const [tab, setTab] = useState<"draw" | "type">(fieldType === "date" ? "type" : "draw");
  const [typedText, setTypedText] = useState(() => {
    if (fieldType === "date") return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    if (fieldType === "name") return signerName || "";
    return "";
  });
  const [typedFont, setTypedFont] = useState("'Dancing Script', cursive");

  // Drawing canvas state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const hasDrawnRef = useRef(false);

  const CANVAS_W = 600;
  const CANVAS_H = 200;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }, []);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  }, []);

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
    ctx.lineWidth = 3;
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
      // Render typed text to canvas
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.fillStyle = "#1a1a2e";
      const baseFontFamily = typedFont.replace(/'/g, "");
      ctx.font = `${fieldType === "initials" ? 48 : 36}px ${baseFontFamily}, cursive`;
      ctx.textBaseline = "middle";
      ctx.fillText(typedText, 20, CANVAS_H / 2);
      onConfirm(canvas.toDataURL("image/png"));
    }
  }

  const showDrawTab = fieldType === "signature" || fieldType === "initials";

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
            {fieldType === "signature" ? "Add Your Signature" :
             fieldType === "initials" ? "Add Your Initials" :
             fieldType === "date" ? "Confirm Date" :
             fieldType === "name" ? "Enter Your Name" : "Enter Text"}
          </h2>
        </div>

        {/* Tabs */}
        {showDrawTab && (
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
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Type
            </button>
          </div>
        )}

        {/* Content */}
        <div style={{ padding: 20 }}>
          {tab === "draw" && showDrawTab ? (
            <div>
              <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                style={{
                  width: "100%",
                  height: 160,
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
                placeholder={fieldType === "date" ? "Date" : fieldType === "name" ? "Full name" : "Type here..."}
                autoFocus
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  fontSize: fieldType === "date" ? 16 : 28,
                  fontFamily: fieldType === "date" ? "inherit" : typedFont,
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              {fieldType !== "date" && (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  {[
                    "'Dancing Script', cursive",
                    "'Caveat', cursive",
                    "serif",
                    "monospace",
                  ].map((font) => (
                    <button
                      key={font}
                      onClick={() => setTypedFont(font)}
                      style={{
                        flex: 1,
                        padding: "8px 4px",
                        border: typedFont === font ? "2px solid #5070ff" : "1px solid #ddd",
                        borderRadius: 6,
                        background: typedFont === font ? "#f0f4ff" : "#fff",
                        cursor: "pointer",
                        fontFamily: font,
                        fontSize: 16,
                      }}
                    >
                      Abc
                    </button>
                  ))}
                </div>
              )}
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
