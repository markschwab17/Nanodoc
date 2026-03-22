/**
 * E-Sign Decline Dialog
 *
 * Confirmation dialog shown when a recipient wants to decline signing.
 * Includes an optional textarea for providing a reason.
 */

import { useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  onConfirm: (reason: string | undefined) => void;
  onCancel: () => void;
}

export default function ESignDeclineDialog({ onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState("");

  return createPortal(
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
          width: 480,
          maxWidth: "95vw",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #e2e8f0" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1a1a2e" }}>
            Decline to Sign
          </h2>
        </div>

        <div style={{ padding: "20px 24px" }}>
          <p style={{ color: "#444", fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>
            Are you sure you want to decline signing this document? This action cannot be undone.
          </p>

          <label style={{ display: "block", fontSize: 13, color: "#666", marginBottom: 6 }}>
            Reason for declining (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Let the sender know why you're declining..."
            rows={3}
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 14,
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              outline: "none",
              boxSizing: "border-box",
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 24px",
            borderTop: "1px solid #e2e8f0",
          }}
        >
          <button
            onClick={onCancel}
            style={{
              padding: "10px 20px",
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
            onClick={() => onConfirm(reason.trim() || undefined)}
            style={{
              padding: "10px 28px",
              border: "none",
              borderRadius: 6,
              background: "#e5484d",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Decline
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
