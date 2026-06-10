import { DEFAULT_ACCESS_TIER_MIDDLEWARES, tlsSecretForHost } from "@/lib/platform-config";

export type AccessTier = "vpn" | "internal" | "public";

export const ACCESS_TIERS: AccessTier[] = ["vpn", "internal", "public"];

export const ACCESS_TIER_LABELS: Record<AccessTier, string> = {
  vpn: "VPN",
  internal: "Internal",
  public: "Public",
};

// Defined once in platform-config (the single source of truth for fork-specific
// values); re-exported here for back-compat with existing import sites.
export const ACCESS_TIER_MIDDLEWARES = DEFAULT_ACCESS_TIER_MIDDLEWARES;

export function normalizeMiddlewareName(value: string | null | undefined) {
  return (value ?? "").split("/").pop()?.trim().toLowerCase() ?? "";
}

export function isAccessTier(value: unknown): value is AccessTier {
  return value === "vpn" || value === "internal" || value === "public";
}

export function detectAccessTier(label: unknown, middlewares: string[]): AccessTier {
  if (isAccessTier(label)) return label;

  const normalized = middlewares.map((middleware) => normalizeMiddlewareName(middleware));
  if (normalized.includes(ACCESS_TIER_MIDDLEWARES.vpn)) return "vpn";
  if (normalized.includes(ACCESS_TIER_MIDDLEWARES.internal)) return "internal";
  return "public";
}

export function accessTierDescription(tier: AccessTier) {
  if (tier === "vpn") return "VPN required";
  if (tier === "internal") return "Homelab LAN only";
  return "Public internet";
}

export function defaultTlsSecretForHost(host: string) {
  return tlsSecretForHost(host);
}

export function accessTierTabs() {
  return [
    { value: "all", label: "All" },
    { value: "vpn", label: "VPN" },
    { value: "internal", label: "Internal" },
    { value: "public", label: "Public" },
  ] as const;
}
