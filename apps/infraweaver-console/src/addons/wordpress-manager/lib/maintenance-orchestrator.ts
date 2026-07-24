import "server-only";

/**
 * Maintenance-mode ORCHESTRATOR — the single decision point that keeps the two
 * 503 layers from fighting.
 *
 * There are two engines that can put a site behind a maintenance page:
 *  1. The connector's gated `IWSL_Maintenance_Mode` (branded page, IP allow-list,
 *     auto-off), driven by the signed `maintenance.set` method.
 *  2. The console's mu-plugin fallback (`lib/maintenance.ts` + `provision.ts`),
 *     driven over wp-cli exec — the only path that works on unlinked/un-entitled
 *     sites.
 *
 * Both hook `template_redirect` at priority 0, so on a Pro site they could both
 * be active with whichever registered first winning. This module enforces MUTUAL
 * EXCLUSION: it PREFERS the signed engine on a linked + entitled + switched-on
 * site, falls back to the mu-plugin otherwise, and — crucially — turns the OTHER
 * layer off whenever it drives one, so the two 503s are never both live.
 *
 * The decision + merge logic is pure and injectable (the I/O is passed in), so the
 * orchestration is unit-tested with fakes; the thin `setSiteMaintenance` /
 * `getSiteMaintenanceState` entry points bind the real signed op + provision I/O.
 */

import { getManagedLink } from "./iwsl-managed";
import { getMaintenanceMode, setMaintenanceMode } from "./provision";
import { setConnectorMaintenance, siteHealthSnapshot } from "./iwsl-managed-ops";
import type { MaintenanceState, MaintenanceSetParams, SiteHealthSnapshot } from "./manage/site-health";

/** Which 503 layer currently owns the site's maintenance state. */
export type MaintenanceSource = "connector" | "mu-plugin";

/** The desired change. `enabled` is required; the rest patch onto current state. */
export interface MaintenancePatch {
  readonly enabled: boolean;
  readonly headline?: string;
  readonly message?: string;
  readonly retry_after?: boolean;
  readonly until?: number;
  readonly allow_ips?: readonly string[];
}

/** The orchestrated maintenance state the console renders (either engine). */
export interface OrchestratedMaintenance {
  readonly enabled: boolean;
  readonly source: MaintenanceSource;
  readonly headline?: string;
  readonly message?: string;
  readonly retry_after?: boolean;
  readonly until?: number;
  readonly allow_ips?: readonly string[];
}

// ── pure core (unit-tested without any I/O) ────────────────────────────────────

/**
 * Route a maintenance change: the signed connector engine when the site is
 * commandable AND its `maintenance_mode` flag evaluates unlocked; the mu-plugin
 * fallback otherwise. Pure.
 */
export function decideMaintenanceRoute(input: {
  readonly commandable: boolean;
  readonly maintenanceUnlocked: boolean;
}): MaintenanceSource {
  return input.commandable && input.maintenanceUnlocked ? "connector" : "mu-plugin";
}

/**
 * True when the connector's maintenance engine is driveable for this site: the
 * flag switch is on AND the snapshot did not report it locked. Pure.
 */
export function resolveMaintenanceUnlocked(snapshot: SiteHealthSnapshot | null): boolean {
  if (!snapshot) return false;
  return snapshot.switches.maintenance_mode === true && snapshot.maintenance.locked !== true;
}

/**
 * Merge a patch onto the connector's current maintenance settings to form the
 * FULL `maintenance.set` params — so a bare `{ enabled }` toggle never wipes an
 * existing headline / message / allow-list. Pure.
 */
export function mergeMaintenanceParams(current: MaintenanceState, patch: MaintenancePatch): MaintenanceSetParams {
  return {
    enabled: patch.enabled,
    headline: patch.headline ?? current.headline ?? "",
    message: patch.message ?? current.message ?? "",
    retry_after: patch.retry_after ?? current.retry_after ?? false,
    until: patch.until ?? current.until ?? 0,
    allow_ips: [...(patch.allow_ips ?? current.allow_ips ?? [])],
  };
}

/** Project a snapshot's maintenance view into the console's read model. Pure. */
export function maintenanceStateFromSnapshot(snapshot: SiteHealthSnapshot): OrchestratedMaintenance {
  const m = snapshot.maintenance;
  return {
    source: "connector",
    enabled: m.enabled === true,
    headline: m.headline,
    message: m.message,
    retry_after: m.retry_after,
    until: m.until,
    allow_ips: m.allow_ips,
  };
}

// ── injectable orchestration (I/O passed in; tested with fakes) ─────────────────

