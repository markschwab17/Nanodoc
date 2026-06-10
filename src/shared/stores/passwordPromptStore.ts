/**
 * Password Prompt Store
 *
 * Promise-based bridge between the PDF load path (which discovers a file is
 * password-protected) and the modal UI that asks the user for the password.
 * `ask()` resolves with the entered password, or null if the user cancels.
 */

import { create } from "zustand";

interface PasswordPromptState {
  /** Non-null while a prompt is being shown. */
  fileName: string | null;
  /** True when re-prompting after a wrong password. */
  wrongAttempt: boolean;
  resolver: ((password: string | null) => void) | null;

  ask: (fileName: string, wrongAttempt?: boolean) => Promise<string | null>;
  submit: (password: string | null) => void;
}

export const usePasswordPromptStore = create<PasswordPromptState>((set, get) => ({
  fileName: null,
  wrongAttempt: false,
  resolver: null,

  ask: (fileName, wrongAttempt = false) =>
    new Promise<string | null>((resolve) => {
      // If a prompt is somehow already open, cancel it first.
      get().resolver?.(null);
      set({ fileName, wrongAttempt, resolver: resolve });
    }),

  submit: (password) => {
    const resolve = get().resolver;
    set({ fileName: null, wrongAttempt: false, resolver: null });
    resolve?.(password);
  },
}));
