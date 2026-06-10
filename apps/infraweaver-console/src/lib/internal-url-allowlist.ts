import { DEFAULT_INTERNAL_HOST_ALLOWLIST, INTERNAL_DOMAIN } from "@/lib/platform-config";

// Single source of truth lives in platform-config; this set is the sync,
// client-safe bootstrap default. Server routes that need the live git-backed
// allowlist read it via getPlatformIdentity().internalHostAllowlist.
const KNOWN_INTERNAL_HOSTS = new Set(DEFAULT_INTERNAL_HOST_ALLOWLIST);

export function isAllowedInternalHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(`.${INTERNAL_DOMAIN}`) || KNOWN_INTERNAL_HOSTS.has(normalized);
}

export function parseAllowedInternalUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (!isAllowedInternalHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}
