// NAS provider registry — extensibility hook so future backends (Nextcloud
// storage, Ceph RGW, MinIO, other Synology units, additional TrueNAS heads,
// self-hosted NFS, etc.) can be added without touching the assign / mount /
// mounts / breakdown pipelines.
//
// A "provider" here is the endpoint the console talks to for discovery
// (shares/folders) plus the host used when synthesising SMB mount sources.
// It is intentionally decoupled from the *storage backend* (SMB CSI, NFS CSI,
// democratic-csi …) so a provider can advertise multiple backends in the
// future.
//
// Registration model
// ------------------
// - Built-in providers (Synology, TrueNAS) are declared here and enabled when
//   the matching env vars are set — no config file needed for the common case.
// - Extra providers can be declared via the `NAS_PROVIDERS_JSON` env var, a
//   JSON array of `NasProviderConfig` objects (schema validated at load time).
//   This keeps the console self-configuring in a fresh cluster and lets a
//   future PR wire "add provider" through the UI by appending to that array.
// - Nothing in this file talks to Kubernetes; it is pure config resolution.

import { z } from "zod";
import {
  readStoredNasProviders,
  readSuppressedEnvProviderIds,
  type StoredNasCredentials,
  type StoredNasProvider,
} from "@/lib/nas/store";

/** Storage backends the assign/mount pipeline knows how to render. */
export type NasBackend = "smb" | "nfs";

/** Provider config as either declared in-code or loaded from JSON. */
export interface NasProviderConfig {
  /** Stable, url-safe identifier (`synology`, `truenas`, `synology-nvr`, …). */
  id: string;
  /** Human-readable name for the UI. */
  name: string;
  /** Hostname or IP used for CSI mount sources and probe URLs. */
  host: string;
  /** Discovery API port (HTTPS). */
  port: number;
  /** Discovery API protocol. */
  protocol: "http" | "https";
  /**
   * How the console enumerates shares/folders. Adding a new kind means adding
   * a discovery adapter in `src/app/api/nas/{shares,folders}/route.ts`.
   */
  kind: "synology" | "truenas" | "generic-smb" | "generic-nfs";
  /** Storage backends this provider advertises. Order = display order. */
  backends: NasBackend[];
  /**
   * Env var whose presence gates whether the provider is `enabled`. A missing
   * gate means the provider is always enabled once declared.
   */
  enabledEnv?: string;
}

const PROVIDER_SCHEMA = z.object({
  id: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "https"]),
  kind: z.enum(["synology", "truenas", "generic-smb", "generic-nfs"]),
  backends: z.array(z.enum(["smb", "nfs"])).min(1),
  enabledEnv: z.string().min(1).max(80).optional(),
});

const PROVIDERS_JSON_SCHEMA = z.array(PROVIDER_SCHEMA);

function builtInProviders(env: NodeJS.ProcessEnv): NasProviderConfig[] {
  const providers: NasProviderConfig[] = [];
  if (env.SYNOLOGY_HOST) {
    providers.push({
      id: "synology",
      name: "Synology NAS",
      host: env.SYNOLOGY_HOST,
      port: parseInt(env.SYNOLOGY_PORT ?? "5001", 10),
      protocol: "https",
      kind: "synology",
      backends: ["smb"],
      enabledEnv: "SYNOLOGY_PASSWORD",
    });
  }
  if (env.TRUENAS_HOST) {
    providers.push({
      id: "truenas",
      name: "TrueNAS Scale",
      host: env.TRUENAS_HOST,
      port: 443,
      protocol: "https",
      kind: "truenas",
      backends: ["smb", "nfs"],
      enabledEnv: "TRUENAS_API_KEY",
    });
  }
  return providers;
}

let cached: NasProviderConfig[] | null = null;

/**
 * Resolved provider list from env + built-ins.
 *
 * Safe to call from any request path; result is memoised so repeated calls in
 * the same process (e.g. from provider/shares/folders routes in the same
 * request) share one parse. Reset with `resetProviderRegistry()` in tests.
 */
export function listProviderConfigs(env: NodeJS.ProcessEnv = process.env): NasProviderConfig[] {
  if (cached) return cached;
  const declared = builtInProviders(env);
  const extraRaw = env.NAS_PROVIDERS_JSON?.trim();
  if (extraRaw) {
    try {
      const parsed = PROVIDERS_JSON_SCHEMA.parse(JSON.parse(extraRaw));
      // Later declarations override earlier ones on ID collision so operators
      // can retarget a built-in provider without patching this file.
      const byId = new Map(declared.map((provider) => [provider.id, provider]));
      for (const extra of parsed) byId.set(extra.id, extra);
      cached = [...byId.values()];
      return cached;
    } catch (error) {
      // Never let a malformed provider spec take down the API; log via
      // console.error and fall back to built-ins.
      // eslint-disable-next-line no-console
      console.error("NAS_PROVIDERS_JSON is invalid, ignoring:", error);
    }
  }
  cached = declared;
  return cached;
}

