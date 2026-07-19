"use client";

// Forms & Leads panel — the detected forms plugin and the forms it exposes over the
// read-only wp-cli path. Submission entries live outside that channel, so the panel
// says so honestly instead of showing fabricated lead counts. Read-only: no actions.

import { Inbox, Info, Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FormsData } from "../../../lib/manage/probes/forms";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const PILL_NEUTRAL = "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";

export function FormsPanel({ site }: { site: string }) {
  const state = useManagePanel<FormsData>(site, "forms");

  return (
    <PanelState state={state}>
      {(data) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
            <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
              <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
                  <Puzzle className="h-3.5 w-3.5" aria-hidden />
                </span>
                Detected plugin
              </span>
              <p className="mt-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{data.plugin}</p>
            </div>
            {data.formCount === null ? (
              <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  <span className="grid h-6 w-6 place-items-center rounded-md bg-zinc-500/10 text-zinc-500 dark:text-zinc-400">
                    <Inbox className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  Forms
                </span>
                <p className="mt-3 text-2xl font-semibold text-zinc-400 dark:text-zinc-500">—</p>
              </div>
            ) : (
              <StatTile label="Forms" value={data.formCount} icon={Inbox} tone={healthTone(80)} />
            )}
          </div>

          <SectionCard
            className="lg:col-span-2"
            title="Forms"
            description="Forms registered by the active plugin."
            icon={Inbox}
          >
            {data.forms.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                {data.formCount === null
                  ? "This plugin's forms aren't enumerable over the read-only channel."
                  : "No forms have been created yet."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-4 font-medium">Form</th>
                      <th className="py-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.forms.map((form, i) => (
                      <tr key={`${form.title}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                        <td className="py-2 pr-4">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{form.title}</span>
                        </td>
                        <td className="py-2 text-zinc-500 dark:text-zinc-400">{form.date ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <div className="lg:col-span-2">
            <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm text-zinc-700 dark:text-zinc-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">About submission entries</p>
                <p className="mt-0.5 text-zinc-700 dark:text-zinc-300">{data.note}</p>
                {data.slug ? (
                  <span className={cn("mt-2 inline-flex", PILL, PILL_NEUTRAL)}>slug: {data.slug}</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </PanelState>
  );
}
