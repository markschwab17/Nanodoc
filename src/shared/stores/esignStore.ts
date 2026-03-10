/**
 * E-Sign Store
 *
 * Manages state for e-signature prepare mode (sender placing fields)
 * and signing mode (recipient filling fields).
 */

import { create } from "zustand";

export type ESignMode = "prepare" | "sign" | null;

export interface ESignRecipient {
  email: string;
  name?: string;
  color: string;
}

export interface ESignFieldPlacement {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  signerEmail: string;
  fieldType: "signature" | "initials" | "date" | "name" | "text";
  required: boolean;
  label?: string;
}

interface ESignState {
  mode: ESignMode;
  envelopeId: string | null;
  recipientToken: string | null;
  signerEmail: string | null;
  apiOrigin: string | null;

  // Prepare mode state
  recipients: ESignRecipient[];
  activeRecipient: string | null; // email of currently selected recipient for field placement
  currentFieldType: "signature" | "initials" | "date" | "name" | "text";

  // Signing mode state
  fieldPlacements: ESignFieldPlacement[]; // fields the signer needs to fill
  signatureImages: Record<string, string>; // fieldId -> base64 PNG

  // Computed
  allRequiredFieldsFilled: boolean;

  // Actions
  setMode: (mode: ESignMode) => void;
  setEnvelopeId: (id: string | null) => void;
  setRecipientToken: (token: string | null) => void;
  setSignerEmail: (email: string | null) => void;
  setApiOrigin: (origin: string | null) => void;
  setRecipients: (recipients: Array<{ email: string; name?: string; color?: string }>) => void;
  setActiveRecipient: (email: string | null) => void;
  setCurrentFieldType: (type: "signature" | "initials" | "date" | "name" | "text") => void;
  setFieldPlacements: (placements: ESignFieldPlacement[]) => void;
  setSignatureImage: (fieldId: string, imageData: string) => void;
  clearSignatureImage: (fieldId: string) => void;
  reset: () => void;
}

// Distinct colors for up to 8 recipients
const RECIPIENT_COLORS = [
  "#5070ff", "#e5484d", "#30a46c", "#e8960b",
  "#7c66dc", "#0091ff", "#e54666", "#3ac275",
];

export const useESignStore = create<ESignState>((set, get) => ({
  mode: null,
  envelopeId: null,
  recipientToken: null,
  signerEmail: null,
  apiOrigin: null,
  recipients: [],
  activeRecipient: null,
  currentFieldType: "signature",
  fieldPlacements: [],
  signatureImages: {},
  allRequiredFieldsFilled: false,

  setMode: (mode) => set({ mode }),
  setEnvelopeId: (id) => set({ envelopeId: id }),
  setRecipientToken: (token) => set({ recipientToken: token }),
  setSignerEmail: (email) => set({ signerEmail: email }),
  setApiOrigin: (origin) => set({ apiOrigin: origin }),

  setRecipients: (recipients) => {
    const colored = recipients.map((r, i) => ({
      ...r,
      color: r.color || RECIPIENT_COLORS[i % RECIPIENT_COLORS.length],
    }));
    set({ recipients: colored, activeRecipient: colored[0]?.email ?? null });
  },

  setActiveRecipient: (email) => set({ activeRecipient: email }),

  setCurrentFieldType: (type) => set({ currentFieldType: type }),

  setFieldPlacements: (placements) => set({ fieldPlacements: placements }),

  setSignatureImage: (fieldId, imageData) => {
    const current = get().signatureImages;
    const updated = { ...current, [fieldId]: imageData };
    const placements = get().fieldPlacements;
    const allFilled = placements
      .filter((f) => f.required)
      .every((f) => updated[f.id]);
    set({ signatureImages: updated, allRequiredFieldsFilled: allFilled });
  },

  clearSignatureImage: (fieldId) => {
    const current = { ...get().signatureImages };
    delete current[fieldId];
    const placements = get().fieldPlacements;
    const allFilled = placements
      .filter((f) => f.required)
      .every((f) => current[f.id]);
    set({ signatureImages: current, allRequiredFieldsFilled: allFilled });
  },

  reset: () =>
    set({
      mode: null,
      envelopeId: null,
      recipientToken: null,
      signerEmail: null,
      apiOrigin: null,
      recipients: [],
      activeRecipient: null,
      currentFieldType: "signature",
      fieldPlacements: [],
      signatureImages: {},
      allRequiredFieldsFilled: false,
    }),
}));
