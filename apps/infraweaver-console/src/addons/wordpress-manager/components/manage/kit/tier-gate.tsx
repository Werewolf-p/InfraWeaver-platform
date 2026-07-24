"use client";

/**
 * `TierGate` — the triple gate made VISIBLE. It never hides a tier-locked feature
 * (locked features are the upsell); instead it renders one of three states inline
 * where the feature would be:
 *
 *  - GRANTED + enabled → the feature (`children`).
 *  - TIER-LOCKED (entitlement absent) → a lock card naming the feature, the
 *    cheapest granting plan ("Included in Pro"), and a "Manage plan" deep-link.
 *  - SWITCHED-OFF (granted but the site's kill switch is off) → a neutral
 *    "Turned off on this site" pill with an optional enable affordance.
 *
 * Truth comes from `useSiteEntitlements` (the one link read) — never from a
 * WordPress self-report. `FeatureChip` is the inline per-row status counterpart
 * (e.g. a "lossless" / "CDN" chip in a media table).
 */

import type { ElementType, JSX, ReactNode } from "react";
import Link from "next/link";
import { Lock, Power, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill, type PillTone } from "../../demo/manage/kit/pill";
import { Spinner } from "../../demo/manage/panel-shell";
import { ENTITLEMENT_FLAG_META, type EntitlementFlag } from "../../../lib/entitlements";
import { lowestTierGranting } from "../../../lib/tiers";
import { useSiteEntitlements } from "../../../lib/manage/use-site-entitlements";

export interface TierGateProps {
  readonly site: string;
  readonly flag: EntitlementFlag;
  readonly children: ReactNode;
  /** Deep-link for "Manage plan" (defaults to the cockpit's plan section). */
  readonly planHref?: string;
  /** Enable a switched-off feature (a signed op); omit to hide the enable button. */
  readonly onEnable?: () => void;
  readonly enabling?: boolean;
}

/** Small pulsing placeholder while the single link read resolves. */
function GateSkeleton(): JSX.Element {
  return (
    <div
      className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-800/40"
      aria-hidden
    />
  );
}

function LockedCard({ flag, planHref }: { flag: EntitlementFlag; planHref: string }): JSX.Element {
  const meta = ENTITLEMENT_FLAG_META[flag];
  const tier = lowestTierGranting(flag);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-400/15 text-amber-600 dark:text-amber-300">
          <Lock className="h-4.5 w-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{meta.label}</h3>
            {tier ? (
              <Pill tone="warn" icon={Sparkles}>
                Included in {tier.displayName}
              </Pill>
            ) : null}
          </div>
          <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">{meta.description}</p>
        </div>
      </div>
      <Link
        href={planHref}
        className="inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-amber-500 bg-amber-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
      >
        <Sparkles className="h-4 w-4" aria-hidden /> Manage plan
      </Link>
    </div>
  );
}

function SwitchedOffCard({
  flag,
  onEnable,
  enabling,
}: {
  flag: EntitlementFlag;
  onEnable?: () => void;
  enabling?: boolean;
}): JSX.Element {
  const meta = ENTITLEMENT_FLAG_META[flag];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-3">
        <Pill tone="neutral" icon={Power}>
          Turned off on this site
        </Pill>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{meta.label}</span>
      </div>
      {onEnable ? (
        <button
          type="button"
          onClick={onEnable}
          disabled={enabling}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {enabling ? <Spinner /> : <Power className="h-4 w-4" aria-hidden />}
          Enable
        </button>
      ) : null}
    </div>
  );
}

export function TierGate({ site, flag, children, planHref, onEnable, enabling }: TierGateProps): ReactNode {
  const ent = useSiteEntitlements(site);
  if (ent.loading) return <GateSkeleton />;
  if (!ent.has(flag)) {
    return <LockedCard flag={flag} planHref={planHref ?? `/wordpress/${encodeURIComponent(site)}?section=plan`} />;
  }
  if (ent.isSwitchedOff(flag)) return <SwitchedOffCard flag={flag} onEnable={onEnable} enabling={enabling} />;
  return <>{children}</>;
}

export interface FeatureChipProps {
  readonly label: ReactNode;
  /** Whether the feature is present/active for this row. */
  readonly active: boolean;
  readonly icon?: ElementType;
  /** Tone when active (default "good") / inactive (default "neutral"). */
  readonly activeTone?: PillTone;
  readonly inactiveTone?: PillTone;
  readonly className?: string;
}

/** Inline per-row feature status (e.g. "lossless", "CDN", "protected"). */
export function FeatureChip({
  label,
  active,
  icon,
  activeTone = "good",
  inactiveTone = "neutral",
  className,
}: FeatureChipProps): JSX.Element {
  return (
    <Pill tone={active ? activeTone : inactiveTone} icon={icon} className={cn(className)}>
      {label}
    </Pill>
  );
}
