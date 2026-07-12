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
 * Every outbound call goes through the `synoRequest`/`truenasRequest` clients
 * and therefore `fetchNasService`, which enforces both the SSRF allowlist and
 * the appliance's operator-confirmed TLS certificate pin. The host comes from
 * a resolved/allowlisted provider config, or — since this runs before the
 * provider is stored — from the wizard's `wizardHost`, which the allowlist
 * re-validates as private. Never raw, unchecked user input.
 */

import { generatePassword } from "@/lib/crypto/password";
import { synologyLogin, type ProbeTarget } from "@/lib/nas/discovery";
import type { StoredNasCredentials } from "@/lib/nas/store";
import { synoListShares, synoRequest, toSynologyConn, type SynologyConn } from "@/lib/nas/synology-api";
import { truenasRequest, type TruenasConnection } from "@/lib/nas/truenas-api";

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

/** Derive a stable, NAS-safe service-account name from the provider id. */
function scopedAccountName(providerId: string): string {
  const slug = providerId.replace(/[^a-z0-9]/gi, "").slice(0, 14) || "svc";
  return `iwsvc${slug}`;
}

interface SynoResponse {
  success: boolean;
  error?: { code: number };
}

/** A DSM call that degrades to `success: false` instead of throwing, for the
 *  create/set/grant steps whose failure handling is in-band. */
function synoEntry(conn: SynologyConn, api: string, method: string, params: Record<string, string>): Promise<SynoResponse> {
  return synoRequest<SynoResponse>(conn, api, method, params, PROVISION_TIMEOUT_MS).catch(
    () => ({ success: false }) as SynoResponse,
  );
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
  const conn = toSynologyConn(target, admin);
  const sid = await synologyLogin(conn);
  if (!sid) {
    return { ok: false, error: "Synology admin login failed — check host and admin credentials" };
  }

  const name = scopedAccountName(providerId);
  /** Strong password satisfying typical DSM complexity rules (>=12 chars,
   *  mixed upper/lower/digit/symbol). Never logged. */
  const password = generatePassword({ affix: { prefix: "Iw", suffix: "7#" } });

  // Create the non-admin user. If it already exists, fall back to resetting its
  // password so re-running the wizard is idempotent and yields a known credential.
  const created = await synoEntry(conn, "SYNO.Core.User", "create", {
    version: "1",
    name,
    password,
    description: "InfraWeaver least-privilege service account",
    cannot_chg_passwd: "true",
    _sid: sid,
  });

  if (!created.success) {
    const reset = await synoEntry(conn, "SYNO.Core.User", "set", {
      version: "1",
      name,
      password,
      _sid: sid,
    });
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
  const targetShares =
    shares.length > 0
      ? shares
      : await synoListShares(conn, sid, PROVISION_TIMEOUT_MS)
          .then((found) => found.map((share) => share.name))
          .catch(() => []);
  let warning: string | undefined;
  if (targetShares.length === 0) {
    warning = "Scoped account created, but no shares were found to grant access to — grant read/write in DSM when you add shares.";
  }
  for (const share of targetShares) {
    const perm = await synoEntry(conn, "SYNO.Core.Share.Permission", "set", {
      version: "1",
      name: share,
      user_group_type: "local_user",
      permissions: JSON.stringify([{ name, is_readonly: false, is_writable: true, is_deny: false }]),
      _sid: sid,
    });
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
  const conn: TruenasConnection = {
    host: target.host,
    port: target.port,
    apiKey: admin.apiKey,
    tlsFingerprint256: target.tlsFingerprint256,
    wizardHost: target.wizardHost,
  };
  const name = scopedAccountName(providerId);

  // Idempotent: remove any prior key with the same name before minting a fresh
  // one (TrueNAS only reveals a key value at creation time).
  try {
    const listRes = await truenasRequest<TruenasApiKey[]>(conn, "/api_key", { timeoutMs: PROVISION_TIMEOUT_MS });
    if (listRes.ok) {
      for (const key of listRes.body.filter((k) => k.name === name)) {
        await truenasRequest(conn, `/api_key/id/${key.id}`, {
          method: "DELETE",
          timeoutMs: PROVISION_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    }
  } catch {
    // Non-fatal: if listing fails we still attempt creation below.
  }

  // `api_key_create` is `{name, username, expires_at}` with
  // `additionalProperties: false` — sending the old per-key `allowlist` is a
  // 422. Privilege scoping now comes entirely from `username`.
  try {
    const res = await truenasRequest<{ key?: string }>(conn, "/api_key", {
      method: "POST",
      body: { name, username: admin.scopedUsername },
      timeoutMs: PROVISION_TIMEOUT_MS,
    });
    if (!res.ok) {
      const body: unknown = res.body;
      const detail = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
      return {
        ok: false,
        error:
          `TrueNAS rejected scoped key creation (HTTP ${res.status})` +
          (detail ? `: ${detail.slice(0, 200)}` : ""),
      };
    }
    if (!res.body?.key) {
      return { ok: false, error: "TrueNAS did not return a key value for the scoped API key" };
    }
    const warning =
      admin.scopedUsername === "root" || admin.scopedUsername === "truenas_admin"
        ? `The API key is bound to '${admin.scopedUsername}', so it carries that account's full privileges. ` +
          `Bind it to a dedicated non-admin TrueNAS user to make the stored credential least-privilege.`
        : undefined;
    return { ok: true, credentials: { apiKey: res.body.key }, scopedName: `${name} (user ${admin.scopedUsername})`, warning };
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
