"use client";

/**
 * Shared building blocks for the Manage console's ACTION surfaces — the reusable
 * layer every actionable panel (Users, Content, Plugins & Themes, Settings) draws
 * from so form/dialog/error handling is identical everywhere. Nothing here talks
 * to wp-cli directly; every mutation goes through the one allow-listed action path
 * (`useManageAction` → POST /manage), and 409 guardrail violations surface as clear
 * inline messages. Matches the console's zinc/sky Tailwind language, light + dark.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { EASE_OUT } from "../motion";
import type { ManageAction, ManageActionResult } from "../../../lib/manage/actions";
import { useManageAction } from "./use-manage";
import { Spinner } from "./panel-shell";
import { confirmationMatches } from "./form-validation";

// ── Shared control classes ────────────────────────────────────────────────────

export const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
export const BTN_SM =
  "inline-flex items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_DANGER =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500 bg-red-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_DANGER_GHOST =
  "inline-flex items-center justify-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500/40 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/40";

export const INPUT =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 transition-colors focus-visible:border-sky-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/30 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-100 dark:placeholder:text-zinc-500";

// ── Action runner (409-aware) ─────────────────────────────────────────────────

export interface RunOptions {
  /** Show a success toast on ok (default true). */
  readonly successToast?: boolean;
  /** Called after a successful action (e.g. reload the panel / close a dialog). */
  readonly onSuccess?: (message: string) => void;
}

export interface ActionRunner {
  run(action: ManageAction, opts?: RunOptions): Promise<ManageActionResult>;
  readonly pending: boolean;
  /** Last failure message (guardrail 409, RBAC 403, validation 400 …) for inline display. */
  readonly error: string | null;
  clearError(): void;
}

/**
 * Wrap the raw Manage mutation with toast + inline-error handling. On failure the
 * server's message (including a 409 guardrail explanation) is stored in `error`
 * for the calling form to render inline, AND toasted. On success it toasts and
 * invokes `onSuccess`.
 */
export function useActionRunner(site: string): ActionRunner {
  const { run: rawRun, pending } = useManageAction(site);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: ManageAction, opts?: RunOptions): Promise<ManageActionResult> => {
      setError(null);
      const result = await rawRun(action);
      if (result.ok) {
        if (opts?.successToast !== false) toast.success(result.message);
        opts?.onSuccess?.(result.message);
      } else {
        setError(result.message);
        toast.error(result.message);
      }
      return result;
    },
    [rawRun],
  );

  return { run, pending, error, clearError: () => setError(null) };
}

// ── Inline error banner (guardrail / validation surfacing) ────────────────────

export function ActionError({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-300"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-red-500/80 transition-colors hover:text-red-600 dark:hover:text-red-300"
          aria-label="Dismiss error"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// ── Field primitives ──────────────────────────────────────────────────────────

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
}

// ── Portal + Modal ────────────────────────────────────────────────────────────

function BodyPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- portal must mount client-side only; not derived render state
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

/**
 * Accessible modal dialog: portalled to the body (escapes any overflow/stacking
 * context), backdrop + Escape close, focus moved in on open and restored on close,
 * `role="dialog"` + `aria-modal` + labelled title. Uses the app's semantic
 * `z-modal` layer. Reduced-motion friendly via the shared MotionConfig upstream.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = "neutral",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon?: React.ElementType;
  tone?: "neutral" | "danger";
  children: ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  const iconWrap =
    tone === "danger"
      ? "bg-red-500/10 text-red-600 dark:text-red-400"
      : "bg-sky-500/10 text-sky-600 dark:text-sky-400";

  return (
    <BodyPortal>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onMouseDown={onClose}
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={description ? descId : undefined}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.97, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 10 }}
              transition={{ duration: 0.18, ease: EASE_OUT }}
              onMouseDown={(e) => e.stopPropagation()}
              className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-5 dark:border-zinc-800">
                <div className="flex items-start gap-3">
                  {Icon ? (
                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", iconWrap)}>
                      <Icon className="h-4.5 w-4.5" aria-hidden />
                    </span>
                  ) : null}
                  <div className="min-w-0">
                    <h2 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                      {title}
                    </h2>
                    {description ? (
                      <p id={descId} className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                        {description}
                      </p>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="p-5">{children}</div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </BodyPortal>
  );
}

// ── Confirm dialog (with optional typed confirmation) ─────────────────────────

/**
 * Confirmation dialog for destructive/sensitive actions. When `confirmPhrase` is
 * set the operator must type it verbatim to arm the confirm button (typed
 * confirmation — e.g. the site or user name). Guardrails are ALSO enforced
 * server-side (409), so this is defense-in-depth, never the only check.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  body,
  confirmLabel = "Confirm",
  confirmPhrase,
  confirmPhraseLabel,
  tone = "danger",
  pending = false,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  body?: ReactNode;
  confirmLabel?: string;
  confirmPhrase?: string;
  confirmPhraseLabel?: string;
  tone?: "neutral" | "danger";
  pending?: boolean;
  error?: string | null;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();

  // Reset the typed phrase whenever the dialog re-opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dependency-driven reset on re-open; not derived render state
    if (open) setTyped("");
  }, [open]);

  const armed = !confirmPhrase || confirmationMatches(typed, confirmPhrase);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      icon={AlertTriangle}
      tone={tone}
    >
      <div className="space-y-4">
        {body}
        {confirmPhrase ? (
          <Field
            label={confirmPhraseLabel ?? "Type to confirm"}
            htmlFor={inputId}
            hint={
              <>
                {"Type "}
                <span className="font-mono font-medium text-zinc-700 dark:text-zinc-200">{confirmPhrase}</span>
                {" to continue."}
              </>
            }
          >
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={INPUT}
              placeholder={confirmPhrase}
            />
          </Field>
        ) : null}
        {error ? <ActionError message={error} /> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={BTN} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={tone === "danger" ? BTN_DANGER : BTN_PRIMARY}
            onClick={onConfirm}
            disabled={!armed || pending}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
