"use client";

/**
 * Shared Site Health pieces: the create-redirect modal (prefillable from a broken
 * link or a 404 suggestion), a locked/upsell card for tier-gated sub-sections, and
 * the pure helpers that map engine refusal tokens to human copy and derive a
 * redirect source path from a URL. The gauntlet stays in the connector — this form
 * only shape-collects and surfaces the engine's verbatim refusal.
 */

import { useEffect, useState, type JSX } from "react";
import { Lock } from "lucide-react";
import { toast } from "@/lib/notify";
import { BTN, BTN_PRIMARY, Field, INPUT, Modal } from "../../demo/manage/manage-ui";
import { REDIRECT_MATCHES, type RedirectCreateParams, type RedirectMutationResult } from "../../../lib/manage/site-health";

/** Map an engine refusal token to human copy; unknown tokens pass through. Pure. */
export function redirectReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "duplicate-source":
      return "A redirect already exists for that source path.";
    case "creates-redirect-loop":
      return "That would create a redirect loop — pick a different target.";
    case "reserved-source":
    case "reserved-path":
      return "That path is reserved (wp-admin / wp-login / wp-json) and can't be redirected.";
    case "self-loop":
      return "The source and target are the same.";
    case "invalid-source":
      return "The source must be a rooted path like /old-page.";
    case "invalid-target":
      return "The target isn't a valid path or allowed URL.";
    case "external-not-allowed":
      return "External targets aren't on the allow-list for this site.";
    case "max-rules":
      return "This site has reached the maximum of 500 redirects.";
    case "entitlement-locked":
      return "Redirects are included in the Pro plan.";
    default:
      return reason ? `Refused: ${reason}` : "The redirect could not be created.";
  }
}

/**
 * Derive a rooted redirect source from a (possibly absolute) broken-link URL, or
 * null when no path can be recovered. Query + fragment are dropped. Pure.
 */
export function deriveRedirectSource(url: string): string | null {
  const raw = url.trim();
  if (raw === "") return null;
  if (raw.startsWith("/")) {
    const path = raw.split("#")[0].split("?")[0];
    return path === "" ? null : path;
  }
  try {
    const u = new URL(raw);
    return u.pathname && u.pathname !== "" ? u.pathname : null;
  } catch {
    return null;
  }
}

export interface RedirectPrefill {
  readonly source?: string;
  readonly target?: string;
}

export interface RedirectCreateFormProps {
  readonly open: boolean;
  readonly initial: RedirectPrefill | null;
  readonly onClose: () => void;
  readonly onSubmit: (params: RedirectCreateParams) => Promise<RedirectMutationResult>;
}

/** The create-redirect modal — one motion whether opened blank or prefilled. */
export function RedirectCreateForm({ open, initial, onClose, onSubmit }: RedirectCreateFormProps): JSX.Element {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [type, setType] = useState<301 | 302>(301);
  const [match, setMatch] = useState<(typeof REDIRECT_MATCHES)[number]>("exact");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  // Re-seed the fields each time the modal opens with a (new) prefill.
  useEffect(() => {
    if (open) {
      setSource(initial?.source ?? "");
      setTarget(initial?.target ?? "");
      setType(301);
      setMatch("exact");
      setReason(null);
    }
  }, [open, initial]);

  async function submit(): Promise<void> {
    if (source.trim() === "" || target.trim() === "") {
      setReason("Both a source path and a target are required.");
      return;
    }
    setBusy(true);
    setReason(null);
    try {
      const result = await onSubmit({ source: source.trim(), target: target.trim(), type, match });
      if (result.ok) {
        toast.success("Redirect created.");
        onClose();
      } else {
        setReason(redirectReasonLabel(result.reason));
      }
    } catch (err) {
      setReason(err instanceof Error ? err.message : "The redirect could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title="Create redirect">
      <div className="grid gap-3">
        <Field label="Source path" htmlFor="sh-redirect-source" hint="A rooted path on this site, e.g. /old-page">
          <input id="sh-redirect-source" className={INPUT} value={source} onChange={(e) => setSource(e.target.value)} placeholder="/old-page" />
        </Field>
        <Field label="Target" htmlFor="sh-redirect-target" hint="A rooted path (/new-page) or an allow-listed URL">
          <input id="sh-redirect-target" className={INPUT} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/new-page" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" htmlFor="sh-redirect-type">
            <select id="sh-redirect-type" className={INPUT} value={type} onChange={(e) => setType(Number(e.target.value) as 301 | 302)}>
              <option value={301}>301 — permanent</option>
              <option value={302}>302 — temporary</option>
            </select>
          </Field>
          <Field label="Match" htmlFor="sh-redirect-match" hint="prefix retires a whole moved section (/old/*)">
            <select id="sh-redirect-match" className={INPUT} value={match} onChange={(e) => setMatch(e.target.value as typeof match)}>
              {REDIRECT_MATCHES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {reason ? <p className="text-sm text-red-600 dark:text-red-400">{reason}</p> : null}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className={BTN} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={() => void submit()} disabled={busy}>
            {busy ? "Creating…" : "Create redirect"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A tier-locked / switched-off sub-section: never hidden (it's the upsell). */
export function LockedCard({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-300/50 bg-amber-50/60 p-4 dark:border-amber-500/30 dark:bg-amber-950/20">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
        <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
      </div>
    </div>
  );
}
