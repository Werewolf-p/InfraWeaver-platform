"use client";

// Uptime & Incidents panel — powered by the signed Connector link only. There is
// no stored time-series, so this shows current + last-known signals honestly:
// liveness, last signed health-check round-trip, connector version, quarantine
// state, rejections, last key reroll, and a timeline of the known events.
import { Activity, GitBranch, KeyRound, ShieldCheck, Timer, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LinkState, UptimeData, UptimeEvent } from "../../../lib/manage/probes/uptime";
import { SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

const STATE_TONE: Readonly<Record<LinkState, { cls: string; label: string }>> = {
  active: { cls: TONE.good, label: "Active" },
  pending: { cls: TONE.warn, label: "Pending" },
  quarantined: { cls: TONE.critical, label: "Quarantined" },
};

function fmt(at: string | null): string {
  if (!at) return "—";
  const t = Date.parse(at);
  return Number.isNaN(t) ? at : new Date(t).toLocaleString();
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={cn("mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100", mono && "font-mono text-[13px]")}>
        {value}
      </p>
    </div>
  );
}

function TimelineRow({ event }: { event: UptimeEvent }) {
  const dot =
    event.ok === undefined ? "bg-sky-500" : event.ok ? "bg-emerald-500" : "bg-red-500";
  return (
    <li className="flex items-start gap-3">
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{event.label}</p>
        {event.detail ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{event.detail}</p> : null}
      </div>
      <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{fmt(event.at)}</span>
    </li>
  );
}

export function UptimePanel({ site }: { site: string }) {
  const state = useManagePanel<UptimeData>(site, "uptime");

  return (
    <PanelState state={state}>
      {(data) => {
        const stateTone = STATE_TONE[data.state];
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Liveness" description={`Signed link status for ${site}.`} icon={Activity}>
              <div className="flex items-center justify-between">
                <span className={cn(PILL, data.live ? TONE.good : TONE.critical)}>
                  {data.live ? "Up" : "Not confirmed up"}
                </span>
                <span className={cn(PILL, stateTone.cls)}>{stateTone.label}</span>
              </div>
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
                <p className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {data.roundtripMs !== null ? `${data.roundtripMs}` : "—"}
                  {data.roundtripMs !== null ? <span className="ml-1 text-base font-normal text-zinc-500">ms</span> : null}
                </p>
                <p className="mt-1 flex items-center justify-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <Timer className="h-3.5 w-3.5" aria-hidden /> last health-check round-trip
                </p>
              </div>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                Last signed check: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmt(data.lastCheckAt)}</span>
                {data.lastCheckOk === null ? null : (
                  <span className={cn("ml-2", PILL, data.lastCheckOk ? TONE.good : TONE.critical)}>
                    {data.lastCheckOk ? "passed" : "failed"}
                  </span>
                )}
              </p>
            </SectionCard>

            <SectionCard title="Connector" description="Identity and version of the signed channel." icon={ShieldCheck}>
              <div className="grid grid-cols-2 gap-3">
                <Fact label="Connector version" value={data.connectorVersion ?? "—"} mono />
                <Fact label="Signature set" value={data.iwAlg ?? "—"} mono />
                <Fact label="Key epoch (kid)" value={`${data.kid}`} />
                <Fact label="Rejections" value={`${data.rejections}`} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={cn(PILL, data.fingerprintConfirmed ? TONE.good : TONE.warn)}>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden />
                  {data.fingerprintConfirmed ? "Fingerprint confirmed" : "Fingerprint unconfirmed"}
                </span>
                {data.rejections > 0 ? (
                  <span className={cn(PILL, TONE.warn)}>
                    <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {data.rejections} rejected
                  </span>
                ) : null}
              </div>
              {data.lastReroll ? (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <GitBranch className="h-3.5 w-3.5" aria-hidden />
                  Last key reroll: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmt(data.lastReroll.at)}</span>
                  <span className={cn(PILL, data.lastReroll.outcome === "confirmed" ? TONE.good : TONE.neutral)}>
                    epoch {data.lastReroll.kid} · {data.lastReroll.outcome}
                  </span>
                </p>
              ) : null}
            </SectionCard>

            <SectionCard
              className="lg:col-span-2"
              title="Signal timeline"
              description="The events this signed link actually records — no synthetic history."
              icon={Activity}
            >
              {data.timeline.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  No recorded events yet.
                </div>
              ) : (
                <ul className="space-y-3">
                  {data.timeline.map((event) => (
                    <TimelineRow key={event.kind} event={event} />
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
