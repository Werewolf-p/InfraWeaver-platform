/**
 * Uptime & Incidents panel probe — powered entirely by the signed Connector link
 * (`ctx.managed`), never wp-cli. There is no stored time-series, so we present
 * current + last-known signals honestly: current liveness, the last signed
 * health-check (time + round-trip), connector version, quarantine state,
 * rejection count and the last key reroll — plus a timeline of the events the
 * link actually records (created, activated, last check, last reroll). No
 * fabricated uptime graph, regions or SLA.
 */
import type { PanelProbe, PanelProbeContext } from "./contract";

export type LinkState = "pending" | "active" | "quarantined";

export type UptimeEventKind = "created" | "activated" | "lastReroll" | "lastCheck";

export interface UptimeEvent {
  readonly kind: UptimeEventKind;
  readonly label: string;
  readonly at: string;
  readonly detail?: string;
  /** Present for events that carry a pass/fail outcome (last check, reroll). */
  readonly ok?: boolean;
}

export interface UptimeData {
  /** Up only when the link is active AND the last signed check passed. */
  readonly live: boolean;
  readonly state: LinkState;
  readonly fingerprintConfirmed: boolean;
  readonly lastCheckAt: string | null;
  readonly lastCheckOk: boolean | null;
  readonly roundtripMs: number | null;
  readonly connectorVersion: string | null;
  /** WP key epoch (kid) currently pinned. */
  readonly kid: number;
  readonly iwAlg: string | null;
  readonly rejections: number;
  readonly lastReroll: { readonly at: string; readonly outcome: string; readonly kid: number } | null;
  readonly timeline: readonly UptimeEvent[];
}

/** Managed-link slice the panel needs — decoupled from the full server view for testability. */
export interface UptimeSignals {
  readonly state: LinkState;
  readonly fingerprintConfirmed: boolean;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly kid: number;
  readonly iwAlg?: string;
  readonly rejections: number;
  readonly lastHealth?: { at: string; ok: boolean; roundtripMs?: number; reason?: string };
  readonly lastReroll?: { at: string; outcome: string; kid: number; reason?: string };
}

/** Empty state for a link that somehow resolved to null (gate should prevent this). */
const UNLINKED: UptimeData = {
  live: false,
  state: "pending",
  fingerprintConfirmed: false,
  lastCheckAt: null,
  lastCheckOk: null,
  roundtripMs: null,
  connectorVersion: null,
  kid: 0,
  iwAlg: null,
  rejections: 0,
  lastReroll: null,
  timeline: [],
};

export function buildUptime(signals: UptimeSignals | null, connectorVersion: string | null): UptimeData {
  if (!signals) return UNLINKED;

  const health = signals.lastHealth ?? null;
  const reroll = signals.lastReroll ?? null;
  const live = signals.state === "active" && health?.ok === true;

  const timeline: UptimeEvent[] = [];
  timeline.push({ kind: "created", label: "Link created", at: signals.createdAt });
  if (signals.activatedAt) {
    timeline.push({ kind: "activated", label: "Link activated", at: signals.activatedAt });
  }
  if (reroll) {
    timeline.push({
      kind: "lastReroll",
      label: "Signing key rerolled",
      at: reroll.at,
      detail: `epoch ${reroll.kid} · ${reroll.outcome}`,
      ok: reroll.outcome === "confirmed",
    });
  }
  if (health) {
    timeline.push({
      kind: "lastCheck",
      label: "Signed health-check",
      at: health.at,
      detail: health.roundtripMs !== undefined ? `${health.roundtripMs} ms round-trip` : health.reason,
      ok: health.ok,
    });
  }
  // Most recent first.
  timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    live,
    state: signals.state,
    fingerprintConfirmed: signals.fingerprintConfirmed,
    lastCheckAt: health?.at ?? null,
    lastCheckOk: health ? health.ok : null,
    roundtripMs: health?.roundtripMs ?? null,
    connectorVersion,
    kid: signals.kid,
    iwAlg: signals.iwAlg ?? null,
    rejections: signals.rejections,
    lastReroll: reroll ? { at: reroll.at, outcome: reroll.outcome, kid: reroll.kid } : null,
    timeline,
  };
}

async function fetchUptime(ctx: PanelProbeContext): Promise<UptimeData> {
  const m = ctx.managed;
  if (!m) return buildUptime(null, null);
  const signals: UptimeSignals = {
    state: m.state,
    fingerprintConfirmed: m.fingerprintConfirmed,
    createdAt: m.createdAt,
    activatedAt: m.activatedAt,
    kid: m.kid,
    iwAlg: m.iwAlg,
    rejections: m.rejections,
    lastHealth: m.lastHealth,
    lastReroll: m.lastReroll,
  };
  return buildUptime(signals, m.connectorVersion ?? null);
}

export const uptimeProbe: PanelProbe<UptimeData> = {
  id: "uptime",
  requiresCapability: "connector",
  fetch: fetchUptime,
};
