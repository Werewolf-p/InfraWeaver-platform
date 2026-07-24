"use client";

// Server Resources panel — the site's pods (from Kubernetes) plus live in-container
// runtime facts (PHP memory limit, CPU count, RAM and content-disk usage).
import { Cpu, HardDrive, MemoryStick, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResourcesData } from "../../../lib/manage/probes/resources";
import type { SitePod } from "../../../lib/site-pods";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { ConfigEditorCard } from "../../manage/content-branding/config-editor-card";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE_GOOD = "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
const TONE_WARN = "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
const TONE_NEUTRAL =
  "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";

function usageColor(pct: number): string {
  if (pct < 70) return "#10b981";
  if (pct < 90) return "#f59e0b";
  return "#ef4444";
}

function UsageBar({ label, usedMb, totalMb }: { label: string; usedMb: number; totalMb: number }) {
  const pct = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
          {usedMb} / {totalMb} MB <span className="text-zinc-500">({pct}%)</span>
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: usageColor(pct) }} aria-hidden />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

function podTone(pod: SitePod): string {
  if (!pod.ready) return TONE_WARN;
  return pod.restarts > 0 ? TONE_NEUTRAL : TONE_GOOD;
}

export function ResourcesPanel({ site }: { site: string }) {
  const state = useManagePanel<ResourcesData>(site, "resources");

  return (
    <PanelState state={state}>
      {(data) => {
        const { runtime, pods } = data;
        const totalRestarts = pods.reduce((sum, p) => sum + p.restarts, 0);
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
              <StatTile
                label="vCPU (visible)"
                value={runtime.cpuCount ?? 0}
                icon={Cpu}
                tone={healthTone(runtime.cpuCount ? 82 : 0)}
              />
              <StatTile label="Pods" value={pods.length} icon={Server} tone={healthTone(pods.length > 0 ? 90 : 0)} />
              <StatTile
                label="Container restarts"
                value={totalRestarts}
                icon={Server}
                tone={healthTone(totalRestarts === 0 ? 96 : totalRestarts < 5 ? 60 : 30)}
              />
            </div>

            <SectionCard title="Runtime" description={`In-container limits reported for ${site}.`} icon={Cpu}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="PHP memory" value={runtime.phpMemoryLimit ?? "—"} />
                <Fact label="CPU cores" value={runtime.cpuCount !== null ? `${runtime.cpuCount}` : "—"} />
                <Fact
                  label="RAM total"
                  value={runtime.memTotalMb !== null ? `${runtime.memTotalMb} MB` : "—"}
                />
                <Fact
                  label="Disk total"
                  value={runtime.diskTotalMb !== null ? `${runtime.diskTotalMb} MB` : "—"}
                />
              </div>
            </SectionCard>

            <SectionCard title="Usage" description="Live utilisation reported inside the container." icon={MemoryStick}>
              <div className="space-y-4">
                {runtime.memTotalMb !== null && runtime.memUsedMb !== null ? (
                  <UsageBar label="Memory" usedMb={runtime.memUsedMb} totalMb={runtime.memTotalMb} />
                ) : (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Memory usage is not reported by this container.</p>
                )}
                {runtime.diskTotalMb !== null && runtime.diskUsedMb !== null ? (
                  <div className="flex items-start gap-2">
                    <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                    <div className="flex-1">
                      <UsageBar label="Content disk (wp-content)" usedMb={runtime.diskUsedMb} totalMb={runtime.diskTotalMb} />
                    </div>
                  </div>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard
              className="lg:col-span-2"
              title="Pods"
              description="Workloads backing this site, discovered from Kubernetes."
              icon={Server}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-4 font-medium">Pod</th>
                      <th className="py-2 pr-4 font-medium">Component</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 text-right font-medium">Restarts</th>
                      <th className="py-2 font-medium">Started</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {pods.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                          No pods found for this site.
                        </td>
                      </tr>
                    ) : (
                      pods.map((pod) => (
                        <tr key={pod.name} className="text-zinc-700 dark:text-zinc-300">
                          <td className="py-2 pr-4 font-mono text-[11px]">{pod.name}</td>
                          <td className="py-2 pr-4 capitalize">{pod.component}</td>
                          <td className="py-2 pr-4">
                            <span className={cn(PILL, podTone(pod))}>{pod.status}</span>
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums">{pod.restarts}</td>
                          <td className="py-2 text-zinc-500 dark:text-zinc-400">
                            {pod.startedAt ? new Date(pod.startedAt).toLocaleString() : "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <ConfigEditorCard site={site} />
          </div>
        );
      }}
    </PanelState>
  );
}
