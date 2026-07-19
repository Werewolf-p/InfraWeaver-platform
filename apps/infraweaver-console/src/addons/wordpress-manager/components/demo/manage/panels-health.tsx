"use client";

// Site health, environment, WP-Cron, activity log & white-label report (demo).
import type { ElementType } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  CalendarClock,
  CheckCircle2,
  Download,
  FileBarChart,
  FileText,
  Gauge,
  HeartPulse,
  KeyRound,
  Mail,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { CheckState, SiteManageData } from "../site-manage-data";
import { ProgressRing, SectionCard, StatTile, healthTone } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 dark:text-white";
const DEMO_MSG = "Demo — no changes are made to the live site.";

const STATE_ICON: Readonly<Record<CheckState, { icon: ElementType; className: string }>> = {
  good: { icon: CheckCircle2, className: "text-emerald-500" },
  recommended: { icon: AlertTriangle, className: "text-amber-500" },
  critical: { icon: XCircle, className: "text-red-500" },
};

type ActivityKind = "update" | "backup" | "security" | "login" | "content" | "config";
const KIND_ICON: Readonly<Record<ActivityKind, { icon: ElementType; className: string }>> = {
  update: { icon: RefreshCw, className: "text-sky-500" },
  backup: { icon: Archive, className: "text-violet-500" },
  security: { icon: ShieldCheck, className: "text-red-500" },
  login: { icon: KeyRound, className: "text-amber-500" },
  content: { icon: FileText, className: "text-emerald-500" },
  config: { icon: Settings, className: "text-zinc-500" },
};

export function HealthPanel({ data }: { data: SiteManageData; site: string }) {
  const good = data.siteHealth.filter((c) => c.state === "good").length;
  const recommended = data.siteHealth.filter((c) => c.state === "recommended").length;
  const critical = data.siteHealth.filter((c) => c.state === "critical").length;

  const envRows: ReadonlyArray<{ label: string; value: string }> = [
    { label: "WordPress", value: data.env.wp },
    { label: "PHP", value: data.env.php },
    { label: "Database", value: data.env.mysql },
    { label: "Web server", value: data.env.server },
    { label: "Memory limit", value: data.env.memoryLimit },
    { label: "Max upload", value: data.env.maxUpload },
    { label: "Object cache", value: data.env.objectCache },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Site Health"
        description={`${good} good · ${recommended} recommended · ${critical} critical`}
        icon={HeartPulse}
        action={<DummyBadge />}
        className="lg:col-span-2"
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.siteHealth.map((check) => {
            const { icon: Icon, className } = STATE_ICON[check.state];
            return (
              <li key={check.id} className={cn(TILE, "flex items-start gap-3")}>
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", className)} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{check.label}</p>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{check.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Environment" description="Server and runtime configuration." icon={Server} action={<DummyBadge />} className="lg:col-span-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {envRows.map((row) => (
            <div key={row.label} className={cn(TILE, "flex items-center justify-between gap-3")}>
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{row.label}</span>
              <span className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">{row.value}</span>
            </div>
          ))}
          <div className={cn(TILE, "flex items-center justify-between gap-3")}>
            <div className="min-w-0">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Disk used</span>
              <p className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">{data.env.diskUsedPct}%</p>
            </div>
            <ProgressRing value={data.env.diskUsedPct} tone={healthTone(100 - data.env.diskUsedPct)} />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Scheduled events" description="WP-Cron hooks and their next run." icon={CalendarClock} action={<DummyBadge />}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 font-medium">Hook</th>
                <th className="py-2 font-medium">Schedule</th>
                <th className="py-2 text-right font-medium">Next run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {data.cron.map((event) => (
                <tr key={event.hook}>
                  <td className="py-2 pr-3">
                    <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{event.hook}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="inline-flex items-center rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
                      {event.schedule}
                    </span>
                  </td>
                  <td className="py-2 text-right text-zinc-500 dark:text-zinc-400">{event.nextRun}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Activity log" description="Recent automated and operator actions." icon={Activity} action={<DummyBadge />}>
        <ul className="space-y-3">
          {data.activity.map((item) => {
            const { icon: Icon, className } = KIND_ICON[item.kind];
            return (
              <li key={item.id} className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40",
                    className,
                  )}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.actor}</span> {item.action}
                  </p>
                  <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{item.target}</p>
                </div>
                <span className="shrink-0 text-xs text-zinc-500">{item.when}</span>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Monthly report" description="White-label client summary." icon={FileBarChart} action={<DummyBadge />} className="lg:col-span-2">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{data.report.period}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN} onClick={() => toast.info(DEMO_MSG)}>
              <Download className="h-4 w-4" aria-hidden /> Download PDF
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={() => toast.info(DEMO_MSG)}>
              <Mail className="h-4 w-4" aria-hidden /> Email to client
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Visitors" value={data.report.visitors} icon={Users} />
          <StatTile label="Uptime" value={data.report.uptime} decimals={2} suffix="%" icon={Gauge} tone={healthTone(data.report.uptime > 99.9 ? 96 : 70)} />
          <StatTile label="Updates applied" value={data.report.updatesApplied} icon={RefreshCw} />
          <StatTile label="Threats blocked" value={data.report.threatsBlocked} icon={ShieldCheck} />
          <StatTile label="Backups taken" value={data.report.backupsTaken} icon={Archive} />
          <StatTile label="Avg performance" value={data.report.avgPerformance} icon={Activity} tone={healthTone(data.report.avgPerformance)} />
        </div>
      </SectionCard>
    </div>
  );
}
