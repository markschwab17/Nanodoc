/**
 * Signature Field Annotation Renderer
 *
 * Renders signature field placeholders on the PDF canvas.
 * In prepare mode: shows colored field outlines with labels.
 * In signing mode: shows clickable fields that open the signature capture dialog.
 */

import { useState } from "react";
import type { Annotation } from "@/core/pdf/types";
import { useESignStore } from "@/shared/stores/esignStore";
import SignatureCaptureDialog from "./SignatureCaptureDialog";

interface Props {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  isSelected?: boolean;
  onSelect?: () => void;
}

export default function SignatureFieldAnnotation({
  annotation,
  pdfToCanvas,
  isSelected,
  onSelect,
}: Props) {
  const mode = useESignStore((s) => s.mode);
  const signatureImages = useESignStore((s) => s.signatureImages);
  const setSignatureImage = useESignStore((s) => s.setSignatureImage);

  const [showCapture, setShowCapture] = useState(false);

  const annotW = annotation.width || 200;
  const annotH = annotation.height || 60;
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotH);
  const bottomRight = pdfToCanvas(annotation.x + annotW, annotation.y);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  const fieldColor = annotation.color || "#5070ff";
  const fieldType = annotation.signatureFieldType || "signature";
  const label = annotation.signatureFieldLabel || fieldType;
  const isFilled = !!signatureImages[annotation.id];
  const signatureImage = signatureImages[annotation.id];

  function handleClick() {
    if (mode === "sign" && !isFilled) {
      setShowCapture(true);
    } else if (onSelect) {
      onSelect();
    }
  }

  function handleCaptureConfirm(imageData: string) {
    setSignatureImage(annotation.id, imageData);
    setShowCapture(false);
  }

  return (
    <>
      <div
        onClick={handleClick}
        style={{
          position: "absolute",
          left: topLeft.x,
          top: topLeft.y,
          width,
          height,
          border: `2px ${isFilled ? "solid" : "dashed"} ${fieldColor}`,
          borderRadius: 4,
          background: isFilled ? "transparent" : `${fieldColor}15`,
          cursor: mode === "sign" ? "pointer" : "move",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          boxSizing: "border-box",
          zIndex: 10,
          outline: isSelected ? `2px solid ${fieldColor}` : "none",
          outlineOffset: 2,
          transition: "background 0.15s",
        }}
        title={mode === "sign" ? (isFilled ? "Click to re-sign" : `Click to ${label.toLowerCase()}`) : label}
        onMouseDown={(e) => {
          if (mode === "sign") {
            e.stopPropagation();
          }
        }}
      >
        {isFilled && signatureImage ? (
          <img
            src={signatureImage}
            alt="Signature"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              pointerEvents: "none",
            }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontSize: Math.min(height * 0.3, 14),
                color: fieldColor,
                fontWeight: 600,
                opacity: 0.8,
              }}
            >
              {mode === "sign" ? label : `${label}`}
            </span>
            {mode === "prepare" && annotation.signerEmail && (
              <span
                style={{
                  fontSize: Math.min(height * 0.2, 10),
                  color: fieldColor,
                  opacity: 0.6,
                }}
              >
                {annotation.signerEmail}
              </span>
            )}
          </div>
        )}
      </div>

      {showCapture && (
        <SignatureCaptureDialog
          fieldType={fieldType}
          signerName={useESignStore.getState().signerEmail || undefined}
          onConfirm={handleCaptureConfirm}
          onCancel={() => setShowCapture(false)}
        />
      )}
    </>
  );
}
