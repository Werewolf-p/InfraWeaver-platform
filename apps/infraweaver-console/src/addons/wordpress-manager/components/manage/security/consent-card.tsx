"use client";

/**
 * Cookie-consent config card (Ultimate). Shows the banner's on/off state, the
 * legal model + Consent Mode + policy version, PRIVACY-SAFE aggregates (counts
 * only — no raw consent-log row ever crosses the wire), and the trackers detected
 * on the site. Enabling is ALWAYS an explicit operator action (default-OFF holds):
 * the payload preserves the connector's own reported settings and only flips
 * `enabled`, so nothing is fabricated.
 */

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Cookie, Power, PowerOff } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Pill } from "../../demo/manage/kit/pill";
import { BTN_PRIMARY, BTN } from "../../demo/manage/manage-ui";
import { Spinner } from "../../demo/manage/panel-shell";
import {
  consentTogglePayload,
  type ConsentConfigResponse,
  type DetectedVendor,
} from "../../../lib/manage/security-consent";
import { saveConsent, securityKeys } from "../../../lib/manage/use-security";

export interface ConsentCardProps {
  readonly site: string;
  readonly consent: ConsentConfigResponse | null;
  readonly loading: boolean;
  /** Vendors detected by the header scan (so the operator sees what to cover). */
  readonly detectedVendors: readonly DetectedVendor[];
}

/** A single labelled aggregate tally list (by method / by region). */
function TallyList({ title, tally }: { title: string; tally: Record<string, number> }): ReactNode {
  const rows = Object.entries(tally);
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</p>
      <dl className="space-y-1 text-sm">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <dt className="text-zinc-600 dark:text-zinc-400">{key}</dt>
            <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ConsentCard({ site, consent, loading, detectedVendors }: ConsentCardProps): ReactNode {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const settings = consent?.settings;
  const enabled = consent?.enabled === true;
  const aggregates = consent?.aggregates;

  async function toggle(next: boolean): Promise<void> {
    setBusy(true);
    try {
      const res = await saveConsent(site, consentTogglePayload(settings, next));
      if (res.locked) {
        toast.error("Cookie consent is locked on this site's plan.");
        return;
      }
      toast.success(next ? "Cookie-consent banner enabled" : "Cookie-consent banner disabled");
      void queryClient.invalidateQueries({ queryKey: securityKeys.consent(site) });
      void queryClient.invalidateQueries({ queryKey: securityKeys.status(site) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update consent settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Cookie consent"
      description="GDPR/CCPA consent banner with prior tracker blocking. Advanced tuning (categories, vendors, Consent Mode) lives in the site's wp-admin."
      icon={Cookie}
      action={
        enabled ? (
          <button type="button" className={BTN} onClick={() => void toggle(false)} disabled={busy || loading}>
            {busy ? <Spinner /> : <PowerOff className="h-4 w-4" aria-hidden />} Disable
          </button>
        ) : (
          <button type="button" className={BTN_PRIMARY} onClick={() => void toggle(true)} disabled={busy || loading}>
            {busy ? <Spinner /> : <Power className="h-4 w-4" aria-hidden />} Enable banner
          </button>
        )
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Spinner /> Loading consent config…
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={enabled ? "good" : "neutral"}>{enabled ? "Banner active" : "Banner off"}</Pill>
            {settings?.default_model ? <Pill tone="info">Model: {settings.default_model}</Pill> : null}
            {settings?.consent_mode ? <Pill tone="info">Consent Mode v2</Pill> : null}
            {typeof settings?.policy_version === "number" ? <Pill tone="neutral">Policy v{settings.policy_version}</Pill> : null}
          </div>

          {aggregates && aggregates.records > 0 ? (
            <div className="grid gap-4 rounded-xl border border-zinc-200 p-4 sm:grid-cols-3 dark:border-zinc-800">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Records</p>
                <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{aggregates.records.toLocaleString()}</p>
              </div>
              <TallyList title="By choice" tally={aggregates.by_method} />
              <TallyList title="By region" tally={aggregates.by_region} />
            </div>
          ) : (
            <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
              No consent records yet. Aggregates appear once visitors interact with the banner (counts only — no personal data is ever sent here).
            </p>
          )}

          {detectedVendors.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Detected on your site</p>
              <div className="flex flex-wrap gap-1.5">
                {detectedVendors.map((v) => (
                  <Pill key={v.vendor} tone="warn">
                    {v.label} · {v.category}
                  </Pill>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
