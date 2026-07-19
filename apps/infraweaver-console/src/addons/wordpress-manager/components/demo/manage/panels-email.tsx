"use client";

// Email tab for the per-site "Manage" demo console — SMTP auth, deliverability, send log.
import { Inbox, Mail, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { EmailLogRow, SiteManageExt } from "../site-manage-ext-data";
import { HealthGauge, SectionCard, StatTile, healthTone } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");

const STATUS_TONE: Readonly<Record<EmailLogRow["status"], string>> = {
  delivered: TONE.good,
  deferred: TONE.warn,
  bounced: TONE.critical,
  spam: TONE.critical,
};

function AuthBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span className={cn(PILL, ok ? TONE.good : TONE.warn)}>
      {label} {ok ? "✓" : "✗"}
    </span>
  );
}

export function EmailPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const e = ext.email;
  const openRate = e.delivered > 0 ? Math.round((e.opened / e.delivered) * 100) : 0;
  const clickRate = e.delivered > 0 ? Math.round((e.clicked / e.delivered) * 100) : 0;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="SMTP" description="Transactional email delivery provider." icon={Mail} action={<DummyBadge />}>
        <dl className="space-y-2">
          <Row label="Provider">
            <span className="text-sm text-zinc-900 dark:text-zinc-100">{e.provider}</span>
          </Row>
          <Row label="Connection">
            <span className={cn(PILL, e.connected ? TONE.good : TONE.critical)}>
              {e.connected ? "Connected" : "Disconnected"}
            </span>
          </Row>
          <Row label="From">
            <span className="truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{e.fromAddress}</span>
          </Row>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <AuthBadge label="SPF" ok={e.spf} />
          <AuthBadge label="DKIM" ok={e.dkim} />
          <AuthBadge label="DMARC" ok={e.dmarc} />
        </div>
        <button type="button" onClick={demo} className={`${BTN} mt-3 w-full justify-center`}>
          <Send className="h-4 w-4" aria-hidden /> Send test email
        </button>
      </SectionCard>

      <SectionCard title="Deliverability" description="Reputation and last-30-days sending." icon={Send} action={<DummyBadge />}>
        <div className="flex items-center gap-4">
          <HealthGauge score={e.deliverabilityScore} size={96} strokeWidth={8} label="score" />
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Deliverability blends bounce rate, spam complaints and authentication health into a single reputation score.
          </p>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Sent" value={e.sent} tone={healthTone(82)} />
          <StatTile label="Delivered" value={e.delivered} tone={healthTone(95)} />
          <StatTile label="Bounced" value={e.bounced} tone={healthTone(20)} />
          <StatTile label="Open rate" value={openRate} suffix="%" tone={healthTone(78)} />
          <StatTile label="Click rate" value={clickRate} suffix="%" tone={healthTone(78)} />
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Email log"
        description="Most recent transactional and marketing sends."
        icon={Inbox}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">To</th>
                <th className="py-2 pr-4 font-medium">Subject</th>
                <th className="py-2 pr-4 font-medium">Source</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {e.log.map((row, i) => (
                <tr key={`${row.to}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-mono text-[11px]">{row.to}</td>
                  <td className="py-2 pr-4">{row.subject}</td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL, TONE.neutral)}>{row.source}</span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL, STATUS_TONE[row.status], "capitalize")}>{row.status}</span>
                  </td>
                  <td className="py-2 text-zinc-500 dark:text-zinc-400">{row.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
