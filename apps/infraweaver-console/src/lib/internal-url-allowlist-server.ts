// ─────────────────────────────────────────────────────────────────────────────
// internal-url-allowlist-server.ts — SERVER-ONLY dynamic SSRF allowlist.
//
// The sync helpers in `./internal-url-allowlist` only see the compile-time
// `DEFAULT_INTERNAL_HOST_ALLOWLIST`. This module unions:
//   1. env/default bootstrap  (DEFAULT_INTERNAL_HOST_ALLOWLIST)
//   2. git-backed overlay     (getPlatformIdentity().internalHostAllowlist)
//   3. dynamic OpenBao NAS provider hosts (readStoredNasProviders())
// plus the `.${INTERNAL_DOMAIN}` suffix rule, so a NAS box added through the
// Storage wizard is immediately trusted for SSRF-guarded fetches without a
// git edit + rebuild.
//
// Never import from a client component — this pulls in the git provider and
// the OpenBao HTTP client transitively.
// ─────────────────────────────────────────────────────────────────────────────

import { INTERNAL_DOMAIN } from "@/lib/domain";
import { readStoredNasProviders } from "@/lib/nas/store";
import { getPlatformIdentity } from "@/lib/platform-config-server";
import { isPrivateHost } from "@/lib/private-host";

const ALLOWLIST_TTL_MS = 30_000;
let _cache: { hosts: Set<string>; at: number } | null = null;
let _inflight: Promise<Set<string>> | null = null;

/**
 * Full merged allowlist as lower-cased hostnames. Never throws — a dependency
 * outage (Vault / git) degrades to whatever partial layers succeeded plus the
 * static bootstrap list, so a NAS-store outage cannot lock operators out of
 * previously-approved hosts.
 */
export async function getResolvedInternalHosts(): Promise<Set<string>> {
  const now = Date.now();
  if (_cache && now - _cache.at < ALLOWLIST_TTL_MS) return _cache.hosts;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const hosts = new Set<string>();
    const identity = await getPlatformIdentity().catch(() => null);
    if (identity) {
      for (const h of identity.internalHostAllowlist) hosts.add(h.toLowerCase());
    }
    const stored = await readStoredNasProviders().catch(() => []);
    for (const provider of stored) hosts.add(provider.host.toLowerCase());
    _cache = { hosts, at: Date.now() };
    return hosts;
  })().finally(() => {
    _inflight = null;
  });

  return _inflight;
}

/** Reset the resolver cache — call after a wizard save/delete that changes the set. */
export function invalidateInternalHostAllowlist(): void {
  _cache = null;
}

/** Server-authoritative `isAllowedInternalHost`. Mirrors the sync helper's semantics. */
export async function isAllowedInternalHostAsync(hostname: string): Promise<boolean> {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(`.${INTERNAL_DOMAIN}`)) return true;
  const hosts = await getResolvedInternalHosts();
  return hosts.has(normalized);
}

/** Server-authoritative `parseAllowedInternalUrl`. Returns null when disallowed. */
export async function parseAllowedInternalUrlAsync(rawUrl: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (!(await isAllowedInternalHostAsync(url.hostname))) return null;
  return url;
}

/**
 * Wizard-time host check for adding a NEW provider whose host is not yet in
 * the stored allowlist. Accepts the host when it is either already allowed OR
 * unambiguously private (RFC1918/loopback/link-local/`.local`/single-label).
 * The wizard is authenticated + `nas:write`-gated + rate-limited + audit-logged
 * and follows this check with a live save-and-test probe, so this is the
 * narrowest gate that lets self-service work without dropping SSRF protection
 * for public/attacker-controlled targets.
 */
export async function isAllowedInternalHostForWizard(hostname: string): Promise<boolean> {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (await isAllowedInternalHostAsync(normalized)) return true;
  return isPrivateHost(normalized);
}
