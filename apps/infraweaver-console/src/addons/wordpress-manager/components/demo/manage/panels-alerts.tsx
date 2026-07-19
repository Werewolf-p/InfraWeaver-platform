"use client";

// Notifications & alerts tab for the per-site "Manage" demo console.
import { useState, type ReactNode } from "react";
import { BellRing, Hash, History, Mail, Plus, SlidersHorizontal, Smartphone, Webhook } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { AlertChannel, AlertRule, SiteManageExt } from "../site-manage-ext-data";
import { SectionCard } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const DEMO_MSG = "Demo — no changes are made to the live site.";
const demo = () => toast.info(DEMO_MSG);

type Severity = AlertRule["severity"];
type PillTone = "good" | "orange" | "warn" | "critical" | "neutral";
const PILL_TONE: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  orange: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", PILL_TONE[tone])}>
      {children}
    </span>
  );
}

const SEVERITY_TONE: Readonly<Record<Severity, PillTone>> = {
  critical: "critical",
  high: "orange",
  medium: "warn",
  low: "neutral",
};
const SEVERITY_DOT: Readonly<Record<Severity, string>> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-zinc-400",
};
const CHANNEL_ICON: Readonly<Record<AlertChannel["kind"], typeof Mail>> = {
  email: Mail,
  slack: Hash,
  sms: Smartphone,
  webhook: Webhook,
};

function ToggleChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        on ? PILL_TONE.good : PILL_TONE.neutral,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-emerald-500" : "bg-zinc-400")} aria-hidden />
      {on ? "On" : "Off"}
    </button>
  );
}

function seedToggles(items: readonly { enabled: boolean }[]): Record<number, boolean> {
  return Object.fromEntries(items.map((it, i) => [i, it.enabled]));
}

export function AlertsPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { channels, rules, recent } = ext.alerts;
  const [chanOn, setChanOn] = useState<Record<number, boolean>>(() => seedToggles(channels));
  const [ruleOn, setRuleOn] = useState<Record<number, boolean>>(() => seedToggles(rules));

  const toggleChan = (i: number) => {
    setChanOn((prev) => ({ ...prev, [i]: !prev[i] }));
    demo();
  };
  const toggleRule = (i: number) => {
    setRuleOn((prev) => ({ ...prev, [i]: !prev[i] }));
    demo();
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Notification channels"
        description="Where alerts are delivered."
        icon={BellRing}
        action={
          <div className="flex items-center gap-2">
            <button type="button" className={cn(BTN, "px-2.5 py-1 text-xs")} onClick={demo}>
              <Plus className="h-3.5 w-3.5" aria-hidden /> Add channel
            </button>
            <DummyBadge />
          </div>
        }
      >
        <ul className="space-y-2">
          {channels.map((ch, i) => {
            const Icon = CHANNEL_ICON[ch.kind];
            return (
              <li key={ch.kind + ch.target} className={cn(TILE, "flex items-center gap-3")}>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-400">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{ch.kind}</p>
                  <p className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{ch.target}</p>
                </div>
                <ToggleChip on={!!chanOn[i]} onToggle={() => toggleChan(i)} />
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2 lg:order-last"
        title="Alert rules"
        description="Events that trigger a notification."
        icon={SlidersHorizontal}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Event</th>
                <th className="py-2 pr-4 font-medium">Severity</th>
                <th className="py-2 pr-4 font-medium">Channel</th>
                <th className="py-2 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rules.map((rule, i) => (
                <tr key={rule.event} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{rule.event}</td>
                  <td className="py-2 pr-4">
                    <Pill tone={SEVERITY_TONE[rule.severity]}>{rule.severity}</Pill>
                  </td>
                  <td className="py-2 pr-4 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{rule.channel}</td>
                  <td className="py-2">
                    <ToggleChip on={!!ruleOn[i]} onToggle={() => toggleRule(i)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Recent alerts" description="Latest notifications sent." icon={History} action={<DummyBadge />}>
        <ul className="space-y-2">
          {recent.map((a, i) => (
            <li key={a.event + i} className={cn(TILE, "flex items-center gap-3")}>
              <span className={cn("h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[a.severity])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{a.event}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{a.channel}</p>
              </div>
              <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{a.when}</span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
