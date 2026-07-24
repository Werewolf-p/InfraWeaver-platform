"use client";

/**
 * Deliverability guidance — the "land it" step. Provider-aware SPF / DKIM / DMARC
 * guidance derived from the stored SMTP host (no live DNS lookup in this phase —
 * that's a follow-up; DKIM is inherently provider-side since the console holds no
 * key). Copy-pasteable suggested records so an operator isn't guessing.
 */

import { ShieldCheck } from "lucide-react";
import { detectPreset, findPreset } from "../../../lib/manage/email-presets";
import type { EmailSettings } from "../../../lib/manage/email";

function Record({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <code className="mt-0.5 block break-all font-mono text-[11px] text-zinc-800 dark:text-zinc-200">{value}</code>
    </div>
  );
}

export function EmailDeliverabilityCard({ settings }: { settings: EmailSettings | undefined }) {
  const preset = findPreset(detectPreset({ host: settings?.host ?? "" }));
  const spf = preset?.spfInclude
    ? `v=spf1 include:${preset.spfInclude} ~all`
    : "v=spf1 include:<your-provider-spf> ~all";
  const dmarc = "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain; pct=100";

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
        Publish these DNS records for your sending domain so strict inboxes accept your mail.
        {preset?.fromMustMatchAuth
          ? " This provider also requires the From address to be one the authenticated mailbox may send as."
          : null}
      </p>
      <Record label="SPF (TXT @)" value={spf} />
      <Record label="DMARC (TXT _dmarc)" value={dmarc} />
      {preset?.dkimDocsUrl ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          DKIM is set up in your provider&apos;s admin console.{" "}
          <a
            href={preset.dkimDocsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-600 underline decoration-dotted underline-offset-2 hover:text-sky-700 dark:text-sky-400"
          >
            {preset.label} DKIM guide
          </a>
        </p>
      ) : (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Enable DKIM signing in your SMTP provider&apos;s admin console and publish the selector record it gives you.
        </p>
      )}
    </div>
  );
}
