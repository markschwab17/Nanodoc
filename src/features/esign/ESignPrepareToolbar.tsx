/**
 * E-Sign Prepare Toolbar
 *
 * Shown in prepare mode when the sender is placing signature fields.
 * Replaces the normal toolbar. Shows recipient selector, field type picker, and send button.
 */

import { useState } from "react";
import { useESignStore } from "@/shared/stores/esignStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import {
  MousePointer2,
  PenLine,
  CaseSensitive,
  CalendarDays,
  User,
  Type,
  SendHorizonal,
  CheckCircle2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type FieldTypeValue = "signature" | "initials" | "date" | "name" | "text";

const FIELD_TYPES: { value: FieldTypeValue; label: string; Icon: LucideIcon }[] = [
  { value: "signature", label: "Signature", Icon: PenLine },
  { value: "initials", label: "Initials", Icon: CaseSensitive },
  { value: "date", label: "Date", Icon: CalendarDays },
  { value: "name", label: "Name", Icon: User },
  { value: "text", label: "Text", Icon: Type },
];

export default function ESignPrepareToolbar() {
  const {
    recipients,
    activeRecipient,
    currentFieldType,
    setActiveRecipient,
    setCurrentFieldType,
    envelopeId,
    apiOrigin,
  } = useESignStore();

  const activeTool = useUIStore((s) => s.activeTool);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSelectMode = activeTool === "select";

  function handleSelectClick() {
    useUIStore.getState().setActiveTool("select");
  }

  function handleFieldTypeClick(type: FieldTypeValue) {
    setCurrentFieldType(type);
    useUIStore.getState().setActiveTool("signatureField");
  }

  async function handleSendForSignature() {
    if (!envelopeId) return;
    setError(null);
    setSending(true);

    try {
      const store = usePDFStore.getState();
      const doc = store.getCurrentDocument();
      if (!doc) throw new Error("No document loaded");

      const allAnnotations = store.annotations.get(doc.getId()) || [];
      const sigFields = allAnnotations.filter((a) => a.type === "signatureField");

      if (sigFields.length === 0) {
        throw new Error("Place at least one field first.");
      }

      const fieldPlacements = sigFields.map((a) => ({
        id: a.id,
        page: a.pageNumber,
        x: a.x,
        y: a.y,
        width: a.width || 200,
        height: a.height || 60,
        signerEmail: a.signerEmail || "",
        fieldType: a.signatureFieldType || "signature",
        required: a.signatureFieldRequired !== false,
        label: a.signatureFieldLabel,
      }));

      if (window.parent === window) {
        throw new Error("Must be opened from CivilTakeoff.");
      }

      // Send field placements to CTO parent via postMessage (avoids CORS)
      // Parent will PATCH the envelope and POST /send on our behalf
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve({ success: false, error: "Send timed out. Please try again." });
        }, 30000);

        function handler(event: MessageEvent) {
          if (event.data?.type === "esign_send_result" && event.data?.envelopeId === envelopeId) {
            clearTimeout(timeout);
            window.removeEventListener("message", handler);
            resolve({ success: event.data.success, error: event.data.error });
          }
        }
        window.addEventListener("message", handler);

        window.parent.postMessage(
          { type: "esign_prepare_send", envelopeId, fieldPlacements },
          "*"
        );
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to send envelope");
      }

      setSent(true);

      // Notify parent that prepare flow is complete
      window.parent.postMessage(
        { type: "esign_prepare_complete", envelopeId, success: true },
        "*"
      );
    } catch (err: any) {
      setError(err.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 py-3 px-2 bg-secondary/80 border-l w-14 h-full overflow-y-auto">
      {/* Signer label */}
      <span className="text-[9px] font-medium text-muted-foreground tracking-wider uppercase">
        Signer
      </span>
      {recipients.map((r) => (
        <button
          key={r.email}
          onClick={() => {
            setActiveRecipient(r.email);
            useUIStore.getState().setActiveTool("signatureField");
          }}
          title={r.name || r.email}
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 transition-shadow"
          style={{
            background: activeRecipient === r.email ? r.color : "hsl(var(--muted-foreground) / 0.3)",
            boxShadow: activeRecipient === r.email ? `0 0 0 2px ${r.color}40` : "none",
          }}
        >
          {(r.name || r.email).charAt(0).toUpperCase()}
        </button>
      ))}

      <div className="w-8 h-px bg-border" />

      {/* Select tool */}
      <button
        onClick={handleSelectClick}
        title="Select / Move / Resize"
        className={`w-10 h-9 rounded-md flex flex-col items-center justify-center gap-0.5 transition-colors ${
          isSelectMode
            ? "bg-primary text-primary-foreground"
            : "bg-muted hover:bg-accent text-muted-foreground hover:text-foreground"
        }`}
      >
        <MousePointer2 className="w-4 h-4" strokeWidth={1.75} />
        <span className="text-[7px] leading-none">Select</span>
      </button>

      <div className="w-8 h-px bg-border" />

      {/* Fields label */}
      <span className="text-[9px] font-medium text-muted-foreground tracking-wider uppercase">
        Fields
      </span>
      {FIELD_TYPES.map((ft) => {
        const isFieldActive = activeTool === "signatureField" && currentFieldType === ft.value;
        return (
          <button
            key={ft.value}
            onClick={() => handleFieldTypeClick(ft.value)}
            title={ft.label}
            className={`w-10 h-9 rounded-md flex flex-col items-center justify-center gap-0.5 transition-colors ${
              isFieldActive
                ? "bg-primary text-primary-foreground"
                : "bg-muted hover:bg-accent text-muted-foreground hover:text-foreground"
            }`}
          >
            <ft.Icon className="w-4 h-4" strokeWidth={1.75} />
            <span className="text-[7px] leading-none">{ft.label}</span>
          </button>
        );
      })}

      <div className="flex-1" />

      {/* Error */}
      {error && (
        <p className="text-[9px] text-destructive text-center px-0.5 leading-tight">
          {error}
        </p>
      )}

      {/* Sent success */}
      {sent ? (
        <div className="w-11 h-11 rounded-lg flex flex-col items-center justify-center gap-0.5 bg-emerald-600 text-white shrink-0">
          <CheckCircle2 className="w-5 h-5" strokeWidth={1.75} />
          <span className="text-[8px] font-medium">Sent!</span>
        </div>
      ) : (
        <button
          onClick={handleSendForSignature}
          disabled={sending}
          title="Send for signature"
          className="w-11 h-11 rounded-lg flex flex-col items-center justify-center gap-0.5 bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors shrink-0"
        >
          <SendHorizonal className="w-4.5 h-4.5" strokeWidth={1.75} />
          <span className="text-[9px] font-medium">{sending ? "..." : "Send"}</span>
        </button>
      )}
    </div>
  );
}
