/**
 * E-Sign Consent Dialog
 *
 * Shown before final submission. Records legally-required consent.
 */

import { useState } from "react";

interface Props {
  recipientEmail: string;
  documentSubject: string;
  onConfirm: (consent: { agreed: boolean; timestamp: string; text: string }) => void;
  onCancel: () => void;
}

const CONSENT_TEXT =
  "I agree that my electronic signature is the legal equivalent of my handwritten signature. " +
  "I consent to be legally bound by this document and acknowledge that I have reviewed it in its entirety.";

export default function ESignConsentDialog({ recipientEmail, documentSubject, onConfirm, onCancel }: Props) {
  const [agreed, setAgreed] = useState(false);

  function handleConfirm() {
    if (!agreed) return;
    onConfirm({
      agreed: true,
      timestamp: new Date().toISOString(),
      text: CONSENT_TEXT,
    });
  }

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
          width: 480,
          maxWidth: "95vw",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #e2e8f0" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1a1a2e" }}>
            Confirm Your Signature
          </h2>
        </div>

        <div style={{ padding: "20px 24px" }}>
          <p style={{ color: "#666", fontSize: 14, margin: "0 0 8px" }}>
            Signing: <strong>{documentSubject}</strong>
          </p>
          <p style={{ color: "#666", fontSize: 14, margin: "0 0 20px" }}>
            As: <strong>{recipientEmail}</strong>
          </p>

          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: 16,
              marginBottom: 20,
            }}
          >
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "#444" }}>
              {CONSENT_TEXT}
            </p>
          </div>

          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              cursor: "pointer",
              fontSize: 14,
              color: "#333",
            }}
          >
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ marginTop: 2, width: 18, height: 18, cursor: "pointer" }}
            />
            <span>I have read and agree to the above statement</span>
          </label>
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
            onClick={handleConfirm}
            disabled={!agreed}
            style={{
              padding: "10px 28px",
              border: "none",
              borderRadius: 6,
              background: agreed ? "#30a46c" : "#ccc",
              color: "#fff",
              fontWeight: 600,
              cursor: agreed ? "pointer" : "default",
              fontSize: 14,
            }}
          >
            Sign Document
          </button>
        </div>
      </div>
    </div>
  );
}
