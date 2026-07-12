/**
 * Mount credentials: bridge between a NAS provider's *management* credential and
 * the *mount* credential the CSI driver needs. SERVER ONLY.
 *
 * A provider is registered with whatever the appliance authenticates its API
 * with — a TrueNAS API key, a Synology DSM login. None of that is usable by
 * `smb.csi.k8s.io`, which speaks SMB and wants a username and password.
 *
 * This module resolves that gap once, per provider, by ensuring a pair of scoped
 * SMB service accounts exists (`iw-<provider>-ro`, `iw-<provider>-rw`) and
 * persisting their credentials to OpenBao at `platform/nas/creds/<id>-<ro|rw>`.
 * The mount flow then emits an ExternalSecret per (namespace, access) pointing
 * at that path — so a namespace mounting a folder read-only never receives the
 * read-write password.
 *
 * Idempotent and lazy: `ensureProviderSmbCredentials` returns the already-stored
 * pair when it exists, and only touches the appliance when it must mint them.
 * `force` re-mints (password rotation).
 */

import { generatePassword } from "@/lib/crypto/password";
import {
  ensureTruenasSmbAccounts,
  smbAccountName,
  type NasSmbAccounts,
} from "@/lib/nas/smb-accounts";
import { synologyLogin } from "@/lib/nas/discovery";
import { fetchNasService } from "@/lib/nas/pinned-fetch";
import type { ResolvedNasProvider } from "@/lib/nas/providers";
import {
  readNasSmbCreds,
  writeNasSmbCreds,
  type StoredNasCredentials,
} from "@/lib/nas/store";
import type { TruenasConnection } from "@/lib/nas/truenas-api";

export class NasMountCredentialsError extends Error {
  readonly code = "NAS_MOUNT_CREDENTIALS";
  constructor(message: string) {
    super(message);
    this.name = "NasMountCredentialsError";
  }
}

export function truenasConnectionFor(
  provider: ResolvedNasProvider,
  credentials: StoredNasCredentials,
): TruenasConnection {
  if (!credentials.apiKey) {
    throw new NasMountCredentialsError(`Provider '${provider.id}' has no stored TrueNAS API key`);
  }
  return {
    host: provider.host,
    port: provider.port,
    apiKey: credentials.apiKey,
    tlsFingerprint256: provider.tlsFingerprint256,
  };
}

/** Read both scoped credential pairs from OpenBao, or null when either is missing. */
async function readStoredPair(providerId: string): Promise<NasSmbAccounts | null> {
  const [readonly, readwrite] = await Promise.all([
    readNasSmbCreds(providerId, "readonly"),
    readNasSmbCreds(providerId, "readwrite"),
  ]);
  if (!readonly || !readwrite) return null;
  return { readonly, readwrite };
}

async function persistPair(providerId: string, accounts: NasSmbAccounts): Promise<void> {
  await writeNasSmbCreds(providerId, "readonly", accounts.readonly);
  await writeNasSmbCreds(providerId, "readwrite", accounts.readwrite);
}

interface SynoResponse {
  success: boolean;
  error?: { code: number };
}

async function synoEntry(
  provider: ResolvedNasProvider,
  params: Record<string, string>,
): Promise<SynoResponse> {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const res = await fetchNasService(
    `https://${provider.host}:${provider.port}/webapi/entry.cgi?${query}`,
    { timeoutMs: 8000 },
    { pin: provider.tlsFingerprint256 },
  );
  return (await res.json()) as SynoResponse;
}

/**
 * Synology equivalent of the TrueNAS pair. DSM has no per-folder ACL API worth
 * relying on, so scoping is done at the *share* level: the RO account is granted
 * read-only on the share, the RW account read-write. Folder-level separation for
 * Synology therefore rests on the CSI `subDir` mount plus the kernel `ro` flag,
 * which is weaker than the TrueNAS path — say so rather than pretend otherwise.
 */
