/**
 * OpenBao-backed {@link AppAccountStore} — SERVER ONLY.
 *
 * Two things live in the vault under `secret/platform/app-accounts/<app>/`:
 *   - `roster`          — the list of accounts InfraWeaver provisioned. This is
 *                         what tells the reconcile which app users it MANAGES (so
 *                         it never disables a manual or app-native account) and
 *                         which it has already NOTIFIED (so a re-run never re-mails).
 *   - `users/<name>`    — one per provisioned account: the generated password +
 *                         email, so the console can reveal it for an out-of-band
 *                         hand-off or reset it on request. Credentials never touch
 *                         git, users.yaml, logs, or a manifest.
 *
 * Mirrors `@/lib/nas/store` (same vaultFetch shape, same KV v2 wrapping). The
 * console's OpenBao token needs create/read/update/delete on
 * `secret/data/platform/app-accounts/*` (a reported bootstrap-openbao.sh edit).
 */
import "server-only";
import { z } from "zod";
import type { AppAccountStore, RosterEntry } from "@/lib/app-accounts/types";

const KV_MOUNT = process.env.OPENBAO_KV_MOUNT || "secret";
const VAULT_TIMEOUT_MS = Number(process.env.OPENBAO_TIMEOUT_MS) || 10_000;
const BASE_PATH = "platform/app-accounts";

// App id and username are path segments in the vault key, so constrain them to a
// safe grammar rather than trusting a caller not to inject `../` or a mount hop.
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

const ROSTER_ENTRY_SCHEMA = z.object({
  username: z.string().min(1).max(64),
  providerUserId: z.string().min(1).max(128),
  provisionedAt: z.string().min(1).max(40),
  notifiedAt: z.string().max(40).optional(),
});
const ROSTER_SCHEMA = z.object({ entries: z.array(ROSTER_ENTRY_SCHEMA).default([]) });

function assertSegment(value: string, kind: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`unsafe app-accounts ${kind} segment`);
  return value;
}
function assertUsername(value: string): string {
  if (!SAFE_USERNAME.test(value)) throw new Error("unsafe app-accounts username");
  return value;
}

function vaultAuth(): { addr: string; token: string } {
  const addr = (process.env.OPENBAO_ADDR || process.env.VAULT_ADDR || "").replace(/\/+$/, "");
  const token = process.env.OPENBAO_TOKEN || process.env.VAULT_TOKEN || "";
  if (!addr) throw new Error("OPENBAO_ADDR/VAULT_ADDR is not configured");
  if (!token) throw new Error("OPENBAO_TOKEN/VAULT_TOKEN is not configured");
  return { addr, token };
}

/** `logicalPath` is a KV logical path; the mount + `data/` prefix are added here. */
async function vaultFetch(logicalPath: string, init: RequestInit): Promise<Response> {
  const { addr, token } = vaultAuth();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAULT_TIMEOUT_MS);
  try {
    return await fetch(`${addr}/v1/${KV_MOUNT}/data/${logicalPath}`, {
      ...init,
      signal: controller.signal,
      headers: { "X-Vault-Token": token, ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`OpenBao request timed out after ${VAULT_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function rosterPath(appId: string): string {
  return `${BASE_PATH}/${assertSegment(appId, "app")}/roster`;
}
function credentialPath(appId: string, username: string): string {
  return `${BASE_PATH}/${assertSegment(appId, "app")}/users/${assertUsername(username)}`;
}

async function readRoster(appId: string): Promise<RosterEntry[]> {
  const res = await vaultFetch(rosterPath(appId), { method: "GET" });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`OpenBao read app-accounts roster failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: unknown } };
  const parsed = ROSTER_SCHEMA.safeParse(body.data?.data ?? {});
  // Salvage individually so one malformed row never blanks the roster (which would
  // make the reconcile treat every managed account as manual and stop revoking).
  if (parsed.success) return parsed.data.entries;
  const raw = (body.data?.data as { entries?: unknown[] })?.entries;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    const one = ROSTER_ENTRY_SCHEMA.safeParse(row);
    return one.success ? [one.data] : [];
  });
}

async function writeRoster(appId: string, entries: RosterEntry[]): Promise<void> {
  const res = await vaultFetch(rosterPath(appId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { entries } }),
  });
  if (!res.ok) throw new Error(`OpenBao write app-accounts roster failed: ${res.status}`);
}

/** The single shared instance. Stateless beyond the vault, so a module const is fine. */
export const openBaoAppAccountStore: AppAccountStore = {
  async loadRoster(appId) {
    return readRoster(appId);
  },
  async addRosterEntry(appId, entry) {
    const entries = await readRoster(appId);
    // Replace-by-username so a re-provision after a manual delete converges rather
    // than duplicating a roster row.
    const next = [...entries.filter((e) => e.username !== entry.username), entry];
    await writeRoster(appId, next);
  },
  async markNotified(appId, username, notifiedAt) {
    const entries = await readRoster(appId);
    await writeRoster(appId, entries.map((e) => (e.username === username ? { ...e, notifiedAt } : e)));
  },
  async removeRosterEntry(appId, username) {
    const entries = await readRoster(appId);
    await writeRoster(appId, entries.filter((e) => e.username !== username));
  },
  async writeCredential(appId, username, password, email) {
    const res = await vaultFetch(credentialPath(appId, username), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { username, password, email, createdAt: new Date().toISOString() } }),
    });
    if (!res.ok) throw new Error(`OpenBao write app-accounts credential failed: ${res.status}`);
  },
  async deleteCredential(appId, username) {
    const { addr, token } = vaultAuth();
    // Delete metadata (all versions) so a revoked user's credential does not linger.
    await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${credentialPath(appId, username)}`, {
      method: "DELETE",
      headers: { "X-Vault-Token": token },
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    }).catch(() => {
      /* an orphaned credential is harmless; never fail a revoke on cleanup */
    });
  },
};

/**
 * Read an app-scoped service secret (e.g. Jellyfin's service-account API key) from
 * `secret/platform/app-accounts/<app>/<name>`. Returns null on a missing secret so
 * a first-run bootstrap can tell "not provisioned yet" from a hard failure.
 */
export async function readAppSecret(appId: string, name: string): Promise<Record<string, string> | null> {
  const res = await vaultFetch(`${BASE_PATH}/${assertSegment(appId, "app")}/${assertSegment(name, "secret")}`, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenBao read app-accounts secret failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: Record<string, string> } };
  return body.data?.data ?? null;
}

/** Write an app-scoped service secret. KV v2 replaces the whole secret object. */
export async function writeAppSecret(appId: string, name: string, data: Record<string, string>): Promise<void> {
  const res = await vaultFetch(`${BASE_PATH}/${assertSegment(appId, "app")}/${assertSegment(name, "secret")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`OpenBao write app-accounts secret failed: ${res.status}`);
}

/** Read one provisioned credential back for an in-console reveal / reset flow. */
export async function readAppAccountCredential(
  appId: string,
  username: string,
): Promise<{ username: string; password: string; email: string } | null> {
  const res = await vaultFetch(credentialPath(appId, username), { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenBao read app-accounts credential failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: { username?: unknown; password?: unknown; email?: unknown } } };
  const data = body.data?.data ?? {};
  if (typeof data.username !== "string" || typeof data.password !== "string" || typeof data.email !== "string") return null;
  return { username: data.username, password: data.password, email: data.email };
}
