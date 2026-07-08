/**
 * OpenBao-backed registry for dynamically-added NAS providers — SERVER ONLY.
 *
 * Operators add Synology / TrueNAS (and future SMB/NFS) backends through the
 * Storage UI. Each provider's connection details AND its credentials (Synology
 * user/password, TrueNAS API key) are secret, so the whole registry lives in
 * OpenBao at `secret/platform/nas/providers` (KV v2) as a single index object —
 * never in git or a static env var. It is read at request time so a provider
 * saved through the UI is live immediately, without a pod restart.
 *
 * This mirrors `@/lib/udm/store`. The console's OpenBao token needs
 * `create,update,read` on `secret/data/platform/nas/providers` (see infra
 * `bootstrap-openbao.sh`).
 *
 * Built-in providers declared via env (`SYNOLOGY_HOST` / `TRUENAS_HOST`) are
 * resolved separately in `@/lib/nas/providers`; this store only holds the
 * dynamic ones added at runtime.
 */

import { z } from "zod";
import type { NasBackend } from "@/lib/nas/providers";

const KV_MOUNT = process.env.OPENBAO_KV_MOUNT || "secret";
// The registry secret holds BOTH the dynamically-added providers and the list of
// env-declared built-ins the operator has "removed" (`suppressedEnvIds`). Both
// live in this one secret so the console's OpenBao policy needs no extra path
// (it already grants create/read/update on `platform/nas/providers`).
const NAS_LOGICAL_PATH = "platform/nas/providers";
// Flat, ESO-readable per-provider SMB credentials (username/password) live here,
// one secret per provider id. The assign flow's ExternalSecret references this
// path so the SMB CSI driver gets a materialised Secret — creds never touch git.
const NAS_CREDS_PREFIX = "platform/nas/creds";
const VAULT_TIMEOUT_MS = Number(process.env.OPENBAO_TIMEOUT_MS) || 10_000;

/** OpenBao logical path (no mount/`data` prefix) for a provider's SMB creds. */
export function nasCredsLogicalPath(providerId: string): string {
  return `${NAS_CREDS_PREFIX}/${providerId}`;
}

/** Discovery adapters the console knows how to talk to. */
export type NasProviderKind = "synology" | "truenas" | "generic-smb" | "generic-nfs";

/** Per-kind credentials. Only the fields relevant to a provider's kind are set. */
export interface StoredNasCredentials {
  /** Synology: FileStation account. */
  username?: string;
  /** Synology: FileStation password. */
  password?: string;
  /** TrueNAS: API key (Bearer). */
  apiKey?: string;
}

/** A dynamically-added provider as persisted in OpenBao. */
export interface StoredNasProvider {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  kind: NasProviderKind;
  backends: NasBackend[];
  credentials: StoredNasCredentials;
}

const CREDENTIALS_SCHEMA = z.object({
  username: z.string().max(128).optional(),
  password: z.string().max(256).optional(),
  apiKey: z.string().max(1024).optional(),
});

export const STORED_PROVIDER_SCHEMA = z.object({
  id: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "https"]),
  kind: z.enum(["synology", "truenas", "generic-smb", "generic-nfs"]),
  backends: z.array(z.enum(["smb", "nfs"])).min(1),
  credentials: CREDENTIALS_SCHEMA.default({}),
});

const PROVIDER_ID_SCHEMA = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);

const REGISTRY_SCHEMA = z.object({
  providers: z.array(STORED_PROVIDER_SCHEMA).default([]),
  // Ids of env-declared built-ins the operator has removed from the console.
  suppressedEnvIds: z.array(PROVIDER_ID_SCHEMA).default([]),
});

function vaultAuth(): { addr: string; token: string } {
  const addr = (process.env.OPENBAO_ADDR || process.env.VAULT_ADDR || "").replace(/\/+$/, "");
  const token = process.env.OPENBAO_TOKEN || process.env.VAULT_TOKEN || "";
  if (!addr) throw new Error("OPENBAO_ADDR/VAULT_ADDR is not configured");
  if (!token) throw new Error("OPENBAO_TOKEN/VAULT_TOKEN is not configured");
  return { addr, token };
}

