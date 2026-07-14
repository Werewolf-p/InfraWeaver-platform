/**
 * Roster-drift detection — SERVER ONLY.
 *
 * users.yaml is the source of truth for who should have an Authentik identity.
 * Reconcile/offboard converge the directory TOWARD it, but nothing catches an
 * account that appears in Authentik out-of-band: a break-glass superuser, a
 * leftover enrollment test account, or an identity whose users.yaml row was
 * deleted without offboarding (so the SSO account lingers). This module lists the
 * live directory and flags every ACTIVE account that the roster does not account
 * for, escalating when the unmanaged account carries privileged reach.
 *
 * Flag rules (mirrors the scheduled probe contract):
 *   - `unmanaged`      — active account whose username AND email are both absent
 *                        from users.yaml. Outpost service accounts (`ak-outpost-*`)
 *                        are excluded: they are machine identities Authentik
 *                        creates per-outpost and legitimately never in the roster.
 *   - `suspicious-name`— username matches `e2e-*` / `test-*` / `*-test`, flagged
 *                        regardless of roster membership (throwaway harness accounts
 *                        must never persist on a production directory).
 * An entry carrying either reason whose account is a privileged-group member (or
 * an Authentik superuser) is an ESCALATION — `report.alert` goes true and the
 * scheduled probe/endpoint records a security audit failure.
 *
 * Deps are injectable so the pure classification is exercised deterministically in
 * unit tests and the `sec-roster-drift` runtime self-test without a live Authentik
 * or a real users.yaml. `detectRosterDrift()` defaults to the real lookups.
 */
import "server-only";
import { authentikFetch } from "@/lib/authentik";
import { loadUsersConfig } from "@/lib/users-config";

/** Per-outpost machine identities Authentik provisions; never in users.yaml. */
export const OUTPOST_SERVICE_ACCOUNT_RE = /^ak-outpost-/i;

/** Throwaway e2e/test account names: `e2e-*`, `test-*`, `*-test`. */
export const SUSPICIOUS_NAME_RE = /^(?:e2e|test)-|-test$/i;

/**
 * Authentik groups conferring administrative / superuser reach. Membership makes
 * an unmanaged account an escalation. Compared case-insensitively. The
 * `is_superuser` flag (user- or group-level) is treated as privileged on its own,
 * independent of this list.
 */
export const PRIVILEGED_GROUPS: ReadonlySet<string> = new Set([
  "authentik admins",
  "platform-admins",
  "superusers",
]);

/** The subset of an Authentik `/core/users/` record this check reads. */
export interface AuthentikDirectoryUser {
  pk: number | string;
  username: string;
  email?: string;
  is_active?: boolean;
  is_superuser?: boolean;
  groups_obj?: Array<{ name?: string; is_superuser?: boolean }>;
}

export type DriftReason = "unmanaged" | "suspicious-name";

export interface RosterDriftEntry {
  username: string;
  email?: string;
  reasons: DriftReason[];
  privileged: boolean;
  /** How privilege was established (a group name or `is_superuser`), for the alert. */
  privilegedVia?: string;
}

export interface RosterDriftReport {
  /** Active, non-outpost accounts examined. */
  scanned: number;
  /** `ak-outpost-*` accounts skipped. */
  excluded: number;
  drift: RosterDriftEntry[];
  privilegedUnmanaged: RosterDriftEntry[];
  /** True when at least one unmanaged/suspicious account is privileged. */
  alert: boolean;
}

/** The roster reduced to the lookup sets drift-classification needs. */
export interface RosterKeys {
  usernames: Set<string>;
  emails: Set<string>;
}

export interface RosterDriftDeps {
  listDirectoryUsers: () => Promise<AuthentikDirectoryUser[]>;
  loadRoster: () => Promise<RosterKeys>;
}

function privilegeOf(user: AuthentikDirectoryUser): { privileged: boolean; via?: string } {
  if (user.is_superuser === true) return { privileged: true, via: "is_superuser" };
  for (const group of user.groups_obj ?? []) {
    const name = (group?.name ?? "").trim();
    if (group?.is_superuser === true) return { privileged: true, via: `group:${name || "?"} (superuser)` };
    if (name && PRIVILEGED_GROUPS.has(name.toLowerCase())) return { privileged: true, via: `group:${name}` };
  }
  return { privileged: false };
}

/**
 * Pure drift classification: given the live directory and the roster lookup sets,
 * produce the report. No I/O — the seam both the endpoint and the probe drive.
 */
export function classifyDirectory(users: AuthentikDirectoryUser[], roster: RosterKeys): RosterDriftReport {
  const drift: RosterDriftEntry[] = [];
  let scanned = 0;
  let excluded = 0;

  for (const user of users) {
    const username = (user.username ?? "").trim();
    if (!username) continue;
    // Only ACTIVE accounts — a disabled account is already deprovisioned.
    if (user.is_active === false) continue;
    // Outpost service accounts legitimately live outside users.yaml.
    if (OUTPOST_SERVICE_ACCOUNT_RE.test(username)) {
      excluded++;
      continue;
    }
    scanned++;

    const email = typeof user.email === "string" && user.email.trim() ? user.email.trim() : undefined;
    const inRoster =
      roster.usernames.has(username.toLowerCase()) || (!!email && roster.emails.has(email.toLowerCase()));

    const reasons: DriftReason[] = [];
    if (!inRoster) reasons.push("unmanaged");
    if (SUSPICIOUS_NAME_RE.test(username)) reasons.push("suspicious-name");
    if (reasons.length === 0) continue;

    const { privileged, via } = privilegeOf(user);
    drift.push({ username, email, reasons, privileged, privilegedVia: via });
  }

  const privilegedUnmanaged = drift.filter((entry) => entry.privileged);
  return { scanned, excluded, drift, privilegedUnmanaged, alert: privilegedUnmanaged.length > 0 };
}

/** Page the full Authentik user directory (100/page, capped defensively). */
async function listAllAuthentikUsers(): Promise<AuthentikDirectoryUser[]> {
  const out: AuthentikDirectoryUser[] = [];
  const MAX_PAGES = 50; // 5000 accounts — far beyond this deployment; a runaway guard.
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await authentikFetch(`/core/users/?page=${page}&page_size=100`);
    if (!res.ok) throw new Error(`Authentik user list failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      results?: AuthentikDirectoryUser[];
      pagination?: { next?: number };
    };
    out.push(...(data.results ?? []));
    if (!data.pagination?.next) break;
  }
  return out;
}

/** Reduce users.yaml to the username + email lookup sets, lowercased. */
async function loadRosterKeys(): Promise<RosterKeys> {
  const cfg = await loadUsersConfig(0);
  const usernames = new Set<string>();
  const emails = new Set<string>();
  for (const [key, user] of Object.entries(cfg.users)) {
    const username = key.trim().toLowerCase();
    if (username) usernames.add(username);
    const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
    if (email) emails.add(email);
  }
  return { usernames, emails };
}

export const defaultRosterDriftDeps: RosterDriftDeps = {
  listDirectoryUsers: listAllAuthentikUsers,
  loadRoster: loadRosterKeys,
};

/**
 * List the live Authentik directory + the roster and classify drift. Throws if the
 * directory or roster cannot be read (callers surface that as inconclusive, not a
 * clean pass).
 */
export async function detectRosterDrift(
  deps: RosterDriftDeps = defaultRosterDriftDeps,
): Promise<RosterDriftReport> {
  const [users, roster] = await Promise.all([deps.listDirectoryUsers(), deps.loadRoster()]);
  return classifyDirectory(users, roster);
}
