"use client";

import { useEffect, type RefObject } from "react";
import { isTypingTarget } from "@/lib/keyboard-shortcuts";

interface UseSlashFocusOptions {
  /** Set false to temporarily disable the shortcut (e.g. while a modal is open). */
  enabled?: boolean;
}

/**
 * Focuses the referenced element when the user presses `/` — unless they are
 * already typing in an input, textarea, select, or contenteditable region.
 * Single shared copy of the per-page "/ focuses search" keydown listeners.
 */
export function useSlashFocus<T extends HTMLElement>(ref: RefObject<T | null>, options: UseSlashFocusOptions = {}): void {
  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "/") return;
      if (isTypingTarget(event)) return;
      event.preventDefault();
      ref.current?.focus();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, ref]);
}
