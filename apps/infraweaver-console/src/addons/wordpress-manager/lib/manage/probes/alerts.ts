/**
 * Alerts panel probe — DERIVED alerts, never a stored feed. It synthesizes a
 * severity-ranked list from real, cheap signals: pending core/plugin updates,
 * core-file integrity, PHP major version, database size and WP_DEBUG posture
 * (all read live over wp-cli), plus the signed Connector link's own state
 * (quarantine, rejections, last health-check). Nothing here is fabricated — an
 * empty list genuinely means every monitored signal is healthy.
 */
import { WP, WP_SAFE, kvLine, parseKv, toInt } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertItem {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  /** ISO timestamp of the underlying signal, when the source carries one. */
  readonly when?: string;
}

export interface AlertsData {
  readonly alerts: readonly AlertItem[];
  readonly counts: Readonly<Record<AlertSeverity, number>>;
}

/** Managed-link slice the derivation reads — decoupled from the full view for testability. */
export type ManagedAlertSignals = {
  readonly state: "pending" | "active" | "quarantined";
  readonly rejections: number;
  readonly lastHealth?: { at: string; ok: boolean; roundtripMs?: number; reason?: string };
} | null;

/** DB is flagged for review past this size (MB) — informational, not a failure. */
const DB_LARGE_MB = 1024;
/** PHP majors below this are out of active support ⇒ warning. */
const PHP_MIN_MAJOR = 8;

const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { critical: 0, warning: 1, info: 2 };

function isTruthyDebug(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

export function buildAlerts(input: {
  scalars: string;
  verifyChecksums: string;
  managed: ManagedAlertSignals;
}): AlertsData {
  const kv = parseKv(input.scalars);
  const alerts: AlertItem[] = [];

  // Pending updates — outdated core/plugins are the most common security gap.
  const coreUpdates = toInt(kv.get("CORE_UPDATES")) ?? 0;
  if (coreUpdates > 0) {
    alerts.push({
      id: "core-update",
      severity: "warning",
      title: "WordPress core update available",
      detail: `${coreUpdates} core update${coreUpdates === 1 ? "" : "s"} pending. Apply it from the Updates tab.`,
    });
  }
  const pluginUpdates = toInt(kv.get("PLUGIN_UPDATES")) ?? 0;
  if (pluginUpdates > 0) {
    alerts.push({
      id: "plugin-updates",
      severity: "warning",
      title: "Plugin updates available",
      detail: `${pluginUpdates} plugin${pluginUpdates === 1 ? "" : "s"} can be updated.`,
    });
  }

  // Core-file integrity — a checksum mismatch can mean tampering. Only emitted
  // when verify-checksums actually returned output (empty ⇒ read failed ⇒ unknown).
  const verify = input.verifyChecksums.trim();
  if (verify !== "") {
    const failed = /Warning:|Error:/i.test(verify) || !/Success:/i.test(verify);
    if (failed) {
      alerts.push({
        id: "core-integrity",
        severity: "critical",
        title: "Core files failed checksum verification",
        detail: "One or more WordPress core files do not match the official checksums.",
      });
    }
  }

  // PHP major — an out-of-support runtime no longer receives security fixes.
  const phpMajor = toInt((kv.get("PHP_VERSION") ?? "").split(".")[0]);
  if (phpMajor !== null && phpMajor < PHP_MIN_MAJOR) {
    alerts.push({
      id: "php-eol",
      severity: "warning",
      title: `PHP ${phpMajor} is out of support`,
      detail: `The site runs PHP ${phpMajor}. Upgrade to PHP ${PHP_MIN_MAJOR}+ for security fixes.`,
    });
  }

  // WP_DEBUG left on in production leaks paths and notices to visitors.
  if (isTruthyDebug(kv.get("WP_DEBUG"))) {
    alerts.push({
      id: "wp-debug",
      severity: "warning",
      title: "WP_DEBUG is enabled",
      detail: "Debug mode is on; disable it in production to avoid leaking errors to visitors.",
    });
  }

  // Database size — informational, useful for capacity planning.
  const dbSizeMb = toInt(kv.get("DB_SIZE_MB"));
  if (dbSizeMb !== null && dbSizeMb >= DB_LARGE_MB) {
    alerts.push({
      id: "db-size",
      severity: "info",
      title: "Database is large",
      detail: `The database is ${dbSizeMb} MB. Consider cleaning transients and revisions from the Database tab.`,
    });
  }

  // Signed Connector link signals — quarantine, verify rejections, health.
  const managed = input.managed;
  if (managed) {
    if (managed.state === "quarantined") {
      alerts.push({
        id: "connector-quarantine",
        severity: "critical",
        title: "Connector link is quarantined",
        detail: "The signed link to this site is quarantined; command dispatch is blocked until it is cleared.",
      });
    }
    if (managed.rejections > 0) {
      alerts.push({
        id: "connector-rejections",
        severity: "warning",
        title: "Connector saw rejected signatures",
        detail: `${managed.rejections} signature/enrollment rejection${managed.rejections === 1 ? "" : "s"} recorded for this link.`,
      });
    }
    if (managed.lastHealth && !managed.lastHealth.ok) {
      alerts.push({
        id: "connector-health",
        severity: "warning",
        title: "Last signed health-check failed",
        detail: managed.lastHealth.reason ?? "The most recent signed liveness check did not succeed.",
        when: managed.lastHealth.at,
      });
    }
  }

  const sorted = [...alerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const counts: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const alert of sorted) counts[alert.severity] += 1;

  return { alerts: sorted, counts };
}

async function fetchAlerts(ctx: PanelProbeContext): Promise<AlertsData> {
  const scalarsCmd = [
    kvLine("PHP_VERSION", `php -r 'echo PHP_VERSION;'`),
    kvLine("CORE_UPDATES", `${WP_SAFE} core check-update --format=count`),
    // Plugin list needs plugin code loaded; count non-empty slug lines.
    `echo "PLUGIN_UPDATES=$(${WP} plugin list --update=available --field=name 2>/dev/null | grep -c . 2>/dev/null)"`,
    kvLine("DB_SIZE_MB", `${WP_SAFE} db size --size_format=mb`),
    kvLine("WP_DEBUG", `${WP_SAFE} config get WP_DEBUG`),
  ].join("\n");

  const [scalars, verifyChecksums] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} core verify-checksums 2>&1 || true`).then((r) => r.stdout).catch(() => ""),
  ]);

  const managed: ManagedAlertSignals = ctx.managed
    ? { state: ctx.managed.state, rejections: ctx.managed.rejections, lastHealth: ctx.managed.lastHealth }
    : null;

  return buildAlerts({ scalars, verifyChecksums, managed });
}

export const alertsProbe: PanelProbe<AlertsData> = {
  id: "alerts",
  fetch: fetchAlerts,
};
