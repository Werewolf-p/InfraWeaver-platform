"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Selector for elements that can receive keyboard focus inside a dialog.
 * `[tabindex="-1"]` is intentionally excluded (programmatic focus only).
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface UseDialogA11yOptions {
  /** Whether the dialog is open. When false the hook is fully inert. */
  open: boolean;
  /** Invoked when the user requests close (Escape). */
  onClose: () => void;
  /** Ref to the dialog container whose focus should be trapped. */
  ref: RefObject<HTMLElement | null>;
  /** Element to focus when the dialog opens. Defaults to the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Close on Escape. Default true. Set false for destructive-confirm dialogs. */
  closeOnEscape?: boolean;
  /** Lock body scroll while open. Default true. */
  lockScroll?: boolean;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Shared accessibility behaviour for hand-rolled (non-Radix) dialogs, sheets and
 * drawers. While `open`, it:
 *  - locks body scroll (restoring the prior value on close),
 *  - closes on Escape,
 *  - traps Tab / Shift+Tab focus within `ref`,
 *  - moves focus into the dialog on open and restores it to the opener on close.
 *
 * Radix-based dialogs already provide trap + restore, so use this only for the
 * framer-motion / bespoke overlays that lack it. Pure and side-effect scoped —
 * every mutation is undone in cleanup.
 */
export function useDialogA11y({
  open,
  onClose,
  ref,
  initialFocusRef,
  closeOnEscape = true,
  lockScroll = true,
}: UseDialogA11yOptions): void {
  // Keep the latest onClose without making it an effect dependency, so an inline
  // callback from the consumer does not re-run setup (which would corrupt the
  // saved scroll value / opener focus).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (lockScroll) body.style.overflow = "hidden";

    // Move focus into the dialog.
    const container = ref.current;
    const initial = initialFocusRef?.current ?? (container ? getFocusable(container)[0] : null);
    initial?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (closeOnEscape && event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const el = ref.current;
      if (!el) return;

      const focusable = getFocusable(el);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !el.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !el.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (lockScroll) body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, ref, initialFocusRef, closeOnEscape, lockScroll]);
}
