"use client";

/**
 * The fused Database cockpit — ONE surface where size, reclaimable overhead,
 * autoload bloat, preview-first cleanup by category, automation, and history live
 * together, driving every mutation through the connector's bounded, gated engine
 * over the signed `db.*` methods. It MERGES the signed `db.analyze` read-model
 * over the existing ungated wp-cli probe (the base layer that works on every tier
 * and on old connectors) with graceful degradation: a connector too old for
 * `db.*` shows the read-only probe view plus an "update connector" hint, never a
 * crash; a site below Pro sees the sizes/bloat read-outs while the cleanup +
 * automation zones render the tier upsell (never fake zeros, never dead buttons).
 *
 * There is NO raw `wp db optimize` / purge-all-transients path here — the legacy
 * console actions are retired; the only mutation surface is the capped optimizer.
 */

import { useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { DataPanelData } from "../../../lib/manage/probes/data";
import { PanelError, PanelSkeleton, Spinner } from "../../demo/manage/panel-shell";
import { useManagePanel } from "../../demo/manage/use-manage";
import { useSiteEntitlements } from "../../../lib/manage/use-site-entitlements";
import { TierGate } from "../kit/tier-gate";
import { useDatabaseAnalyze, databaseKeys } from "../../../lib/manage/use-database";
import type { DbTableRow } from "../../../lib/manage/database";
import { OPTIMIZE_CATEGORY_ID, fmtRelative, fmtTs } from "./db-format";
import { DbHealthStrip } from "./db-health-strip";
import { DbCleanupGrid } from "./db-cleanup-grid";
import { DbAutomationCard } from "./db-automation-card";
import { DbBloat } from "./db-bloat";

/** The "update the connector" banner for a link too old for the db.* surface. */
function UpdateConnectorHint(): ReactNode {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
      <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        This site&apos;s connector is too old for the fused Database tools (preview-first cleanup, automation, overhead). The sizes
        below still work — update the connector to unlock the rest.
      </p>
    </div>
  );
}

/** A neutral placeholder for an entitled zone whose signed read-model isn't ready. */
function ZonePending({ message }: { message: string }): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
      <Spinner className="h-4 w-4 animate-spin" /> {message}
    </div>
  );
}

export function DatabaseCockpit({ site }: { site: string }): ReactNode {
  const queryClient = useQueryClient();
  const ent = useSiteEntitlements(site);
  const base = useManagePanel<DataPanelData>(site, "data");
  // Skip the signed call for a site the console knows is not entitled — the base
  // probe + the TierGate upsell carry that case (matches the plan's fetch gating).
  const analyze = useDatabaseAnalyze(site, ent.has("db_optimization"));

  const a = analyze.data;
  const analyzeErr = analyze.error as (Error & { status?: number }) | null;
  const connectorTooOld = analyzeErr?.status === 501;
  const unlocked = !!a && !a.locked;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: databaseKeys.analyze(site) });
    void queryClient.invalidateQueries({ queryKey: ["wordpress-manage-panel", site] });
  }, [queryClient, site]);

  // First paint rides the always-available base probe; the signed layer merges on top.
  if (base.error && !base.data) return <PanelError message={base.error} onRetry={() => base.reload()} />;
  if (!base.data && base.loading) return <PanelSkeleton />;

  const probe = base.data;
  const totalMb = a?.totals?.db_mb ?? probe?.totalMb ?? null;
  const overheadMb = unlocked ? a?.totals?.overhead_mb ?? null : null;
  const autoloadKb = a?.autoload?.kb ?? probe?.autoloadKb ?? null;

  // Tables: prefer the signed analyzer (carries overhead); else the probe (size only).
  const overheadKnown = unlocked && a?.schema_available === true && (a?.tables?.length ?? 0) > 0;
  const tables: DbTableRow[] = overheadKnown
    ? [...(a?.tables ?? [])]
    : (probe?.tables ?? []).map((t) => ({ name: t.name, size_mb: t.sizeMb, overhead_mb: 0 }));

  const allCats = a?.categories ?? [];
  const cleanupCats = allCats.filter((c) => c.id !== OPTIMIZE_CATEGORY_ID);
  const schedule = a?.schedule;
  const nextRunText = schedule?.enabled ? fmtRelative(schedule.next_run) : "Off";
  const nextRunHint = schedule?.enabled ? fmtTs(schedule.next_run) : "Automation is off";

  const analyzePending = ent.has("db_optimization") && analyze.isPending && !connectorTooOld;

  return (
    <div className="space-y-5">
      {connectorTooOld ? <UpdateConnectorHint /> : null}

      <DbHealthStrip
        totalMb={totalMb}
        overheadMb={overheadMb}
        autoloadKb={autoloadKb}
        nextRun={nextRunText}
        nextRunHint={nextRunHint}
      />

      {!connectorTooOld ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <TierGate site={site} flag="db_optimization">
            {unlocked && a ? (
              <DbCleanupGrid site={site} categories={cleanupCats} caps={a.caps} overheadMb={overheadMb} onChanged={invalidate} />
            ) : (
              <ZonePending message={analyzePending ? "Loading cleanup details…" : "Cleanup is turned off on this site."} />
            )}
          </TierGate>

          <TierGate site={site} flag="scheduled_db_cleanup">
            {unlocked && schedule ? (
              <DbAutomationCard site={site} schedule={schedule} categories={cleanupCats} onChanged={invalidate} />
            ) : (
              <ZonePending message={analyzePending ? "Loading automation…" : "Automation is turned off on this site."} />
            )}
          </TierGate>
        </div>
      ) : null}

      <DbBloat
        tables={tables}
        totalMb={totalMb}
        overheadKnown={overheadKnown}
        autoload={unlocked ? a?.autoload ?? null : null}
        history={unlocked ? a?.history ?? [] : []}
      />
    </div>
  );
}
