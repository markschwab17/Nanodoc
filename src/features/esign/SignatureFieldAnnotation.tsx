/**
 * Signature Field Annotation Renderer
 *
 * Renders signature field placeholders on the PDF canvas.
 * In prepare mode: shows colored field outlines with labels.
 * In signing mode:
 *   - signature/initials: click opens capture dialog (draw or type)
 *   - text/name/date: inline editing directly in the field (DocuSign-style)
 *
 * All rendered images match the field's actual aspect ratio so content
 * fills the placed box without distortion.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { Annotation } from "@/core/pdf/types";
import { useESignStore } from "@/shared/stores/esignStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import SignatureCaptureDialog from "./SignatureCaptureDialog";

interface Props {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  isSelected?: boolean;
  onSelect?: () => void;
}

const PX_PER_PT = 3;

/** Render typed text to a canvas image sized to the field dimensions.
 *  Starts at 60% of box height and shrinks until the text fits the width. */
function renderTextToImage(text: string, fieldW: number, fieldH: number, font = "Arial, Helvetica, sans-serif"): string {
  const cw = Math.round(fieldW * PX_PER_PT);
  const ch = Math.round(fieldH * PX_PER_PT);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = "#1a1a2e";
  const padding = Math.round(cw * 0.04);
  const maxTextWidth = cw - padding * 2;
  // Start large, shrink until text fits
  let fontSize = Math.round(ch * 0.6);
  const minFontSize = 8;
  ctx.textBaseline = "middle";
  while (fontSize > minFontSize) {
    ctx.font = `${fontSize}px ${font}`;
    if (ctx.measureText(text).width <= maxTextWidth) break;
    fontSize -= 1;
  }
  ctx.font = `${fontSize}px ${font}`;
  ctx.fillText(text, padding, ch / 2);
  return canvas.toDataURL("image/png");
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
  const fieldPlacements = useESignStore((s) => s.fieldPlacements);
  const fieldTexts = useESignStore((s) => s.fieldTexts);
  const setFieldText = useESignStore((s) => s.setFieldText);
  const signerEmail = useESignStore((s) => s.signerEmail);
  const signerName = useESignStore((s) => s.signerName);
  const getNextUnfilledField = useESignStore((s) => s.getNextUnfilledField);
  const scrollToField = useESignStore((s) => s.scrollToField);

  const [showCapture, setShowCapture] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Fill a field and auto-scroll to the next unfilled one
  const fillAndAdvance = useCallback(
    (fieldId: string, imageData: string) => {
      setSignatureImage(fieldId, imageData);
      // Short delay so the store updates before we query next unfilled
      setTimeout(() => {
        const next = getNextUnfilledField(fieldId);
        if (next) scrollToField(next);
      }, 350);
    },
    [setSignatureImage, getNextUnfilledField, scrollToField]
  );

  const annotW = annotation.width || 200;
  const annotH = annotation.height || 60;
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotH);
  const bottomRight = pdfToCanvas(annotation.x + annotW, annotation.y);
  const width = bottomRight.x - topLeft.x;
  const height = bottomRight.y - topLeft.y;
  const fieldColor = annotation.color || "#5070ff";
  const fieldType = (annotation.signatureFieldType || "signature") as "signature" | "initials" | "date" | "name" | "text";
  const label = annotation.signatureFieldLabel || fieldType;
  const isFilled = !!signatureImages[annotation.id];
  const signatureImage = signatureImages[annotation.id];

  const isInlineField = fieldType === "text" || fieldType === "name" || fieldType === "date";

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const commitInlineEdit = useCallback(() => {
    const text = editText.trim();
    if (text) {
      const imageData = renderTextToImage(text, annotW, annotH);
      setFieldText(annotation.id, text);
      fillAndAdvance(annotation.id, imageData);
    } else if (annotation.signatureFieldRequired !== false) {
      useNotificationStore.getState().showNotification("This field is required", "error");
    }
    setIsEditing(false);
  }, [editText, annotation.id, annotation.signatureFieldRequired, annotW, annotH, fillAndAdvance, setFieldText]);

  function handleClick() {
    if (mode !== "sign") {
      // Prepare mode: select for move/resize
      onSelect?.();
      return;
    }

    if (isInlineField) {
      if (fieldType === "date" && !isFilled) {
        // Date: auto-fill immediately on first click
        const dateStr = new Date().toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
        const imageData = renderTextToImage(dateStr, annotW, annotH);
        setFieldText(annotation.id, dateStr);
        fillAndAdvance(annotation.id, imageData);
      } else if (fieldType === "name" && !isFilled) {
        if (signerName) {
          // Auto-fill with signer's name
          const imageData = renderTextToImage(signerName, annotW, annotH);
          setFieldText(annotation.id, signerName);
          fillAndAdvance(annotation.id, imageData);
        } else {
          // No name available — fall back to editing
          setEditText("");
          setIsEditing(true);
        }
      } else {
        // Text or re-edit — pre-populate with existing text if available
        setEditText(fieldTexts[annotation.id] || "");
        setIsEditing(true);
      }
    } else {
      // Signature/initials: open capture dialog
      setShowCapture(true);
    }
  }

  function handleCaptureConfirm(imageData: string) {
    // Fill this field
    setSignatureImage(annotation.id, imageData);

    // Auto-fill all other unfilled fields of the same type (signature → signature, initials → initials)
    const currentImages = useESignStore.getState().signatureImages;
    let autoFilledCount = 0;
    for (const field of fieldPlacements) {
      if (field.id !== annotation.id && field.fieldType === fieldType && !currentImages[field.id]) {
        setSignatureImage(field.id, imageData);
        autoFilledCount++;
      }
    }

    if (autoFilledCount > 0) {
      useNotificationStore.getState().showNotification(
        `Applied to ${autoFilledCount} other ${fieldType} field${autoFilledCount > 1 ? "s" : ""}`,
        "info"
      );
    }

    setShowCapture(false);

    // Scroll to next unfilled field (of any type)
    setTimeout(() => {
      const next = getNextUnfilledField(annotation.id);
      if (next) scrollToField(next);
    }, 350);
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
          zIndex: 25,
          outline: isSelected ? `2px solid ${fieldColor}` : "none",
          outlineOffset: 2,
          transition: "background 0.15s",
        }}
        title={
          mode === "sign"
            ? isFilled
              ? `Click to re-${isInlineField ? "edit" : "sign"}`
              : `Click to ${label.toLowerCase()}`
            : label
        }
        onMouseDown={(e) => {
          if (mode === "sign") {
            e.stopPropagation();
          }
        }}
      >
        {/* Inline editing input for text/name fields */}
        {isEditing && (
          <input
            ref={inputRef}
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitInlineEdit();
              } else if (e.key === "Escape") {
                setIsEditing(false);
              }
            }}
            onBlur={commitInlineEdit}
            onClick={(e) => e.stopPropagation()}
            placeholder={fieldType === "name" ? "Full name" : "Type here..."}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              outline: "none",
              background: "#fff",
              fontFamily: "Arial, Helvetica, sans-serif",
              fontSize: Math.min(height * 0.5, 18),
              padding: "2px 6px",
              boxSizing: "border-box",
              color: "#1a1a2e",
            }}
          />
        )}

        {/* Filled field: show image */}
        {!isEditing && isFilled && signatureImage ? (
          <img
            src={signatureImage}
            alt={label}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "fill",
              pointerEvents: "none",
            }}
          />
        ) : null}

        {/* Empty field placeholder */}
        {!isEditing && !isFilled && (
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
          fieldWidth={annotW}
          fieldHeight={annotH}
          signerName={signerName || signerEmail || undefined}
          onConfirm={handleCaptureConfirm}
          onCancel={() => setShowCapture(false)}
        />
      )}
    </>
  );
}
