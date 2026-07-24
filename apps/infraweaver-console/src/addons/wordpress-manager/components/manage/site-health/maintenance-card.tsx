"use client";

/**
 * Maintenance sub-section — ONE control that never fights itself. On a linked +
 * entitled site the orchestrator (server-side) drives the signed connector engine
 * (branded page, IP allow-list, auto-off) and deletes the mu-plugin option so the
 * two 503 layers are mutually exclusive; on an un-entitled site the same PUT falls
 * back to the plain mu-plugin toggle. This card renders the connector state from
 * the snapshot and previews the exact holding page in a script-free sandboxed
 * iframe.
 */

import { useEffect, useState, type JSX } from "react";
import { Power, Eye } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Pill } from "../../demo/manage/kit";
import { BTN, BTN_PRIMARY, INPUT, Field } from "../../demo/manage/manage-ui";
import type { SiteHealthActions } from "../../../lib/manage/use-site-health";
import { HEADLINE_MAX, MESSAGE_MAX, MAX_ALLOW_IPS, type MaintenanceState } from "../../../lib/manage/site-health";
import { LockedCard } from "./redirect-form";

/** Minimal HTML escape for the srcdoc preview (the real page escapes too). Pure. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the sandboxed preview document (approximates the connector holding page). Pure. */
export function buildPreviewDoc(headline: string, message: string): string {
  const h = esc(headline || "We'll be right back");
  const m = esc(message || "This site is temporarily unavailable while we perform scheduled maintenance.");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
    .box{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}p{margin:0;color:#94a3b8;line-height:1.6}
  </style></head><body><div class="box"><h1>${h}</h1><p>${m}</p></div></body></html>`;
}

/** Parse an allow-list textarea (one IP per line) into a bounded array. Pure. */
export function parseAllowIps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, MAX_ALLOW_IPS);
}

export interface MaintenanceCardProps {
  readonly maintenance: MaintenanceState;
  readonly actions: SiteHealthActions;
}

export function MaintenanceCard({ maintenance, actions }: MaintenanceCardProps): JSX.Element {
  const locked = maintenance.locked === true;
  const [enabled, setEnabled] = useState(maintenance.enabled === true);
  const [headline, setHeadline] = useState(maintenance.headline ?? "");
  const [message, setMessage] = useState(maintenance.message ?? "");
  const [retryAfter, setRetryAfter] = useState(maintenance.retry_after === true);
  const [hours, setHours] = useState(0);
  const [allowText, setAllowText] = useState((maintenance.allow_ips ?? []).join("\n"));
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-seed from a fresh snapshot (e.g. after another save invalidates the panel).
  useEffect(() => {
    setEnabled(maintenance.enabled === true);
    setHeadline(maintenance.headline ?? "");
    setMessage(maintenance.message ?? "");
    setRetryAfter(maintenance.retry_after === true);
    setAllowText((maintenance.allow_ips ?? []).join("\n"));
  }, [maintenance]);

  async function save(nextEnabled: boolean): Promise<void> {
    setBusy(true);
    try {
      const until = hours > 0 ? Math.floor(Date.now() / 1000) + hours * 3600 : 0;
      await actions.setMaintenance({
        enabled: nextEnabled,
        headline: headline.slice(0, HEADLINE_MAX),
        message: message.slice(0, MESSAGE_MAX),
        retryAfter,
        until,
        allowIps: parseAllowIps(allowText),
      });
      setEnabled(nextEnabled);
      toast.success(nextEnabled ? "Maintenance mode enabled." : "Maintenance mode disabled.");
    } catch {
      /* hook toasts the error */
    } finally {
      setBusy(false);
    }
  }

  const remaining = maintenance.until && maintenance.until > Math.floor(Date.now() / 1000)
    ? Math.ceil((maintenance.until - Math.floor(Date.now() / 1000)) / 3600)
    : 0;

  return (
    <SectionCard
      title="Maintenance mode"
      description="Put the site behind a branded holding page for anonymous visitors — admins always pass through."
      icon={Power}
      action={<Pill tone={enabled ? "warn" : "good"}>{enabled ? "On" : "Off"}</Pill>}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={enabled ? BTN : BTN_PRIMARY}
            onClick={() => void save(!enabled)}
            disabled={busy || actions.pending}
          >
            <Power className="h-3.5 w-3.5" aria-hidden /> {enabled ? "Turn off" : "Turn on"}
          </button>
          {remaining > 0 ? <Pill tone="neutral">auto-off in ~{remaining}h</Pill> : null}
          <button type="button" className={BTN} onClick={() => setShowPreview((v) => !v)}>
            <Eye className="h-3.5 w-3.5" aria-hidden /> {showPreview ? "Hide preview" : "Preview page"}
          </button>
        </div>

        {locked ? (
          <LockedCard
            title="Branding & allow-list — included in Pro"
            body="The simple maintenance page works on any plan. Upgrade for a branded page, an IP allow-list and auto-off."
          />
        ) : (
          <div className="grid gap-3">
            <Field label="Headline" htmlFor="sh-mm-headline">
              <input id="sh-mm-headline" className={INPUT} value={headline} maxLength={HEADLINE_MAX} onChange={(e) => setHeadline(e.target.value)} placeholder="We'll be right back" />
            </Field>
            <Field label="Message" htmlFor="sh-mm-message">
              <textarea id="sh-mm-message" className={`${INPUT} h-20`} value={message} maxLength={MESSAGE_MAX} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Auto-off (hours from now, 0 = never)" htmlFor="sh-mm-hours">
                <input id="sh-mm-hours" type="number" min={0} max={168} className={INPUT} value={hours} onChange={(e) => setHours(Math.max(0, Number(e.target.value) || 0))} />
              </Field>
              <label className="mt-6 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={retryAfter} onChange={(e) => setRetryAfter(e.target.checked)} />
                Send a Retry-After header
              </label>
            </div>
            <Field
              label={`IP allow-list (one per line, ≤ ${MAX_ALLOW_IPS})`}
              htmlFor="sh-mm-ips"
              hint="Checked against REMOTE_ADDR only — works when your host passes the real client IP (not behind a caching proxy)."
            >
              <textarea id="sh-mm-ips" className={`${INPUT} h-16 font-mono text-[11px]`} value={allowText} onChange={(e) => setAllowText(e.target.value)} placeholder="203.0.113.7" />
            </Field>
            <div className="flex justify-end">
              <button type="button" className={BTN_PRIMARY} onClick={() => void save(enabled)} disabled={busy || actions.pending}>
                Save page settings
              </button>
            </div>
          </div>
        )}

        {showPreview ? (
          <iframe
            title="Maintenance page preview"
            className="h-64 w-full rounded-xl border border-zinc-200 dark:border-zinc-800"
            sandbox=""
            srcDoc={buildPreviewDoc(headline, message)}
          />
        ) : null}
      </div>
    </SectionCard>
  );
}
