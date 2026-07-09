/**
 * NAS least-privilege self-provisioning — SERVER ONLY.
 *
 * The problem this solves: to add a NAS the operator would otherwise have to
 * hand InfraWeaver a full admin credential and have it stored in OpenBao. That
 * is both over-privileged and easy to get wrong. Instead, the operator pastes a
 * *temporary* admin credential ONCE; this module uses it to mint a dedicated,
 * least-privilege service account on the NAS itself, and returns ONLY that
 * scoped credential to the caller. The admin credential is used for the single
 * provisioning call and then discarded by the caller — it is never persisted,
 * never written to OpenBao, and never logged.
 *
 *   Synology → creates a non-admin DSM user (member of `users`, no admin group)
 *              with a server-generated strong password, then best-effort grants
 *              read/write on the requested shares. A non-admin DSM user has no
 *              access until explicitly granted, so this is least-privilege by
 *              construction.
 *   TrueNAS  → creates an API key bound to a specific TrueNAS user
 *              (`api_key.create` requires `username`). Current TrueNAS releases
 *              dropped the per-key endpoint `allowlist`, so a key inherits the
 *              privileges of the user it is bound to — binding it to a
 *              non-root, least-privilege account IS the scoping mechanism. The
 *              operator names that user; the admin key is never stored.
 *
 * Every outbound call goes through `fetchNasService`, which enforces both the
 * SSRF allowlist and the appliance's operator-confirmed TLS certificate pin.
 * The host always comes from a resolved/allowlisted provider config, never raw
 * user input.
 */

import { randomBytes } from "node:crypto";
import { synologyLogin, type ProbeTarget } from "@/lib/nas/discovery";
import { fetchNasService } from "@/lib/nas/pinned-fetch";
import type { StoredNasCredentials } from "@/lib/nas/store";

const PROVISION_TIMEOUT_MS = 8000;

/** Admin credential the operator provides ONCE, used only to mint the scoped account. */
export interface NasAdminCredentials {
  /** Synology: DSM admin username. */
  username?: string;
  /** Synology: DSM admin password. */
  password?: string;
  /** TrueNAS: admin API key (Bearer). */
  apiKey?: string;
  /**
   * TrueNAS: the existing TrueNAS user the minted API key is bound to. Required
   * by `api_key.create`. The key inherits this user's privileges, so naming a
   * non-root account is what makes the stored credential least-privilege.
   */
  scopedUsername?: string;
}

export interface ScopedAccountResult {
  ok: boolean;
  /** The scoped credential to persist. Never contains the admin credential. */
  credentials?: StoredNasCredentials;
  /** Human-readable name of the account/key that was created (for the audit log). */
  scopedName?: string;
  /** Non-fatal issue (e.g. account created but a share grant did not apply). */
  warning?: string;
  /** Fatal error — provisioning did not produce a usable scoped credential. */
  error?: string;
}

/** Generate a strong password that satisfies typical DSM complexity rules
 *  (>=12 chars, mixed upper/lower/digit/symbol). Never logged. */
function generatePassword(): string {
  const body = randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  return `Iw${body}7#`;
}

/** Derive a stable, NAS-safe service-account name from the provider id. */
function scopedAccountName(providerId: string): string {
  const slug = providerId.replace(/[^a-z0-9]/gi, "").slice(0, 14) || "svc";
  return `iwsvc${slug}`;
}

interface SynoResponse {
  success: boolean;
  error?: { code: number };
}

/** List share names using an existing admin SID (so the scoped user can be
 *  granted access to the shares that actually exist). Best-effort — returns [] on error. */
async function synoListShareNames(host: string, port: number, sid: string, pin?: string): Promise<string[]> {
  try {
    const res = await fetchNasService(
      `https://${host}:${port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&SID=${sid}`,
      { timeoutMs: PROVISION_TIMEOUT_MS },
      { pin },
    );
    const data = (await res.json()) as { success: boolean; data?: { shares?: Array<{ name: string }> } };
    if (!data.success) return [];
    return (data.data?.shares ?? []).map((s) => s.name);
  } catch {
    return [];
  }
}

async function synoEntry(
  host: string,
  port: number,
  params: Record<string, string>,
  pin?: string,
): Promise<SynoResponse> {
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetchNasService(
    `https://${host}:${port}/webapi/entry.cgi?${query}`,
    { timeoutMs: PROVISION_TIMEOUT_MS },
    { pin },
  );
  return (await res.json()) as SynoResponse;
}

