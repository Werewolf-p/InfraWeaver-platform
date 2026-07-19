/**
 * Clients & Care panel probe — a care-plan scorecard DERIVED from real signals, not
 * an invented CRM. Connection facts come from the signed Connector link
 * (`ctx.managed`: state, fingerprint confirmation, last signed health.check
 * round-trip, connector version, rejections, managed-since); maintenance + security
 * facts come from three cheap wp-cli reads (pending core/plugin updates and core
 * checksum integrity). Gated on the `connector` capability. Read-only.
 */
import { WP, WP_SAFE, toInt } from "../wp-probe";
import type { ExternalSiteView } from "../../iwsl-enrollment";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type CareStatus = "ok" | "attention" | "critical" | "unknown";

export interface CareCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CareStatus;
  readonly detail: string;
}

export interface ClientsConnection {
  readonly state: string | null;
  readonly fingerprintConfirmed: boolean;
  readonly lastCheckAt: string | null;
  readonly lastCheckOk: boolean | null;
  readonly roundtripMs: number | null;
  readonly connectorVersion: string | null;
}

export interface ClientsData {
  /** Overall care score 0–100, averaged from the derived checks. */
  readonly score: number;
  readonly connection: ClientsConnection;
  readonly maintenance: {
    readonly coreUpdate: boolean;
    readonly pluginUpdates: number;
  };
  readonly security: {
    readonly integrityOk: boolean | null;
    readonly rejections: number;
  };
  /** When the site came under management (activatedAt ?? createdAt), or null. */
  readonly managedSince: string | null;
  /** Last signing-key reroll timestamp, or null. */
  readonly lastReroll: string | null;
  readonly checks: readonly CareCheck[];
}

const STATUS_SCORE: Readonly<Record<CareStatus, number>> = { ok: 100, attention: 60, critical: 20, unknown: 50 };

/** Map `wp core verify-checksums 2>&1` output to a pass/fail/unknown verdict. */
function parseIntegrity(stdout: string): boolean | null {
  const s = stdout.toLowerCase();
  if (s.includes("verifies against checksums")) return true;
  if (s.includes("doesn't verify") || s.includes("does not verify") || s.includes("should not exist")) return false;
  return null;
}

function buildChecks(
  connection: ClientsConnection,
  maintenance: ClientsData["maintenance"],
  security: ClientsData["security"],
): CareCheck[] {
  // Connection health — from the last signed health.check on the Connector channel.
  const connActive = connection.state === "active" && connection.fingerprintConfirmed;
  const connectionStatus: CareStatus =
    connection.lastCheckOk === null
      ? "unknown"
      : connection.lastCheckOk && connActive
        ? "ok"
        : connection.lastCheckOk
          ? "attention"
          : "critical";
  const connectionDetail = connection.lastCheckAt
    ? `Last signed check ${connection.lastCheckOk ? "OK" : "failed"}${
        connection.roundtripMs !== null ? ` · ${connection.roundtripMs} ms round-trip` : ""
      }.`
    : "No signed health check recorded yet.";

  // Maintenance currency — pending core + plugin updates.
  const pending = (maintenance.coreUpdate ? 1 : 0) + maintenance.pluginUpdates;
  const maintenanceStatus: CareStatus = pending === 0 ? "ok" : pending <= 3 ? "attention" : "critical";
  const maintenanceDetail =
    pending === 0
      ? "Core and plugins are up to date."
      : `${maintenance.coreUpdate ? "Core update pending; " : ""}${maintenance.pluginUpdates} plugin update${
          maintenance.pluginUpdates === 1 ? "" : "s"
        } available.`;

  // Security — core file integrity + any Connector-link rejections.
  const securityStatus: CareStatus =
    security.integrityOk === null
      ? "unknown"
      : security.integrityOk && security.rejections === 0
        ? "ok"
        : security.integrityOk
          ? "attention"
          : "critical";
  const securityDetail =
    security.integrityOk === null
      ? "Core checksum verification is unavailable."
      : security.integrityOk
        ? `Core files verify against checksums.${security.rejections > 0 ? ` ${security.rejections} link rejection(s) seen.` : ""}`
        : "Core files do not verify against checksums.";

  return [
    { id: "connection", label: "Connection health", status: connectionStatus, detail: connectionDetail },
    { id: "maintenance", label: "Maintenance currency", status: maintenanceStatus, detail: maintenanceDetail },
    { id: "security", label: "Core integrity", status: securityStatus, detail: securityDetail },
  ];
}

function scoreFromChecks(checks: readonly CareCheck[]): number {
  if (checks.length === 0) return 0;
  const sum = checks.reduce((acc, check) => acc + STATUS_SCORE[check.status], 0);
  return Math.round(sum / checks.length);
}

export function buildClientsData(input: {
  managed: ExternalSiteView | null;
  coreUpdate: string;
  pluginUpdates: string;
  integrity: string;
}): ClientsData {
  const m = input.managed;
  const connection: ClientsConnection = {
    state: m?.state ?? null,
    fingerprintConfirmed: m?.fingerprintConfirmed ?? false,
    lastCheckAt: m?.lastHealth?.at ?? null,
    lastCheckOk: m?.lastHealth?.ok ?? null,
    roundtripMs: m?.lastHealth?.roundtripMs ?? null,
    connectorVersion: m?.connectorVersion ?? null,
  };
  const maintenance = {
    coreUpdate: (toInt(input.coreUpdate) ?? 0) > 0,
    pluginUpdates: toInt(input.pluginUpdates) ?? 0,
  };
  const security = {
    integrityOk: parseIntegrity(input.integrity),
    rejections: m?.rejections ?? 0,
  };

  const checks = buildChecks(connection, maintenance, security);
  return {
    score: scoreFromChecks(checks),
    connection,
    maintenance,
    security,
    managedSince: m?.activatedAt ?? m?.createdAt ?? null,
    lastReroll: m?.lastReroll?.at ?? null,
    checks,
  };
}

async function fetchClients(ctx: PanelProbeContext): Promise<ClientsData> {
  const [coreUpdate, pluginUpdates, integrity] = await Promise.all([
    ctx.exec(`${WP_SAFE} core check-update --format=count`).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP} plugin list --update=available --format=count`).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} core verify-checksums 2>&1`).then((r) => r.stdout).catch(() => ""),
  ]);
  return buildClientsData({ managed: ctx.managed, coreUpdate, pluginUpdates, integrity });
}

export const clientsProbe: PanelProbe<ClientsData> = {
  id: "clients",
  requiresCapability: "connector",
  fetch: fetchClients,
};