/** `logicalPath` is a KV logical path (e.g. `platform/nas/creds/foo`); the KV
 *  mount + `data/` prefix are added here. */
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
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenBao request timed out after ${VAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the dynamically-added providers. A missing secret (404) returns `[]` so
 * callers degrade to "no dynamic providers". Malformed entries are dropped
 * defensively rather than throwing, so one bad row never blanks the registry.
 */
interface NasRegistry {
  providers: StoredNasProvider[];
  suppressedEnvIds: string[];
}

/**
 * Read the whole registry object (providers + env suppression list). A missing
 * secret (404) returns empties. Malformed entries are dropped defensively rather
 * than throwing, so one bad row never blanks the registry.
 */
async function readRegistry(): Promise<NasRegistry> {
  const res = await vaultFetch(NAS_LOGICAL_PATH, { method: "GET" });
  if (res.status === 404) return { providers: [], suppressedEnvIds: [] };
  if (!res.ok) throw new Error(`OpenBao read nas providers failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: unknown } };
  const data = body.data?.data ?? {};
  const parsed = REGISTRY_SCHEMA.safeParse(data);
  if (parsed.success) return parsed.data;
  // Salvage rows individually so a single bad entry doesn't hide the rest.
  const rawProviders = (data as { providers?: unknown[] }).providers;
  const providers: StoredNasProvider[] = [];
  if (Array.isArray(rawProviders)) {
    for (const row of rawProviders) {
      const parsedRow = STORED_PROVIDER_SCHEMA.safeParse(row);
      if (parsedRow.success) providers.push(parsedRow.data);
    }
  }
  const rawIds = (data as { suppressedEnvIds?: unknown[] }).suppressedEnvIds;
  const suppressedEnvIds = Array.isArray(rawIds)
    ? rawIds.filter((x): x is string => PROVIDER_ID_SCHEMA.safeParse(x).success)
    : [];
  return { providers, suppressedEnvIds };
}

/** Write the whole registry object (KV v2 write replaces the whole secret). */
async function writeRegistry(registry: NasRegistry): Promise<void> {
  const res = await vaultFetch(NAS_LOGICAL_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: registry }),
  });
  if (!res.ok) throw new Error(`OpenBao write nas providers failed: ${res.status}`);
}

export async function readStoredNasProviders(): Promise<StoredNasProvider[]> {
  return (await readRegistry()).providers;
}

/**
 * Persist the provider list, preserving the env-suppression list in the same
 * secret (KV v2 replaces the whole secret, so it must be re-supplied).
 */
export async function writeStoredNasProviders(providers: StoredNasProvider[]): Promise<void> {
  const { suppressedEnvIds } = await readRegistry();
  await writeRegistry({ providers, suppressedEnvIds });
}

/**
 * Write a provider's flat SMB credentials (username/password) to its dedicated
 * ESO-readable path. Used for SMB-capable providers whose login credentials ARE
 * the SMB credentials (Synology, generic-smb) so the assign flow's
 * ExternalSecret can materialise the CSI Secret.
 */
export async function writeNasSmbCreds(
  providerId: string,
  creds: { username: string; password: string },
): Promise<void> {
  const res = await vaultFetch(nasCredsLogicalPath(providerId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { username: creds.username, password: creds.password } }),
  });
  if (!res.ok) throw new Error(`OpenBao write nas smb creds failed: ${res.status}`);
}

/** Best-effort removal of a provider's SMB credential secret (data + metadata). */
export async function deleteNasSmbCreds(providerId: string): Promise<void> {
  const { addr, token } = vaultAuth();
  await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${nasCredsLogicalPath(providerId)}`, {
    method: "DELETE",
    headers: { "X-Vault-Token": token },
    signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
  }).catch(() => {
    /* orphaned creds are harmless; never fail a provider delete on cleanup */
  });
}

/**
 * Insert or replace a provider by id, preserving stored credentials when the
 * incoming entry omits them (blank-password "update host/name" flow).
 */
export async function upsertStoredNasProvider(entry: StoredNasProvider): Promise<void> {
  const existing = await readStoredNasProviders();
  const prior = existing.find((p) => p.id === entry.id);
  const merged: StoredNasProvider = {
    ...entry,
    credentials: {
      username: entry.credentials.username ?? prior?.credentials.username,
      password: entry.credentials.password ?? prior?.credentials.password,
      apiKey: entry.credentials.apiKey ?? prior?.credentials.apiKey,
    },
  };
  const next = existing.some((p) => p.id === entry.id)
    ? existing.map((p) => (p.id === entry.id ? merged : p))
    : [...existing, merged];
  await writeStoredNasProviders(next);
}

/** Remove a provider by id. Returns true when a row was actually removed. */
export async function deleteStoredNasProvider(id: string): Promise<boolean> {
  const existing = await readStoredNasProviders();
  const next = existing.filter((p) => p.id !== id);
  if (next.length === existing.length) return false;
  await writeStoredNasProviders(next);
  return true;
}

/**
 * Ids of env-declared built-in providers the operator has removed from the
 * console. Stored alongside the dynamic providers in the same registry secret.
 */
export async function readSuppressedEnvProviderIds(): Promise<string[]> {
  return (await readRegistry()).suppressedEnvIds;
}

/** Tombstone an env-declared provider so it stops appearing in the registry.
 *  Returns true when the id was newly suppressed, false when already suppressed. */
export async function suppressEnvProvider(id: string): Promise<boolean> {
  const registry = await readRegistry();
  if (registry.suppressedEnvIds.includes(id)) return false;
  await writeRegistry({ ...registry, suppressedEnvIds: [...registry.suppressedEnvIds, id] });
  return true;
}

/** Clear an env provider's tombstone (e.g. when it is re-added via the wizard). */
export async function unsuppressEnvProvider(id: string): Promise<void> {
  const registry = await readRegistry();
  if (!registry.suppressedEnvIds.includes(id)) return;
  await writeRegistry({
    ...registry,
    suppressedEnvIds: registry.suppressedEnvIds.filter((x) => x !== id),
  });
}