async function provisionSynology(
  target: ProbeTarget,
  admin: NasAdminCredentials,
  shares: string[],
  providerId: string,
): Promise<ScopedAccountResult> {
  if (!admin.username || !admin.password) {
    return { ok: false, error: "Synology admin username and password are required to provision a scoped account" };
  }
  const pin = target.tlsFingerprint256;
  const sid = await synologyLogin({
    host: target.host,
    port: target.port,
    tlsFingerprint256: pin,
    user: admin.username,
    password: admin.password,
  });
  if (!sid) {
    return { ok: false, error: "Synology admin login failed — check host and admin credentials" };
  }

  const name = scopedAccountName(providerId);
  const password = generatePassword();

  // Create the non-admin user. If it already exists, fall back to resetting its
  // password so re-running the wizard is idempotent and yields a known credential.
  const created = await synoEntry(target.host, target.port, {
    api: "SYNO.Core.User",
    version: "1",
    method: "create",
    name,
    password,
    description: "InfraWeaver least-privilege service account",
    cannot_chg_passwd: "true",
    _sid: sid,
  }, pin).catch(() => ({ success: false }) as SynoResponse);

  if (!created.success) {
    const reset = await synoEntry(target.host, target.port, {
      api: "SYNO.Core.User",
      version: "1",
      method: "set",
      name,
      password,
      _sid: sid,
    }, pin).catch(() => ({ success: false }) as SynoResponse);
    if (!reset.success) {
      return {
        ok: false,
        error: "Could not create or update the scoped Synology account (admin user may lack user-management rights)",
      };
    }
  }

  // Best-effort: grant the scoped user read/write on the requested shares. When
  // no specific shares were passed (the provider is added before any share is
  // chosen), discover the shares that exist and grant on those so the scoped
  // account is immediately usable. A grant failure is non-fatal — the account
  // still exists and is least-privilege; we surface a warning.
  const targetShares = shares.length > 0 ? shares : await synoListShareNames(target.host, target.port, sid, pin);
  let warning: string | undefined;
  if (targetShares.length === 0) {
    warning = "Scoped account created, but no shares were found to grant access to — grant read/write in DSM when you add shares.";
  }
  for (const share of targetShares) {
    const perm = await synoEntry(target.host, target.port, {
      api: "SYNO.Core.Share.Permission",
      version: "1",
      method: "set",
      name: share,
      user_group_type: "local_user",
      permissions: JSON.stringify([{ name, is_readonly: false, is_writable: true, is_deny: false }]),
      _sid: sid,
    }, pin).catch(() => ({ success: false }) as SynoResponse);
    if (!perm.success) {
      warning = `Scoped account created, but read/write on share '${share}' could not be granted automatically — grant it in DSM (Control Panel → Shared Folder → Edit → Permissions).`;
    }
  }

  return {
    ok: true,
    credentials: { username: name, password },
    scopedName: name,
    warning,
  };
}

interface TruenasApiKey {
  id: number;
  name: string;
}

async function provisionTruenas(
  target: ProbeTarget,
  admin: NasAdminCredentials,
  providerId: string,
): Promise<ScopedAccountResult> {
  if (!admin.apiKey) {
    return { ok: false, error: "TrueNAS admin API key is required to provision a scoped key" };
  }
  if (!admin.scopedUsername) {
    return {
      ok: false,
      error:
        "A TrueNAS username is required: api_key.create binds the new key to a user, " +
        "and the key inherits that user's privileges. Name a non-root account.",
    };
  }
  const pin = target.tlsFingerprint256;
  const authHeader = { Authorization: `Bearer ${admin.apiKey}` };
  // TrueNAS serves its REST API under `/api/v2.0`; `/api/v2` returns 404.
  const base = `https://${target.host}:${target.port}/api/v2.0`;
  const name = scopedAccountName(providerId);

  // Idempotent: remove any prior key with the same name before minting a fresh
  // one (TrueNAS only reveals a key value at creation time).
  try {
    const listRes = await fetchNasService(`${base}/api_key`, { headers: authHeader, timeoutMs: PROVISION_TIMEOUT_MS }, { pin });
    if (listRes.ok) {
      const keys = (await listRes.json()) as TruenasApiKey[];
      for (const key of keys.filter((k) => k.name === name)) {
        await fetchNasService(
          `${base}/api_key/id/${key.id}`,
          { method: "DELETE", headers: authHeader, timeoutMs: PROVISION_TIMEOUT_MS },
          { pin },
        ).catch(() => undefined);
      }
    }
  } catch {
    // Non-fatal: if listing fails we still attempt creation below.
  }

  // `api_key_create` is `{name, username, expires_at}` with
  // `additionalProperties: false` — sending the old per-key `allowlist` is a
  // 422. Privilege scoping now comes entirely from `username`.
  try {
    const res = await fetchNasService(
      `${base}/api_key`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name, username: admin.scopedUsername }),
        timeoutMs: PROVISION_TIMEOUT_MS,
      },
      { pin },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error:
          `TrueNAS rejected scoped key creation (HTTP ${res.status})` +
          (detail ? `: ${detail.slice(0, 200)}` : ""),
      };
    }
    const created = (await res.json()) as { key?: string };
    if (!created.key) {
      return { ok: false, error: "TrueNAS did not return a key value for the scoped API key" };
    }
    const warning =
      admin.scopedUsername === "root" || admin.scopedUsername === "truenas_admin"
        ? `The API key is bound to '${admin.scopedUsername}', so it carries that account's full privileges. ` +
          `Bind it to a dedicated non-admin TrueNAS user to make the stored credential least-privilege.`
        : undefined;
    return { ok: true, credentials: { apiKey: created.key }, scopedName: `${name} (user ${admin.scopedUsername})`, warning };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "TrueNAS unreachable during provisioning" };
  }
}

/**
 * Mint a least-privilege service account on the NAS using a one-time admin
 * credential. Returns ONLY the scoped credential to persist; the caller must
 * discard the admin credential and never persist or log it.
 *
 * `shares` scopes the Synology share grants (ignored for TrueNAS, whose key
 * scope is determined by the user it is bound to).
 */
export async function provisionScopedNasAccount(
  target: ProbeTarget,
  adminCredentials: NasAdminCredentials,
  shares: string[],
  providerId: string,
): Promise<ScopedAccountResult> {
  if (target.kind === "synology") {
    return provisionSynology(target, adminCredentials, shares, providerId);
  }
  if (target.kind === "truenas") {
    return provisionTruenas(target, adminCredentials, providerId);
  }
  return {
    ok: false,
    error: "Least-privilege provisioning is only supported for Synology and TrueNAS providers",
  };
}
