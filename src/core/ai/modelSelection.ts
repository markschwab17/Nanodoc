/** Gemini model used for full document Q&A and follow-ups. */
export const QA_MODEL = 'gemini-2.5-pro'
/** Lighter/faster model for selection quick actions (Explain/Summarize/etc.). */
export const QUICK_ACTION_MODEL = 'gemini-2.5-flash'
/** Opt-in preview model for Q&A (gated behind a flag — may be rate-limited). */
export const PREVIEW_QA_MODEL = 'gemini-3-pro-preview'

export function resolveQaModel(opts?: { preferPreview?: boolean }): string {
  return opts?.preferPreview ? PREVIEW_QA_MODEL : QA_MODEL
}
