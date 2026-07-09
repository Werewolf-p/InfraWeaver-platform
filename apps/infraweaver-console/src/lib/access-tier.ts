import { INTERNAL_DOMAIN } from "@/lib/domain";
import { tlsSecretForHost } from "@/lib/platform-config";

// Two access tiers only — VPN is retired (the perimeter is identity, not network).
//   internal — served on `*.${INTERNAL_DOMAIN}`, ALWAYS gated by Authentik (forward-auth).
//   public   — served on the base domain; Authentik is opt-in per route.
export type AccessTier = "internal" | "public";

export const ACCESS_TIERS: AccessTier[] = ["internal", "public"];

export const ACCESS_TIER_LABELS: Record<AccessTier, string> = {
  internal: "Internal",
  public: "Public",
};

export function normalizeMiddlewareName(value: string | null | undefined) {
  return (value ?? "").split("/").pop()?.trim().toLowerCase() ?? "";
}

export function isAccessTier(value: unknown): value is AccessTier {
  return value === "internal" || value === "public";
}

/**
 * Resolve a route's access tier from its `infraweaver.io/access-tier` label,
 * falling back to the hostname. Legacy `vpn` / `internal-cluster` labels collapse
 * into `internal` now that VPN is gone. Anything served under the internal domain
 * is internal; everything else is public.
 */
export function detectAccessTier(label: unknown, hosts: string[] = []): AccessTier {
  if (label === "internal" || label === "internal-cluster" || label === "vpn") return "internal";
  if (label === "public") return "public";
  const internalSuffix = `.${INTERNAL_DOMAIN}`.toLowerCase();
  if (hosts.some((host) => host.trim().toLowerCase().includes(internalSuffix))) return "internal";
  return "public";
}

export function accessTierDescription(tier: AccessTier) {
  if (tier === "internal") return "Authentik login required";
  return "Public internet";
}

export function defaultTlsSecretForHost(host: string) {
  return tlsSecretForHost(host);
}

export function accessTierTabs() {
  return [
    { value: "all", label: "All" },
    { value: "internal", label: "Internal" },
    { value: "public", label: "Public" },
  ] as const;
}
