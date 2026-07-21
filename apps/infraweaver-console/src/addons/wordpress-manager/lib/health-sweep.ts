import "server-only";
import { listExternalSites, type ExternalSiteRecord } from "./iwsl-link-store";
import { validateSiteOidc } from "./provision";
import {
  connectorHealthCheck,
  externalConnectorHealthCheck,
  type ConnectorHealth,
} from "./iwsl-managed-ops";

/**
 * Server-driven connector health sweep (§12.5). Runs the same signed
 * `health.check` round-trip the operator triggers by hand, but across every
 * commandable link at once — so `lastHealth`, `connectorVersion`, and the
 * derived "update available" badge stay fresh regardless of who has a browser
 * open. Invoked hourly by the health-sweep CronJob.
 *
 * BOTH link families are swept, each over its own transport:
 *   - §5.1 managed links → `connectorHealthCheck` over the k8s-exec channel.
 *   - §5 external links   → `externalConnectorHealthCheck` over the public
 *                           HTTPS command channel (IW initiates the POST; the
 *                           site never dials in — §2 invariant intact).
 * Only active + fingerprint-confirmed links are targeted; both check functions
 * fail-closed on anything else, so a quarantined or half-enrolled link would
 * just error. Each site is isolated in its own try/catch under a single
 * Promise.allSettled — one unreachable pod OR one dead external endpoint must
 * never abort the rest of the batch.
 *
 * Down-confirmation: a link is only reported failed after a CONFIRMATION
 * re-check also fails. A single transient blip — a momentary 502, a pod caught
 * mid-restart, a maintenance flap — would otherwise flip `lastHealth.ok` to
 * false and, downstream, flap the link's status; requiring two consecutive
 * misses debounces that without masking a genuinely down link (both attempts
 * fail → reported down).
 */

const DOWN_CONFIRM_ATTEMPTS = 2;

type SweepTransport = "exec" | "https";

export interface SweepTarget {
  /** Result label — managed `siteName` or external `siteId`. */
  label: string;
  /** Which transport carries this site's signed health.check. */
  transport: SweepTransport;
  /** The signed round-trip; both variants persist `connectorVersion` on success. */
  check: () => Promise<ConnectorHealth>;
}

export interface HealthSweepSiteResult {
  /** Managed link's siteName, or external link's siteId. */
  site: string;
  /** Transport the check ran over — lets the caller see both families were swept. */
  transport: SweepTransport;
  ok: boolean;
  /** Rejection reason or thrown-error message when the check did not pass. */
  reason?: string;
  roundtripMs?: number;
  /** How many checks ran for this link (1, or 2 when a failure was re-confirmed). */
  attempts: number;
  /** True when a first-attempt failure was cleared by the confirmation re-check. */
  flapSuppressed?: boolean;
}

export interface HealthSweepSummary {
  ranAt: string;
  /** Number of links the sweep attempted (managed + external). */
  total: number;
  passed: number;
  failed: number;
  /** Per-transport attempt counts, for observability into external coverage. */
  managedTotal: number;
  externalTotal: number;
  results: HealthSweepSiteResult[];
}

/** Active, fingerprint-confirmed §5.1 managed links — swept over k8s exec. */
function isSweepableManaged(site: ExternalSiteRecord): boolean {
  return Boolean(site.managed) && Boolean(site.siteName) && site.state === "active" && site.fingerprintConfirmed;
}

/** Active, fingerprint-confirmed §5 external links — swept over HTTPS. */
function isSweepableExternal(site: ExternalSiteRecord): boolean {
  return !site.managed && site.state === "active" && site.fingerprintConfirmed;
}

function buildTargets(sites: ExternalSiteRecord[]): SweepTarget[] {
  const managed = sites.filter(isSweepableManaged).map((site): SweepTarget => {
    const siteName = site.siteName as string;
    return { label: siteName, transport: "exec", check: () => connectorHealthCheck(siteName) };
  });
  const external = sites.filter(isSweepableExternal).map((site): SweepTarget => ({
    label: site.siteId,
    transport: "https",
    check: () => externalConnectorHealthCheck(site.siteId),
  }));
  return [...managed, ...external];
}

/**
 * One signed health.check attempt, normalized to a result (never throws).
 * `transient` marks a TRANSPORT fault (thrown: pod down, 502, timeout, refused)
 * — the class down-confirmation re-checks. A plugin VERDICT (ok:false /
 * rejectedReason like kid-retired, channel-mismatch) is deterministic: a
 * re-check sends a fresh command that would be rejected the same way, so it's
 * reported straight through, not retried.
 */
async function attemptCheck(
  target: SweepTarget,
): Promise<{ result: HealthSweepSiteResult; transient: boolean }> {
  try {
    const health = await target.check();
    return {
      result: {
        site: target.label,
        transport: target.transport,
        ok: health.ok,
        roundtripMs: health.roundtripMs,
        attempts: 1,
        ...(health.rejectedReason ? { reason: health.rejectedReason } : {}),
      },
      transient: false,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      result: { site: target.label, transport: target.transport, ok: false, reason, attempts: 1 },
      transient: true,
    };
  }
}

