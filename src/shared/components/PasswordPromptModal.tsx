/**
 * Password Prompt Modal
 *
 * Shown when a PDF requires a password to open. Driven by
 * passwordPromptStore so the (non-React) load path can await the answer.
 */

import { useEffect, useRef, useState } from "react";
import { usePasswordPromptStore } from "@/shared/stores/passwordPromptStore";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";

export function PasswordPromptModal() {
  const fileName = usePasswordPromptStore((s) => s.fileName);
  const wrongAttempt = usePasswordPromptStore((s) => s.wrongAttempt);
  const submit = usePasswordPromptStore((s) => s.submit);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fileName) {
      setValue("");
      // Focus after mount/paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [fileName, wrongAttempt]);

  if (!fileName) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit(value);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40">
      <form
        onSubmit={handleSubmit}
        className="w-[24rem] max-w-[90vw] bg-background border rounded-lg shadow-xl p-4 space-y-3"
      >
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Password required</h2>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          “{fileName}” is password-protected.
        </p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          className="w-full h-9 px-3 rounded-md border bg-background text-sm"
          autoComplete="off"
        />
        {wrongAttempt && (
          <p className="text-xs text-destructive">Wrong password — try again.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => submit(null)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!value}>
            Open
          </Button>
        </div>
      </form>
    </div>
  );
}
