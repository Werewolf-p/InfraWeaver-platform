"use client";

// Forms & Leads tab for the per-site "Manage" demo console — entries, conversion, submissions.
import { Download, Inbox, Mail, ShieldAlert, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageExt } from "../site-manage-ext-data";
import { SectionCard, StatTile } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const ROW_BTN =
  "inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");

export function FormsPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { forms } = ext;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
        <StatTile label="Total entries (30d)" value={forms.totalEntries} icon={Inbox} />
        <StatTile label="Spam blocked (30d)" value={forms.spamBlocked} icon={ShieldAlert} />
      </div>

      <SectionCard title="Forms" description="Active forms and their 30-day performance." icon={Inbox} action={<DummyBadge />}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Form</th>
                <th className="py-2 pr-4 text-right font-medium">Entries (30d)</th>
                <th className="py-2 text-right font-medium">Conversion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {forms.forms.map((f) => (
                <tr key={f.name} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{f.name}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{f.entries30d.toLocaleString("en-US")}</td>
                  <td className="py-2 text-right tabular-nums">{f.conversion}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Recent submissions"
        description="Latest entries across all forms."
        icon={Mail}
        action={
          <div className="flex items-center gap-2">
            <button type="button" onClick={demo} className={BTN}>
              <Download className="h-4 w-4" aria-hidden /> Export CSV
            </button>
            <DummyBadge />
          </div>
        }
      >
        {forms.recentEntries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No submissions yet. New entries appear here as visitors complete your forms.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Form</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {forms.recentEntries.map((e) => (
                  <tr key={e.id} className="text-zinc-700 dark:text-zinc-300">
                    <td className="py-2 pr-4">
                      <span className={cn(PILL, TONE.neutral)}>{e.form}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">{e.name}</span>
                        {e.spam ? <span className={cn(PILL, TONE.critical)}>Spam</span> : null}
                      </span>
                    </td>
                    <td className="max-w-[180px] truncate py-2 pr-4 font-mono text-[11px]">{e.email}</td>
                    <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">{e.when}</td>
                    <td className="py-2 text-right">
                      <button type="button" onClick={demo} className={ROW_BTN}>
                        <Trash2 className="h-3 w-3" aria-hidden /> Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
