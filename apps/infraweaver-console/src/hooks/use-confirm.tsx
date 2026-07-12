"use client";

import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  danger?: boolean;
  /** Type-to-confirm variant: the user must type this exact value before the confirm button unlocks. */
  requireTyping?: string;
}

export interface UseConfirmResult {
  /** Opens the dialog and resolves `true` on confirm, `false` on cancel/dismiss. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Render this once near the end of the component's JSX. */
  confirmDialog: ReactElement;
}

/**
 * Promise-based wrapper around {@link ConfirmDialog} so callers can write
 * `if (await confirm({ title: "Delete app?", danger: true })) { … }` instead of
 * hand-rolling open/onConfirm/onCancel state per page.
 */
export function useConfirm(): UseConfirmResult {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback((nextOptions: ConfirmOptions) => {
    // A new request supersedes any dialog that is still open.
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOptions(nextOptions);
    });
  }, []);

  const confirmDialog = useMemo(
    () => (
      <ConfirmDialog
        open={options !== null}
        title={options?.title ?? ""}
        description={options?.description}
        confirmText={options?.confirmText}
        danger={options?.danger}
        requireTyping={options?.requireTyping}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    ),
    [options, settle],
  );

  return { confirm, confirmDialog };
}
