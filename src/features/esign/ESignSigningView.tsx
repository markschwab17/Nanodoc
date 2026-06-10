/**
 * E-Sign Signing View
 *
 * Floating UI overlay for signing mode. Shows a banner with signer info,
 * a "Finish & Sign" button, and manages the consent + submission flow.
 */

import { useState, useEffect } from "react";
import { useESignStore } from "@/shared/stores/esignStore";
import ESignConsentDialog from "./ESignConsentDialog";
import ESignDeclineDialog from "./ESignDeclineDialog";

interface Props {
  documentSubject: string;
}

export default function ESignSigningView({ documentSubject }: Props) {
  const {
    signerEmail,
    recipientToken,
    apiOrigin,
    fieldPlacements,
    signatureImages,
    allRequiredFieldsFilled,
    getNextUnfilledField,
    scrollToField,
  } = useESignStore();

  const [showConsent, setShowConsent] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [dismissedBanner, setDismissedBanner] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filledCount = Object.keys(signatureImages).length;
  const totalCount = fieldPlacements.length;
  const nextField = getNextUnfilledField();

  // Auto-scroll to first unfilled field on mount
  useEffect(() => {
    // Wait for viewer to fully render before scrolling
    const timer = setTimeout(() => {
      const first = getNextUnfilledField();
      if (first) scrollToField(first);
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleNextField() {
    const next = getNextUnfilledField();
    if (next) scrollToField(next);
  }

  async function handleSubmit(consent: { agreed: boolean; timestamp: string; text: string }) {
    if (!recipientToken || !apiOrigin) return;
    setShowConsent(false);
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${apiOrigin}/api/esign/signing/${recipientToken}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signatureImages,
          consent,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Failed to submit signature (HTTP ${res.status})`);
      }

      setSubmitted(true);

      // Notify parent (CTO landing page) — use apiOrigin for security
      if (window.parent !== window && apiOrigin) {
        window.parent.postMessage({ type: "esign_complete" }, apiOrigin);
      }
    } catch (err: any) {
      setError(err.message || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeclineConfirm(reason: string | undefined) {
    if (!recipientToken || !apiOrigin) return;
    setShowDecline(false);
    setError(null);
    try {
      await fetch(`${apiOrigin}/api/esign/signing/${recipientToken}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (window.parent !== window && apiOrigin) {
        window.parent.postMessage({ type: "esign_declined" }, apiOrigin);
      }
      setDeclined(true);
    } catch {
      setError("Failed to decline. Please try again.");
    }
  }

  if (declined) {
    return (
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#64748b",
          color: "#fff",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          zIndex: 9999,
          boxShadow: "0 -4px 20px rgba(0,0,0,0.2)",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 16 }}>
          You have declined to sign this document.
        </span>
      </div>
    );
  }

  if (submitted && !dismissedBanner) {
    return (
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#30a46c",
          color: "#fff",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          zIndex: 9999,
          boxShadow: "0 -4px 20px rgba(0,0,0,0.2)",
        }}
      >
        <span style={{ fontSize: 20 }}>✓</span>
        <span style={{ fontWeight: 600, fontSize: 16 }}>
          Document signed successfully! You will receive a copy via email.
        </span>
        <button
          onClick={() => setDismissedBanner(true)}
          style={{
            position: "absolute",
            right: 16,
            top: "50%",
            transform: "translateY(-50%)",
            background: "transparent",
            border: "none",
            color: "#fff",
            fontSize: 18,
            cursor: "pointer",
            opacity: 0.7,
            padding: "4px 8px",
          }}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Bottom signing bar */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          background: "#1a1a2e",
          color: "#fff",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          zIndex: 9999,
          boxShadow: "0 -4px 20px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            Signing as <strong>{signerEmail}</strong>
          </div>
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 2 }}>
            {filledCount} of {totalCount} field{totalCount !== 1 ? "s" : ""} completed
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "#e5484d", maxWidth: 300 }}>{error}</div>
        )}

        <button
          onClick={() => setShowDecline(true)}
          style={{
            padding: "8px 16px",
            border: "1px solid #555",
            borderRadius: 6,
            background: "transparent",
            color: "#aaa",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Decline
        </button>

        {nextField && (
          <button
            onClick={handleNextField}
            style={{
              padding: "8px 16px",
              border: "1px solid #5070ff",
              borderRadius: 6,
              background: "transparent",
              color: "#5070ff",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            Next
            <span style={{ fontSize: 11 }}>↓</span>
          </button>
        )}

        <button
          onClick={() => setShowConsent(true)}
          disabled={!allRequiredFieldsFilled || submitting}
          style={{
            padding: "10px 24px",
            border: "none",
            borderRadius: 6,
            background: allRequiredFieldsFilled ? "#30a46c" : "#444",
            color: "#fff",
            fontWeight: 600,
            cursor: allRequiredFieldsFilled && !submitting ? "pointer" : "default",
            fontSize: 14,
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Submitting..." : "Finish & Sign"}
        </button>
      </div>

      {showConsent && (
        <ESignConsentDialog
          recipientEmail={signerEmail || ""}
          documentSubject={documentSubject}
          onConfirm={handleSubmit}
          onCancel={() => setShowConsent(false)}
        />
      )}

      {showDecline && (
        <ESignDeclineDialog
          onConfirm={handleDeclineConfirm}
          onCancel={() => setShowDecline(false)}
        />
      )}
    </>
  );
}
