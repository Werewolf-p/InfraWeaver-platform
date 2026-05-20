export type AccessTier = "vpn" | "internal" | "public";

export const ACCESS_TIERS: AccessTier[] = ["vpn", "internal", "public"];

export const ACCESS_TIER_LABELS: Record<AccessTier, string> = {
  vpn: "VPN",
  internal: "Internal",
  public: "Public",
};

export const ACCESS_TIER_MIDDLEWARES = {
  vpn: "netbird-vpn-only",
  internal: "internal-only",
} as const;

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
  const normalized = host.trim().toLowerCase();
  if (!normalized) return "platform-wildcard-int-tls";
  if (normalized.includes(".int.")) return "platform-wildcard-int-tls";
  if (normalized === "rlservers.com" || normalized.endsWith(".rlservers.com")) return "rlservers-com-wildcard-tls";
  return "platform-wildcard-int-tls";
}

export function accessTierTabs() {
  return [
    { value: "all", label: "All" },
    { value: "vpn", label: "VPN" },
    { value: "internal", label: "Internal" },
    { value: "public", label: "Public" },
  ] as const;
}
