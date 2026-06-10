/**
 * Decrypt-on-save consent.
 *
 * Encrypted PDFs are saved WITHOUT their protection (owner decision: detect +
 * warn + save unencrypted — the pdf-lib post-passes can't write encrypted
 * files, so this keeps every save path consistent). Before the first save of
 * an encrypted document we ask the user once; autosave stays disabled for the
 * document until they consent.
 */

import { isTauri } from "@/shared/utils/environment";
import type { PDFDocument } from "@/core/pdf/PDFDocument";

const consentedDocIds = new Set<string>();

export function hasDecryptConsent(docId: string): boolean {
  return consentedDocIds.has(docId);
}

/**
 * Returns true when saving may proceed. Prompts (once per document) when the
 * source was encrypted; remembers consent for the session.
 */
export async function confirmDecryptSave(doc: PDFDocument): Promise<boolean> {
  if (!doc.isEncrypted()) return true;
  if (consentedDocIds.has(doc.getId())) return true;

  const message =
    "This PDF is password-protected or restricted.\n\n" +
    "Saving with Nanodoc will produce an UNPROTECTED copy — the password and " +
    "restrictions are removed. Continue?";

  let ok = false;
  try {
    if (isTauri) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      ok = await ask(message, {
        title: "Remove PDF protection?",
        kind: "warning",
        okLabel: "Save unprotected",
        cancelLabel: "Cancel",
      });
    } else {
      ok = window.confirm(message);
    }
  } catch {
    // If the dialog itself fails, err on the side of not saving silently.
    ok = false;
  }

  if (ok) consentedDocIds.add(doc.getId());
  return ok;
}
