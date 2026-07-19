"use client";

// Clients & care-plans tab for the per-site "Manage" demo console.
import type { ReactNode } from "react";
import { Briefcase, CheckCircle2, Circle, ClipboardCheck, Download, ExternalLink, Receipt, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageExt } from "../site-manage-ext-data";
import { SectionCard } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const DEMO_MSG = "Demo — no changes are made to the live site.";
const demo = () => toast.info(DEMO_MSG);
const fmt = (n: number) => n.toLocaleString("en-US");

type PillTone = "good" | "info" | "warn" | "critical" | "neutral" | "violet";
const PILL_TONE: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
};
function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", PILL_TONE[tone])}>
      {children}
    </span>
  );
}

export function ClientsPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const c = ext.clients;
  const tasksDone = c.careTasks.filter((t) => t.done).length;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="Client" description="White-label care-plan relationship." icon={Briefcase} action={<DummyBadge />}>
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-sky-500/15 text-sm font-bold text-sky-600 dark:text-sky-400">
            {c.brandInitials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{c.clientName}</span>
              <Pill tone="violet">{c.plan}</Pill>
              {c.whiteLabelBranded ? <Pill tone="good">White-label branded</Pill> : <Pill tone="neutral">Unbranded</Pill>}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
              <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                €{fmt(c.mrr)}
                <span className="font-normal text-zinc-500 dark:text-zinc-400">/mo</span>
              </span>
              <span>client since {c.since}</span>
              <span className="tabular-nums">{c.sitesManaged} sites managed</span>
            </div>
          </div>
        </div>
        <div className={cn(TILE, "mt-4 flex flex-wrap items-center justify-between gap-3")}>
          <span className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{c.portalUrl}</span>
          <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={demo}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open client portal
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Care-plan tasks"
        description={`${tasksDone} of ${c.careTasks.length} complete this cycle`}
        icon={ClipboardCheck}
        action={<DummyBadge />}
      >
        <ul className="space-y-2">
          {c.careTasks.map((t) => (
            <li key={t.label} className={cn(TILE, "flex items-center gap-3")}>
              {t.done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{t.label}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">last: {t.lastDone}</p>
              </div>
              <Pill tone="neutral">{t.cadence}</Pill>
              {!t.done ? (
                <button
                  type="button"
                  className={cn(BTN, "shrink-0 px-2.5 py-1 text-xs")}
                  onClick={() => toast.success("Marked done — demo only, no changes are made to the live site.")}
                >
                  Mark done
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Invoices"
        description="Care-plan billing history."
        icon={Receipt}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={demo}>
              <Send className="h-3.5 w-3.5" aria-hidden /> Send invoice
            </button>
            <DummyBadge />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Invoice</th>
                <th className="py-2 pr-4 font-medium">Period</th>
                <th className="py-2 pr-4 text-right font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {c.invoices.map((inv) => (
                <tr key={inv.id} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-mono text-[11px]">{inv.id}</td>
                  <td className="py-2 pr-4">{inv.period}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">€{fmt(inv.amount)}</td>
                  <td className="py-2 pr-4">
                    {inv.status === "paid" ? <Pill tone="good">paid</Pill> : <Pill tone="warn">due</Pill>}
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={demo}>
                      <Download className="h-3.5 w-3.5" aria-hidden /> Download PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
