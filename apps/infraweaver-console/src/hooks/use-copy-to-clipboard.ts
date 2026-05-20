"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/notify";

interface CopyOptions {
  successMessage?: string;
  errorMessage?: string;
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
      try {
        await navigator.clipboard.writeText(text);
        setCopiedText(text);
        toast.success(options?.successMessage ?? "Copied to clipboard");
        if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setCopiedText(null), resetDelayMs);
        return true;
      } catch {
        toast.error(options?.errorMessage ?? "Failed to copy");
        setCopiedText(null);
        return false;
      }
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
