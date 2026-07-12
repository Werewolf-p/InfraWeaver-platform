/**
 * OpenBao-backed {@link AppAccountStore} — SERVER ONLY.
 *
 * Two things live in the vault under `secret/platform/app-accounts/<app>/`:
 *   - `roster`          — the list of accounts InfraWeaver provisioned. This is
 *                         what tells the reconcile which app users it MANAGES (so
 *                         it never disables a manual or app-native account), and
 *                         whose credential hand-off never completed (`notifiedAt`
 *                         absent → reported as `pendingHandoff`, never re-sent).
 *   - `users/<name>`    — one per provisioned account: the generated password +
 *                         email, so the console can reveal it for an out-of-band
 *                         hand-off or reset it on request. Credentials never touch
 *                         git, users.yaml, logs, or a manifest.
 *
 * KV v2 plumbing (auth env, timeouts, `data/data` unwrap, 404 → null) lives in
 * `@/lib/openbao/kv`. The console's OpenBao token needs create/read/update/delete
 * on `secret/data/platform/app-accounts/*` (a reported bootstrap-openbao.sh edit).
 */
import "server-only";
import { z } from "zod";
import { deleteKvMetadata, readKv, writeKv } from "@/lib/openbao/kv";
import { filterValid } from "@/lib/zod-utils";
import type { AppAccountStore, RosterEntry } from "@/lib/app-accounts/types";

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
  adoptedAt: z.string().max(40).optional(),
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

function rosterPath(appId: string): string {
  return `${BASE_PATH}/${assertSegment(appId, "app")}/roster`;
}
function credentialPath(appId: string, username: string): string {
  return `${BASE_PATH}/${assertSegment(appId, "app")}/users/${assertUsername(username)}`;
}
function secretPath(appId: string, name: string): string {
  return `${BASE_PATH}/${assertSegment(appId, "app")}/${assertSegment(name, "secret")}`;
}

async function readRoster(appId: string): Promise<RosterEntry[]> {
  const data = (await readKv(rosterPath(appId))) ?? {};
  const parsed = ROSTER_SCHEMA.safeParse(data);
  if (parsed.success) return parsed.data.entries;
  // Salvage individually so one malformed row never blanks the roster (which would
  // make the reconcile treat every managed account as manual and stop revoking).
  return filterValid(ROSTER_ENTRY_SCHEMA, (data as { entries?: unknown }).entries);
}

async function writeRoster(appId: string, entries: RosterEntry[]): Promise<void> {
  await writeKv(rosterPath(appId), { entries });
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
    await writeKv(credentialPath(appId, username), {
      username,
      password,
      email,
      createdAt: new Date().toISOString(),
    });
  },
  async deleteCredential(appId, username) {
    // Delete metadata (all versions) so a revoked user's credential does not
    // linger. Best-effort: an orphaned credential is harmless; never fail a revoke.
    await deleteKvMetadata(credentialPath(appId, username));
  },
};

/**
 * Read an app-scoped service secret (e.g. Jellyfin's service-account API key) from
 * `secret/platform/app-accounts/<app>/<name>`. Returns null on a missing secret so
 * a first-run bootstrap can tell "not provisioned yet" from a hard failure.
 */
export async function readAppSecret(appId: string, name: string): Promise<Record<string, string> | null> {
  return (await readKv(secretPath(appId, name))) as Record<string, string> | null;
}

/** Write an app-scoped service secret. KV v2 replaces the whole secret object. */
export async function writeAppSecret(appId: string, name: string, data: Record<string, string>): Promise<void> {
  await writeKv(secretPath(appId, name), data);
}

/** Read one provisioned credential back for an in-console reveal / reset flow. */
export async function readAppAccountCredential(
  appId: string,
  username: string,
): Promise<{ username: string; password: string; email: string } | null> {
  const data = ((await readKv(credentialPath(appId, username))) ?? {}) as {
    username?: unknown;
    password?: unknown;
    email?: unknown;
  };
  if (typeof data.username !== "string" || typeof data.password !== "string" || typeof data.email !== "string") return null;
  return { username: data.username, password: data.password, email: data.email };
}
