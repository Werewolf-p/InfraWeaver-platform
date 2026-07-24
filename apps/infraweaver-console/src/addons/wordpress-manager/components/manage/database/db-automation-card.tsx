"use client";

/**
 * Zone 3 — the automation card. Sees and sets each site's scheduled cleanup
 * (on/off, daily/weekly, which categories, next/last run) from the console, over
 * the signed `db.schedule` command — the SAME stored settings + WP-Cron
 * reconciliation WP-admin uses, so the two surfaces never drift. Scheduled runs
 * stay destructive-with-cap (the same bounded engine); the always-on cleanup
 * preview in Zone 2 is their standing dry-run visibility.
 */

import { useState, type ReactNode } from "react";
import { CalendarClock } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Spinner } from "../../demo/manage/panel-shell";
import { BTN_PRIMARY } from "../../demo/manage/manage-ui";
import { Pill } from "../../demo/manage/kit/pill";
import { scheduleDatabase } from "../../../lib/manage/use-database";
import {
  SCHEDULE_FREQUENCIES,
  type DbCategoryCount,
  type DbSchedule,
  type ScheduleFrequency,
} from "../../../lib/manage/database";
import { fmtRelative, fmtTs } from "./db-format";

export interface DbAutomationCardProps {
  readonly site: string;
  readonly schedule: DbSchedule;
  /** All cleanup categories (id + label) for the subset selection. */
  readonly categories: readonly DbCategoryCount[];
  readonly onChanged: () => void;
}

function clampFrequency(freq: string): ScheduleFrequency {
  return (SCHEDULE_FREQUENCIES as readonly string[]).includes(freq) ? (freq as ScheduleFrequency) : "daily";
}

export function DbAutomationCard({ site, schedule, categories, onChanged }: DbAutomationCardProps): ReactNode {
  const [enabled, setEnabled] = useState<boolean>(schedule.enabled);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(clampFrequency(schedule.frequency));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(schedule.categories));
  const [saving, setSaving] = useState(false);

  function toggleCat(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const res = await scheduleDatabase(site, {
        enabled,
        frequency,
        // Empty subset = "all" (the connector sanitizes and reconciles WP-Cron).
        ...(selected.size > 0 ? { categories: [...selected] } : {}),
      });
      if (res.ok === false) {
        toast.error(`Schedule refused (${res.reason ?? "unavailable"})`);
        return;
      }
      toast.success(enabled ? `Automated cleanup saved — runs ${frequency}.` : "Automated cleanup turned off.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the schedule");
    } finally {
      setSaving(false);
    }
  }

  const last = schedule.last_run;
  return (
    <SectionCard
      title="Automation"
      description="Run the bounded cleanup on a schedule. Each run stays capped and never drops tables."
      icon={CalendarClock}
      action={
        <Pill tone={schedule.enabled ? "good" : "neutral"}>{schedule.enabled ? `On · ${schedule.frequency}` : "Off"}</Pill>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Next run</dt>
          <dd className="tabular-nums text-zinc-800 dark:text-zinc-200" title={fmtTs(schedule.next_run)}>
            {schedule.enabled ? fmtRelative(schedule.next_run) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500 dark:text-zinc-400">Last run</dt>
          <dd className="text-zinc-800 dark:text-zinc-200" title={fmtTs(last?.at ?? null)}>
            {last && last.at > 0 ? (last.ok ? `Removed ${last.total.toLocaleString()} rows` : `Refused (${last.reason || "unknown"})`) : "Never"}
          </dd>
        </div>
      </dl>

      <div className="space-y-3">
        <label className="flex items-center gap-2.5 text-sm text-zinc-800 dark:text-zinc-200">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500 dark:border-zinc-600"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={saving}
          />
          Enable scheduled cleanup
        </label>

        <div className="flex items-center gap-2">
          <label htmlFor="db-frequency" className="text-sm text-zinc-600 dark:text-zinc-400">
            Cadence
          </label>
          <select
            id="db-frequency"
            value={frequency}
            onChange={(e) => setFrequency(clampFrequency(e.target.value))}
            disabled={saving || !enabled}
            className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-100"
          >
            {SCHEDULE_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f === "daily" ? "Daily" : "Weekly"}
              </option>
            ))}
          </select>
        </div>

        <fieldset disabled={saving || !enabled} className="disabled:opacity-50">
          <legend className="text-xs text-zinc-500 dark:text-zinc-400">Categories (none selected = all)</legend>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {categories.map((cat) => (
              <label key={cat.id} className="flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-sky-600 focus:ring-sky-500 dark:border-zinc-600"
                  checked={selected.has(cat.id)}
                  onChange={() => toggleCat(cat.id)}
                />
                {cat.label}
              </label>
            ))}
          </div>
        </fieldset>

        <button type="button" className={BTN_PRIMARY} disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner /> : <CalendarClock className="h-4 w-4" aria-hidden />} Save schedule
        </button>
      </div>
    </SectionCard>
  );
}
