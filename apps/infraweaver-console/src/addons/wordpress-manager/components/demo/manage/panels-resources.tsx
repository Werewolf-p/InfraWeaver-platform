"use client";

// Server resources tab for the per-site "Manage" demo console — plan, usage bars, CPU/RAM trends.
import { Activity, ArrowUpCircle, Cpu, Eye, MemoryStick, Server } from "lucide-react";
import { toast } from "@/lib/notify";
import type { SiteManageExt } from "../site-manage-ext-data";
import { SectionCard, Sparkline, StatTile, healthTone } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");

function usageColor(pct: number): string {
  if (pct < 70) return "#10b981";
  if (pct < 90) return "#f59e0b";
  return "#ef4444";
}

function UsageBar({ label, pct }: { label: string; pct: number }) {
  const color = usageColor(pct);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="tabular-nums font-medium text-zinc-900 dark:text-zinc-100">{pct}%</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} aria-hidden />
      </div>
    </div>
  );
}

function PlanFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

export function ResourcesPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const r = ext.resources;
  const cpuNow = r.cpuTrend[r.cpuTrend.length - 1]?.pct ?? 0;
  const ramNow = r.ramTrend[r.ramTrend.length - 1]?.pct ?? 0;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Hosting plan"
        description={r.planName}
        icon={Server}
        action={<DummyBadge />}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <PlanFact label="vCPU" value={`${r.cpuCores}`} />
          <PlanFact label="RAM" value={`${r.ramGb} GB`} />
          <PlanFact label="Disk" value={`${r.diskGb} GB`} />
          <PlanFact label="Bandwidth" value={`${r.bandwidthTb} TB`} />
        </div>
        <button type="button" onClick={demo} className={`${BTN} mt-4`}>
          <ArrowUpCircle className="h-4 w-4" aria-hidden /> Upgrade plan
        </button>
      </SectionCard>

      <SectionCard
        title="Resource usage"
        description="Live utilisation against the plan allowance."
        icon={Cpu}
        action={<DummyBadge />}
      >
        <div className="space-y-3">
          <UsageBar label="CPU" pct={r.cpuPct} />
          <UsageBar label="RAM" pct={r.ramPct} />
          <UsageBar label="Disk" pct={r.diskPct} />
          <UsageBar label="Bandwidth" pct={r.bandwidthPct} />
        </div>
        <p className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300">
          PHP workers:{" "}
          <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
            {r.phpWorkersBusy} / {r.phpWorkersTotal}
          </span>{" "}
          busy
        </p>
      </SectionCard>

      <SectionCard
        title="CPU"
        description="Utilisation over the last 24 hours."
        icon={Activity}
        action={<DummyBadge />}
      >
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{cpuNow}%</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">current</span>
        </div>
        <Sparkline data={r.cpuTrend.map((p) => p.pct)} stroke="#0ea5e9" width={320} height={64} />
      </SectionCard>

      <SectionCard
        title="Memory"
        description="Utilisation over the last 24 hours."
        icon={MemoryStick}
        action={<DummyBadge />}
      >
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{ramNow}%</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">current</span>
        </div>
        <Sparkline data={r.ramTrend.map((p) => p.pct)} stroke="#8b5cf6" width={320} height={64} />
      </SectionCard>

      <div className="lg:col-span-2">
        <StatTile label="Visits this month" value={r.visitsMonth} icon={Eye} tone={healthTone(82)} />
      </div>
    </div>
  );
}