/**
 * Run one link's health.check with down-confirmation: on a first-attempt
 * TRANSPORT failure, re-check once before reporting the link down. A transient
 * blip that clears on the second attempt is reported OK (flapSuppressed)
 * instead of flapping the link's status.
 */
async function checkWithConfirmation(target: SweepTarget): Promise<HealthSweepSiteResult> {
  let { result, transient } = await attemptCheck(target);
  let attempts = 1;
  while (!result.ok && transient && attempts < DOWN_CONFIRM_ATTEMPTS) {
    attempts += 1;
    const retry = await attemptCheck(target);
    if (retry.result.ok) {
      return { ...retry.result, attempts, flapSuppressed: true };
    }
    result = retry.result;
    transient = retry.transient;
  }
  if (!result.ok) {
    console.warn(
      `[wordpress:iwsl] health sweep for ${target.label} (${target.transport}) failed after ${attempts} attempt(s):`,
      result.reason,
    );
  }
  return { ...result, attempts };
}

/**
 * Sweep an explicit target list (down-confirmation applied per link). Split out
 * from `runHealthSweep` so the confirmation/summary logic is unit-testable with
 * synthetic targets, without a cluster.
 */
export async function sweepTargets(targets: SweepTarget[]): Promise<HealthSweepSummary> {
  // Sweep every target CONCURRENTLY. Each check bounds its own round-trip
  // (COMMAND_TIMEOUT_MS on exec; the fetch timeout on HTTPS), so running them
  // sequentially made total wall-time N× a timeout — a few unreachable links
  // pushed the sweep past the CronJob's `--max-time 300` and failed it hourly.
  // allSettled keeps each site isolated (one failure never rejects the batch)
  // and caps wall-time at ~one round of timeouts regardless of site count.
  const settled = await Promise.allSettled(targets.map((target) => checkWithConfirmation(target)));

  const results: HealthSweepSiteResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          site: targets[i].label,
          transport: targets[i].transport,
          ok: false,
          reason: String(outcome.reason),
          attempts: 0,
        },
  );

  const passed = results.filter((r) => r.ok).length;
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    managedTotal: results.filter((r) => r.transport === "exec").length,
    externalTotal: results.filter((r) => r.transport === "https").length,
    results,
  };
}

/** Summary of one fleet OIDC self-heal pass. */
export interface OidcReconcileSummary {
  readonly checked: number;
  readonly healed: number;
  readonly unhealthy: number;
  readonly errored: number;
}

/**
 * Best-effort OIDC self-heal across managed sites. The reconcile loop only re-runs
 * SSO for a site it considers UNSETTLED, so a site that settled but whose login is
 * actually broken (missing/empty settings — the hi2 class of bug) is never
 * re-checked. This makes "is the login actually configured?" a first-class periodic
 * check that re-provisions when broken. Each site is isolated; the whole pass is
 * best-effort and never affects the connector health sweep. Healthy sites cost only
 * one cheap in-pod `wp option get` — a re-provision runs only when genuinely broken.
 */
export async function reconcileManagedOidc(sites: readonly string[]): Promise<OidcReconcileSummary> {
  const settled = await Promise.allSettled(sites.map((site) => validateSiteOidc(site, { reprovision: true })));
  let healed = 0;
  let unhealthy = 0;
  let errored = 0;
  settled.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      errored += 1;
      return;
    }
    const r = outcome.value;
    if (r.reprovisioned && r.healthy) {
      healed += 1;
      console.warn(`[wordpress] OIDC self-heal: re-provisioned ${sites[i]} (was ${r.reason || "broken"})`);
    } else if (!r.healthy) {
      unhealthy += 1;
      console.warn(`[wordpress] OIDC self-heal: ${sites[i]} still unhealthy (${r.reason})${r.error ? ` — ${r.error}` : ""}`);
    }
  });
  if (healed || unhealthy || errored) {
    console.warn(`[wordpress] OIDC reconcile: ${sites.length} checked, ${healed} healed, ${unhealthy} unhealthy, ${errored} errored`);
  }
  return { checked: sites.length, healed, unhealthy, errored };
}

export async function runHealthSweep(): Promise<HealthSweepSummary> {
  const sites = await listExternalSites();
  const summary = await sweepTargets(buildTargets(sites));
  // Piggy-back a fleet OIDC self-heal on the same hourly cron — isolated so a
  // failure here never affects the connector health result.
  try {
    const managed = sites.filter(isSweepableManaged).map((s) => s.siteName).filter((n): n is string => Boolean(n));
    await reconcileManagedOidc(managed);
  } catch (err) {
    console.warn(`[wordpress] OIDC reconcile pass failed:`, err instanceof Error ? err.message : err);
  }
  return summary;
}