export interface MaintenanceDeps {
  /** True when the site has an active, fingerprint-confirmed managed link. */
  readonly getCommandable: (site: string) => Promise<boolean>;
  /** The one bounded site-health snapshot, or null when unavailable. */
  readonly getSnapshot: (site: string) => Promise<SiteHealthSnapshot | null>;
  /** Drive the signed connector maintenance engine. */
  readonly setConnector: (site: string, params: MaintenanceSetParams) => Promise<{ locked?: boolean }>;
  /** Drive the mu-plugin fallback (idempotent). */
  readonly setMuPlugin: (site: string, enabled: boolean) => Promise<{ enabled: boolean }>;
  /** Read the mu-plugin fallback state. */
  readonly getMuStatus: (site: string) => Promise<{ enabled: boolean }>;
}

/** Best-effort side effect: log and swallow so a cleanup blip never fails the primary write. */
async function bestEffort(what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.warn(`[wordpress:maintenance] ${what} failed (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

/**
 * Apply a maintenance change through the correct engine, enforcing mutual
 * exclusion. On the signed path the mu-plugin option is deleted so the two 503
 * layers are never both active; the fallback path only runs when the connector
 * engine is definitionally locked (so it cannot be blocking) and needs no clear.
 */
export async function applyMaintenance(
  site: string,
  patch: MaintenancePatch,
  deps: MaintenanceDeps,
): Promise<OrchestratedMaintenance> {
  const commandable = await deps.getCommandable(site);

  if (commandable) {
    const snapshot = await deps.getSnapshot(site).catch(() => null);
    if (resolveMaintenanceUnlocked(snapshot)) {
      const params = mergeMaintenanceParams(snapshot!.maintenance, patch);
      const res = await deps.setConnector(site, params);
      // The engine may refuse (`locked`) if entitlement was revoked between the
      // snapshot read and the write — only claim the signed path when it stuck.
      if (res.locked !== true) {
        // Mutual exclusion: force the mu-plugin layer off.
        await bestEffort("mu-plugin clear", () => deps.setMuPlugin(site, false));
        return {
          source: "connector",
          enabled: params.enabled,
          headline: params.headline,
          message: params.message,
          retry_after: params.retry_after,
          until: params.until,
          allow_ips: params.allow_ips,
        };
      }
    }
  }

  // Fallback: the connector engine is locked/off/unreachable here, so it cannot
  // be serving a 503 — driving the mu-plugin alone keeps exactly one layer live.
  const status = await deps.setMuPlugin(site, patch.enabled);
  return { source: "mu-plugin", enabled: status.enabled };
}

/**
 * Read the orchestrated maintenance state: the connector snapshot when it owns
 * the state (linked + not locked), else the mu-plugin fallback. Snapshot-first so
 * the read isn't a flaky exec on a linked site.
 */
export async function readMaintenance(site: string, deps: MaintenanceDeps): Promise<OrchestratedMaintenance> {
  const commandable = await deps.getCommandable(site);
  if (commandable) {
    const snapshot = await deps.getSnapshot(site).catch(() => null);
    if (snapshot && snapshot.maintenance.locked !== true) {
      return maintenanceStateFromSnapshot(snapshot);
    }
  }
  const status = await deps.getMuStatus(site);
  return { source: "mu-plugin", enabled: status.enabled };
}

// ── real deps (bind the signed op + provision I/O) ─────────────────────────────

async function isSiteCommandable(site: string): Promise<boolean> {
  const link = await getManagedLink(site).catch(() => null);
  return link?.state === "active" && link.fingerprintConfirmed === true;
}

async function safeSnapshot(site: string): Promise<SiteHealthSnapshot | null> {
  return siteHealthSnapshot(site).catch(() => null);
}

const REAL_DEPS: MaintenanceDeps = {
  getCommandable: isSiteCommandable,
  getSnapshot: safeSnapshot,
  setConnector: (site, params) => setConnectorMaintenance(site, params),
  setMuPlugin: (site, enabled) => setMaintenanceMode(site, enabled),
  getMuStatus: (site) => getMaintenanceMode(site),
};

/** Orchestrated maintenance write — the ONE entry point every console path uses. */
export function setSiteMaintenance(site: string, patch: MaintenancePatch): Promise<OrchestratedMaintenance> {
  return applyMaintenance(site, patch, REAL_DEPS);
}

/** Orchestrated maintenance read — snapshot-first, mu-plugin fallback. */
export function getSiteMaintenanceState(site: string): Promise<OrchestratedMaintenance> {
  return readMaintenance(site, REAL_DEPS);
}