export function getProviderConfig(id: string, env: NodeJS.ProcessEnv = process.env): NasProviderConfig | undefined {
  return listProviderConfigs(env).find((provider) => provider.id === id);
}

export function isProviderEnabled(provider: NasProviderConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return provider.enabledEnv ? Boolean(env[provider.enabledEnv]) : true;
}

/** Test-only helper: clears the memoised list so a new env can be exercised. */
export function resetProviderRegistry() {
  cached = null;
}

// ---------------------------------------------------------------------------
// Dynamic (OpenBao-backed) provider resolution.
//
// The functions above resolve *static* providers (env + NAS_PROVIDERS_JSON) and
// stay synchronous so existing call sites are untouched. The functions below
// merge those with *dynamic* providers added through the Storage UI and stored
// in OpenBao (`@/lib/nas/store`). They are async (OpenBao is read at request
// time) and are the resolver every NAS route should prefer.
// ---------------------------------------------------------------------------

export interface ResolvedNasProvider extends NasProviderConfig {
  /** Where this provider came from — an env/JSON built-in, or the OpenBao registry. */
  source: "env" | "openbao";
  /** True when usable credentials are available (env vars or stored secret). */
  hasCredentials: boolean;
}

/** Strip credentials off a stored provider to get its public config shape. */
function toProviderConfig(stored: StoredNasProvider): NasProviderConfig {
  return {
    id: stored.id,
    name: stored.name,
    host: stored.host,
    port: stored.port,
    protocol: stored.protocol,
    kind: stored.kind,
    backends: stored.backends,
  };
}

/** Whether a stored provider's persisted credentials are complete for its kind. */
function storedHasCredentials(stored: StoredNasProvider): boolean {
  if (stored.kind === "synology") return Boolean(stored.credentials.username && stored.credentials.password);
  if (stored.kind === "truenas") return Boolean(stored.credentials.apiKey);
  return true; // generic-smb / generic-nfs use host-based auth
}

/** Credentials for a built-in (env-declared) provider, from the standard env vars. */
function envCredentials(id: string, env: NodeJS.ProcessEnv): StoredNasCredentials | null {
  if (id === "synology" && env.SYNOLOGY_PASSWORD) {
    return { username: env.SYNOLOGY_USER ?? "", password: env.SYNOLOGY_PASSWORD };
  }
  if (id === "truenas" && env.TRUENAS_API_KEY) {
    return { apiKey: env.TRUENAS_API_KEY };
  }
  return null;
}

/**
 * Full provider list: env/JSON built-ins overlaid with OpenBao-stored dynamic
 * providers. On id collision the stored entry wins, so an operator can retarget
 * a built-in through the UI. Never throws on an OpenBao outage — it degrades to
 * the static list so the Storage page still renders.
 */
export async function resolveNasProviders(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedNasProvider[]> {
  const [stored, suppressedEnvIds] = await Promise.all([
    readStoredNasProviders().catch(() => [] as StoredNasProvider[]),
    readSuppressedEnvProviderIds().catch(() => [] as string[]),
  ]);
  const storedById = new Map(stored.map((s) => [s.id, s]));
  const suppressed = new Set(suppressedEnvIds);

  const merged = new Map<string, ResolvedNasProvider>();
  for (const builtIn of listProviderConfigs(env)) {
    // An env provider the operator "deleted" is tombstoned and hidden — unless a
    // stored (OpenBao) provider re-uses the same id, in which case the loop below
    // re-adds it as a real dynamic provider.
    if (suppressed.has(builtIn.id) && !storedById.has(builtIn.id)) continue;
    merged.set(builtIn.id, {
      ...builtIn,
      source: "env",
      hasCredentials: Boolean(envCredentials(builtIn.id, env)),
    });
  }
  for (const s of storedById.values()) {
    merged.set(s.id, {
      ...toProviderConfig(s),
      source: "openbao",
      hasCredentials: storedHasCredentials(s),
    });
  }
  return [...merged.values()];
}

/** Resolve a single provider by id from the merged (env + OpenBao) registry. */
export async function getResolvedNasProvider(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedNasProvider | undefined> {
  return (await resolveNasProviders(env)).find((p) => p.id === id);
}

/**
 * Resolve usable credentials for a provider id: prefer the OpenBao-stored secret
 * (dynamic providers, or a retargeted built-in), else fall back to the built-in
 * env vars. Returns null when no credentials exist. SERVER ONLY.
 */
export async function resolveNasCredentials(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StoredNasCredentials | null> {
  const stored = await readStoredNasProviders().catch(() => [] as StoredNasProvider[]);
  const match = stored.find((p) => p.id === id);
  if (match && storedHasCredentials(match)) return match.credentials;
  return envCredentials(id, env);
}
