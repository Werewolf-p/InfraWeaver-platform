"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/notify";

interface CopyOptions {
  successMessage?: string;
  errorMessage?: string;
}

async function writeClipboard(text: string): Promise<boolean> {
  // Preferred path: async Clipboard API. Requires a secure context (https) and
  // clipboard-write permission, so it can throw — fall through when it does.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Insecure context or permission denied — try the legacy path below.
    }
  }

  // Legacy fallback: a hidden, selected textarea + execCommand("copy"). Works
  // over plain HTTP and in contexts where the async Clipboard API is blocked.
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function useCopyToClipboard(resetDelayMs = 2000) {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setCopiedText(null);
  }, []);

  useEffect(() => reset, [reset]);

  const copy = useCallback(
    async (text: string, options?: CopyOptions) => {
      const ok = await writeClipboard(text);
      if (!ok) {
        toast.error(options?.errorMessage ?? "Failed to copy");
        setCopiedText(null);
        return false;
      }
      setCopiedText(text);
      toast.success(options?.successMessage ?? "Copied to clipboard");
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopiedText(null), resetDelayMs);
      return true;
    },
    [resetDelayMs],
  );

  return {
    copy,
    copiedText,
    isCopied: (text: string) => copiedText === text,
    reset,
  };
}
