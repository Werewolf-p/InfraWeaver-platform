"use client";

/**
 * Zone 1 — the health strip. Total size, Reclaimable overhead, Autoload weight,
 * and Next automated run in one row. Overhead + next-run are the fusion move:
 * optimization value and automation state are visible before any click. Numeric
 * tiles reuse the Manage `StatTile`; the next-run tile carries text, so it mirrors
 * the StatTile shell by hand.
 */

import type { ElementType, JSX, ReactNode } from "react";
import { CalendarClock, Database, Layers, Recycle } from "lucide-react";
import { StatTile, healthTone } from "../../demo/widgets";
import { AUTOLOAD_WARN_KB } from "../../../lib/manage/database";

/** A text-valued tile that mirrors StatTile's frame (StatTile only renders numbers). */
function TextTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ElementType;
}): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60" title={hint}>
      <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        {label}
      </span>
      <div className="mt-3 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
    </div>
  );
}

export interface DbHealthStripProps {
  readonly totalMb: number | null;
  readonly overheadMb: number | null;
  readonly autoloadKb: number | null;
  readonly nextRun: string;
  readonly nextRunHint?: string;
}

export function DbHealthStrip({ totalMb, overheadMb, autoloadKb, nextRun, nextRunHint }: DbHealthStripProps): ReactNode {
  const autoloadHigh = autoloadKb !== null && autoloadKb > AUTOLOAD_WARN_KB;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div title="Total size of this site's database on disk">
        <StatTile label="Total size" value={totalMb ?? 0} decimals={1} suffix=" MB" icon={Database} />
      </div>
      <div title="Reclaimable overhead (DATA_FREE) — free it with Safe optimize">
        <StatTile
          label="Reclaimable"
          value={overheadMb ?? 0}
          decimals={1}
          suffix=" MB"
          icon={Recycle}
          tone={healthTone((overheadMb ?? 0) > 20 ? 60 : 90)}
        />
      </div>
      <div title="Autoload weight — options WordPress loads on every request">
        <StatTile
          label="Slow-load weight"
          value={autoloadKb ?? 0}
          decimals={1}
          suffix=" KB"
          icon={Layers}
          tone={healthTone(autoloadHigh ? 55 : 92)}
        />
      </div>
      <TextTile label="Next automated run" value={nextRun} hint={nextRunHint} icon={CalendarClock} />
    </div>
  );
}