async function ensureSynologySmbAccounts(
  provider: ResolvedNasProvider,
  credentials: StoredNasCredentials,
  share: string,
): Promise<NasSmbAccounts> {
  const sid = await synologyLogin({
    host: provider.host,
    port: provider.port,
    tlsFingerprint256: provider.tlsFingerprint256,
    user: credentials.username ?? "",
    password: credentials.password ?? "",
  });
  if (!sid) throw new NasMountCredentialsError("Synology login failed — check the provider's stored credentials");

  // `Iw…7#` affixes guarantee every SMB complexity class; the random core stays
  // full-alphanumeric (the charset the old base64url derivation produced).
  const makePassword = () =>
    generatePassword({
      length: 20,
      alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      affix: { prefix: "Iw", suffix: "7#" },
    });

  const accounts = {} as NasSmbAccounts;
  for (const access of ["readonly", "readwrite"] as const) {
    const username = smbAccountName(provider.id, access);
    const password = makePassword();
    const created = await synoEntry(provider, {
      api: "SYNO.Core.User", version: "1", method: "create",
      name: username, password, description: "InfraWeaver NAS mount service account",
      cannot_chg_passwd: "true", _sid: sid,
    }).catch(() => ({ success: false }) as SynoResponse);
    if (!created.success) {
      const reset = await synoEntry(provider, {
        api: "SYNO.Core.User", version: "1", method: "set", name: username, password, _sid: sid,
      }).catch(() => ({ success: false }) as SynoResponse);
      if (!reset.success) {
        throw new NasMountCredentialsError(`Could not create or update Synology account '${username}'`);
      }
    }
    const readOnly = access === "readonly";
    const perm = await synoEntry(provider, {
      api: "SYNO.Core.Share.Permission", version: "1", method: "set",
      name: share, user_group_type: "local_user",
      permissions: JSON.stringify([{ name: username, is_readonly: readOnly, is_writable: !readOnly, is_deny: false }]),
      _sid: sid,
    }).catch(() => ({ success: false }) as SynoResponse);
    if (!perm.success) {
      throw new NasMountCredentialsError(
        `Synology account '${username}' was created but could not be granted ${readOnly ? "read" : "write"} access on share '${share}'. Grant it in DSM (Control Panel → Shared Folder → Edit → Permissions).`,
      );
    }
    accounts[access] = { username, password };
  }
  return accounts;
}

/**
 * The scoped SMB credential pair for a provider, minting it on the appliance the
 * first time it is needed. Returns the credentials so the caller can grant them
 * ACLs; they are persisted to OpenBao here and must never reach an HTTP response.
 *
 * `share` is only consulted for Synology, whose scoping is share-level.
 */
export async function ensureProviderSmbCredentials(
  provider: ResolvedNasProvider,
  credentials: StoredNasCredentials,
  options: { share: string; force?: boolean },
): Promise<NasSmbAccounts> {
  if (!options.force) {
    const stored = await readStoredPair(provider.id);
    if (stored) return stored;
  }

  if (provider.kind === "truenas") {
    const accounts = await ensureTruenasSmbAccounts(truenasConnectionFor(provider, credentials), provider.id);
    await persistPair(provider.id, accounts);
    return accounts;
  }

  if (provider.kind === "synology") {
    const accounts = await ensureSynologySmbAccounts(provider, credentials, options.share);
    await persistPair(provider.id, accounts);
    return accounts;
  }

  if (provider.kind === "generic-smb") {
    // A generic SMB target exposes no account-management API, so both access
    // modes necessarily share the operator-supplied credential. Read-only is
    // then enforced by the kernel mount and the pod's `readOnly: true` alone —
    // Layer A is absent. Documented, not silently equivalent.
    if (!credentials.username || !credentials.password) {
      throw new NasMountCredentialsError(`Provider '${provider.id}' has no stored SMB username/password`);
    }
    const single = { username: credentials.username, password: credentials.password };
    const accounts: NasSmbAccounts = { readonly: single, readwrite: single };
    await persistPair(provider.id, accounts);
    return accounts;
  }

  throw new NasMountCredentialsError(
    `Provider kind '${provider.kind}' does not use SMB credentials (NFS uses host-based export ACLs)`,
  );
}
