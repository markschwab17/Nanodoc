/**
 * Quick-action prompt templates for the "Ask AI" text-selection menu.
 * Each action turns a PDF text selection into a question + a pinned `customPrompt`
 * (the selection is injected as guaranteed context so retrieval can't miss it).
 */

export type QuickActionId = 'explain' | 'summarize' | 'related'

export interface QuickActionDef {
  id: QuickActionId
  label: string
}

export const QUICK_ACTIONS: QuickActionDef[] = [
  { id: 'explain', label: 'Explain this' },
  { id: 'summarize', label: 'Summarize' },
  { id: 'related', label: 'Find related specs' },
]

export interface SelectionInput {
  page: number // 0-based
  quote: string
}

const QUESTIONS: Record<QuickActionId, string> = {
  explain:
    'Explain the selected text in plain language — what it means, the key values/requirements, and why it matters for the project.',
  summarize: 'Summarize the selected text concisely, keeping the key values and requirements.',
  related:
    'Find related specs, references, or requirements elsewhere in the document that relate to the selected text, and list them.',
}

/** The pinned-context block injected as `customPrompt` so the model always sees the selection. */
export function buildAskAboutSelectionContext(selection: SelectionInput): string {
  return `The user has selected the following text on page ${selection.page + 1} of the document:
"""
${selection.quote}
"""
Focus your answer on this selection (you may reference the rest of the document for context).`
}

export function buildQuickActionRequest(
  action: QuickActionId,
  selection: SelectionInput,
): { question: string; customPrompt: string } {
  return {
    question: QUESTIONS[action],
    customPrompt: buildAskAboutSelectionContext(selection),
  }
}
