"use client";

// Security tab for the per-site "Manage" demo console — malware, WAF, SSL, hardening, logins.
import {
  AlertTriangle,
  CheckCircle2,
  Flame,
  KeyRound,
  Lock,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { CheckState, SiteManageData } from "../site-manage-data";
import { SectionCard } from "../widgets";
import { MalwareDonut, WafAreaChart } from "../charts";
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

const CHECK_ICON: Readonly<Record<CheckState, { Icon: React.ElementType; cls: string }>> = {
  good: { Icon: CheckCircle2, cls: "text-emerald-500" },
  recommended: { Icon: AlertTriangle, cls: "text-amber-500" },
  critical: { Icon: XCircle, cls: "text-red-500" },
};

export function SecurityPanel({ data }: { data: SiteManageData; site: string }) {
  const { malware, ssl, hardening, loginAttempts, wafTrend } = data;
  const hardened = hardening.filter((h) => h.state === "good").length;
  const gradeTone = ssl.grade === "B" ? TONE.warn : TONE.good;
  const expTone = ssl.expiresDays < 14 ? TONE.critical : ssl.expiresDays < 30 ? TONE.warn : TONE.good;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="Malware scan" description="Last full-site signature sweep." icon={ShieldCheck} action={<DummyBadge />}>
        <MalwareDonut clean={malware.clean} flagged={malware.flagged} />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">Last scan {malware.lastScan}</span>
          <span className={cn(PILL, malware.flagged > 0 ? TONE.critical : TONE.good)}>
            {malware.flagged > 0 ? `${malware.flagged} flagged` : "Clean"}
          </span>
        </div>
        <button type="button" onClick={demo} className={cn(BTN, "mt-3 w-full justify-center")}>
          <ShieldCheck className="h-4 w-4" aria-hidden /> Run scan now
        </button>
      </SectionCard>

      <SectionCard title="Firewall activity" description="Requests blocked over the last 24 hours." icon={Flame} action={<DummyBadge />}>
        <WafAreaChart data={wafTrend} />
      </SectionCard>

      <SectionCard title="SSL / TLS" description="Certificate and transport security." icon={Lock} action={<DummyBadge />}>
        <dl className="space-y-2">
          <Row label="Issuer">
            <span className="text-sm text-zinc-900 dark:text-zinc-100">{ssl.issuer}</span>
          </Row>
          <Row label="Protocol">
            <span className={cn(PILL, TONE.neutral)}>{ssl.protocol}</span>
          </Row>
          <Row label="Grade">
            <span className={cn(PILL, gradeTone)}>{ssl.grade}</span>
          </Row>
          <Row label="Expires in">
            <span className={cn(PILL, expTone)}>{ssl.expiresDays} days</span>
          </Row>
          <Row label="Auto-renew">
            <span className={cn(PILL, ssl.autoRenew ? TONE.good : TONE.neutral)}>{ssl.autoRenew ? "On" : "Off"}</span>
          </Row>
        </dl>
        <button type="button" onClick={demo} className={cn(BTN, "mt-3 w-full justify-center")}>
          <Lock className="h-4 w-4" aria-hidden /> Renew now
        </button>
      </SectionCard>

      <SectionCard
        title="Hardening checklist"
        description={`${hardened} of ${hardening.length} hardened`}
        icon={ShieldAlert}
        action={<DummyBadge />}
      >
        <ul className="space-y-2">
          {hardening.map((h) => {
            const { Icon, cls } = CHECK_ICON[h.state];
            return (
              <li
                key={h.id}
                className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
              >
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", cls)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{h.label}</p>
                  <p className="text-xs text-zinc-500">{h.detail}</p>
                </div>
                {h.state !== "good" ? (
                  <button
                    type="button"
                    onClick={demo}
                    className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    Fix
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Blocked login attempts"
        description="Brute-force and credential-stuffing sources."
        icon={KeyRound}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">IP</th>
                <th className="py-2 pr-4 font-medium">Country</th>
                <th className="py-2 pr-4 font-medium">User</th>
                <th className="py-2 pr-4 text-right font-medium">Attempts</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {loginAttempts.map((a, i) => (
                <tr key={`${a.ip}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-mono text-[11px]">{a.ip}</td>
                  <td className="py-2 pr-4">{a.country}</td>
                  <td className="py-2 pr-4 font-mono text-[11px]">{a.user}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{a.attempts}</td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL, a.blocked ? TONE.critical : TONE.warn)}>
                      {a.blocked ? "Blocked" : "Watched"}
                    </span>
                  </td>
                  <td className="py-2 text-zinc-500 dark:text-zinc-400">{a.when}</td>
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
    <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950/40">
      <dt className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
