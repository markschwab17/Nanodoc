import { useEffect, useRef, useState } from "react";

/**
 * Speech-to-text dictation for a text field.
 *
 * Embedded in CTO (cross-origin/credentialless iframe) the mic is blocked locally,
 * so it delegates to the top-frame bridge over postMessage (see CTO
 * useNanodocDictationBridge + docs/NANODOC_EMBED.md). Standalone, it runs the Web
 * Speech API directly. Controlled via getText/setText so it appends to whatever's
 * already in the field.
 */
interface UseDictationOpts {
  getText: () => string;
  setText: (text: string) => void;
  onError?: (message: string) => void;
}

export function useDictation({ getText, setText, onError }: UseDictationOpts) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const baseRef = useRef<string>("");
  const listeningRef = useRef(false);
  const optsRef = useRef({ getText, setText, onError });
  optsRef.current = { getText, setText, onError };

  const isEmbedded = typeof window !== "undefined" && window.parent !== window;
  const supported =
    isEmbedded ||
    (typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window));

  useEffect(() => {
    listeningRef.current = isListening;
  }, [isListening]);

  // Stop any local recognition on unmount.
  useEffect(() => () => {
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const reportError = (err: string | undefined) => {
    if (err === "not-allowed" || err === "service-not-allowed") {
      optsRef.current.onError?.("Microphone access is blocked. Allow microphone access for this site to dictate.");
    } else if (err === "not-supported") {
      optsRef.current.onError?.("Speech recognition isn't supported in this browser.");
    } else if (err && err !== "aborted" && err !== "no-speech") {
      optsRef.current.onError?.(`Dictation error: ${err}`);
    }
  };

  // Embedded: receive transcript/results from the top-frame bridge. Only the instance
  // that started dictation (listeningRef) applies results.
  useEffect(() => {
    if (!isEmbedded) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window.parent && e.source !== window.top) return;
      const d: any = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "nanodoc-dictation-result") {
        if (!listeningRef.current) return;
        optsRef.current.setText((baseRef.current + (d.transcript || "")).replace(/\s+/g, " ").trimStart());
      } else if (d.type === "nanodoc-dictation-end") {
        setIsListening(false);
      } else if (d.type === "nanodoc-dictation-error") {
        setIsListening(false);
        reportError(d.error);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEmbedded]);

  const toggle = () => {
    if (isEmbedded) {
      const target = window.top ?? window.parent;
      if (isListening) {
        target.postMessage({ type: "nanodoc-dictation-stop" }, "*");
        setIsListening(false);
        return;
      }
      const cur = optsRef.current.getText();
      baseRef.current = cur ? cur.trim() + " " : "";
      target.postMessage({ type: "nanodoc-dictation-start" }, "*");
      setIsListening(true);
      return;
    }

    // Standalone: local Web Speech API.
    if (isListening) {
      try { recognitionRef.current?.stop(); } catch { /* ignore */ }
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    const cur = optsRef.current.getText();
    baseRef.current = cur ? cur.trim() + " " : "";
    let finals = "";
    rec.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finals += t;
        else interim += t;
      }
      optsRef.current.setText((baseRef.current + finals + interim).replace(/\s+/g, " ").trimStart());
    };
    rec.onend = () => { setIsListening(false); recognitionRef.current = null; };
    rec.onerror = (e: any) => { setIsListening(false); recognitionRef.current = null; reportError(e?.error); };
    recognitionRef.current = rec;
    try {
      rec.start();
      setIsListening(true);
    } catch {
      optsRef.current.onError?.("Couldn't start dictation.");
    }
  };

  /** Stop dictation (e.g. when the user submits). */
  const stop = () => {
    if (!isListening) return;
    if (isEmbedded) (window.top ?? window.parent).postMessage({ type: "nanodoc-dictation-stop" }, "*");
    else { try { recognitionRef.current?.stop(); } catch { /* ignore */ } }
    setIsListening(false);
  };

  return { supported, isListening, toggle, stop };
}
