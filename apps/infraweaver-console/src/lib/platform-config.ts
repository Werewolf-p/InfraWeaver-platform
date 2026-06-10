// ─────────────────────────────────────────────────────────────────────────────
// platform-config.ts — the ONE typed home for every fork-specific value.
//
// A fork re-targets the whole platform by editing a single declarative,
// git-backed source: the `identity:` block in InfraWeaver-infra/platform.yaml
// (reconciled by ArgoCD). Code derives hostnames, image refs, OIDC URLs, TLS
// secret names, allowlists, etc. from here instead of repeating literals.
//
// Resolution precedence (server runtime):
//   1. git-backed declarative — `identity:` in platform.yaml (source of truth)
//   2. env override           — existing NEXT_PUBLIC_*/ARGOCD_URL/... vars
//   3. typed code default      — last-resort so the app builds/boots with no infra
//
// IMPORTANT — client vs server:
//   NEXT_PUBLIC_* values are inlined into the CLIENT bundle at build time and
//   cannot be read from git at runtime. So the git overlay (level 1) is applied
//   only by the async, server-only `getPlatformIdentity()`. The SYNC constants
//   and helpers below are the env→default layer (levels 2–3) and are safe to
//   import from client components. This module must NOT statically import any
//   node-only module — the git loader dynamic-imports git-provider/js-yaml.
//
// The sole intentionally-hardcoded value lives elsewhere: FEEDBACK_URL in
// app/api/feedback/route.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import { BASE_DOMAIN, INTERNAL_DOMAIN, internalHost, publicHost } from "@/lib/domain";

// Re-export the sync domain helpers so callers have a single import surface.
export { BASE_DOMAIN, INTERNAL_DOMAIN, internalHost, publicHost };

// ── Typed bootstrap defaults (single source of truth) ────────────────────────
// These are the level-3 fallbacks. They equal today's literals so the default
// deployment behaves identically when no `identity:` block / env is present.

export const DEFAULT_BRAND_NAME = "InfraWeaver";
export const DEFAULT_CLUSTER_ID = "homelab-prod";

/** TLS secret names referenced by IngressRoutes for public vs internal hosts. */
export const DEFAULT_TLS_SECRETS = {
  public: "platform-wildcard-tls",
  internal: "platform-wildcard-int-tls",
} as const;

/** Traefik middleware names that mark an access tier. */
export const DEFAULT_ACCESS_TIER_MIDDLEWARES = {
  vpn: "netbird-vpn-only",
  internal: "internal-only",
} as const;

/** Extra internal hosts (beyond `*.${INTERNAL_DOMAIN}`) allowed for SSRF-guarded fetches. */
export const DEFAULT_INTERNAL_HOST_ALLOWLIST: readonly string[] = [
  "10.25.0.21",
  "10.25.0.135",
  "argocd-server.argocd.svc.cluster.local",
  internalHost("argocd"),
  "grafana.monitoring.svc.cluster.local",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
  "openbao.openbao.svc.cluster.local",
  "prometheus-kube-prometheus-prometheus.monitoring.svc.cluster.local",
  internalHost("registry"),
];

/** Non-app external domains served via the `external-routes` ArgoCD app. */
export const DEFAULT_EXTERNAL_ROUTE_DOMAINS: readonly string[] = [
  "degoudentijd",
  "feestinhetdonker",
  "yonavaarwater.nl",
  "zonnevaarwater.nl",
];

/** Homepage service label → ArgoCD application name. */
export const DEFAULT_HOMEPAGE_SERVICE_MAP: Record<string, string> = {
  ArgoCD: "core-argocd",
  Traefik: "core-traefik",
  Longhorn: "core-longhorn",
  OpenBao: "core-openbao",
  Grafana: "platform-grafana",
  Prometheus: "monitoring-kube-prometheus-stack",
  Authentik: "platform-authentik",
  InfraWeaver: "catalog-infraweaver-console-manifests",
  "Wiki.js": "catalog-wiki-manifests",
  Gatus: "catalog-gatus-manifests",
  OneDev: "catalog-onedev-manifests",
  "Stirling PDF": "catalog-stirling-pdf-manifests",
  "Container Registry": "catalog-registry-manifests",
  [BASE_DOMAIN]: "external-routes",
  ...Object.fromEntries(DEFAULT_EXTERNAL_ROUTE_DOMAINS.map((d) => [d, "external-routes"])),
};

export interface CatalogAppSeed {
  name: string;
  description: string;
  host: string;
  namespace: string;
}

/** Catalog-app fallback used when the git-backed catalog cannot be read. */
export const DEFAULT_CATALOG_APPS: readonly CatalogAppSeed[] = [
  { name: "gatus", description: "Status monitoring", host: internalHost("gatus"), namespace: "gatus" },
  { name: "stirling-pdf", description: "PDF tools", host: internalHost("stirling-pdf"), namespace: "stirling-pdf" },
  { name: "onedev", description: "Git forge + CI", host: publicHost("onedev"), namespace: "onedev" },
  { name: "vaultwarden", description: "Password manager", host: internalHost("vaultwarden"), namespace: "vaultwarden" },
  { name: "jellyfin", description: "Media server", host: internalHost("jellyfin"), namespace: "jellyfin" },
  { name: "n8n", description: "Workflow automation", host: internalHost("n8n"), namespace: "n8n" },
  { name: "actual", description: "Personal finance", host: internalHost("actual"), namespace: "actual" },
];

// ── URL derivations (env override → derived default) ─────────────────────────

/** ArgoCD API base, e.g. https://argocd.int.example.com. */
export function argocdApiBase(): string {
  return process.env.ARGOCD_URL?.trim() || `https://${internalHost("argocd")}`;
}

/** Authentik base URL (in-cluster service by default). */
export function authentikUrl(): string {
  return process.env.AUTHENTIK_URL?.trim() || "http://authentik-server.authentik.svc.cluster.local";
}

/** Authentik OIDC issuer for the console application. */
export function authentikIssuer(): string {
  return (
    process.env.AUTHENTIK_ISSUER?.trim() ||
    `https://${publicHost("auth")}/application/o/infraweaver-console/`
  );
}

/** Private container registry host, e.g. registry.int.example.com. */
export function registryHost(): string {
  return process.env.REGISTRY_HOST?.trim() || internalHost("registry");
}

/** Build an image ref against the private registry, e.g. registry.int.example.com/foo:bar. */
export function registryImageRef(name: string, tag = "latest"): string {
  return `${registryHost()}/${name}:${tag}`;
}

/** Default cluster id used when none is selected. */
export function defaultClusterId(): string {
  return process.env.DEFAULT_CLUSTER_ID?.trim() || DEFAULT_CLUSTER_ID;
}

/** TLS secret name for a host, based on public vs internal domain. */
export function tlsSecretForHost(
  host: string,
  secrets: { public: string; internal: string } = DEFAULT_TLS_SECRETS,
): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return secrets.internal;
  if (normalized.includes(".int.")) return secrets.internal;
  if (normalized === BASE_DOMAIN || normalized.endsWith(`.${BASE_DOMAIN}`)) return secrets.public;
  return secrets.internal;
}

// ── Declarative `identity:` schema (validated at the boundary) ────────────────

const TlsSecretsSchema = z
  .object({ public: z.string().min(1), internal: z.string().min(1) })
  .partial();

const AccessTierMiddlewaresSchema = z
  .object({ vpn: z.string().min(1), internal: z.string().min(1) })
  .partial();

export const PlatformIdentitySchema = z
  .object({
    baseDomain: z.string().min(1),
    brandName: z.string().min(1),
    registryHost: z.string().min(1),
    argocdUrl: z.string().url(),
    authentikUrl: z.string().url(),
    authentikIssuer: z.string().url(),
    defaultCluster: z.string().min(1),
    tlsSecrets: TlsSecretsSchema,
    accessTierMiddlewares: AccessTierMiddlewaresSchema,
    internalHostAllowlist: z.array(z.string().min(1)),
    externalRouteDomains: z.array(z.string().min(1)),
    homepageServiceMap: z.record(z.string(), z.string()),
  })
  .partial();

export type PlatformIdentityInput = z.infer<typeof PlatformIdentitySchema>;

/** Fully-resolved identity — every field present (git → env → default). */
export interface ResolvedPlatformIdentity {
  baseDomain: string;
  brandName: string;
  registryHost: string;
  argocdUrl: string;
  authentikUrl: string;
  authentikIssuer: string;
  defaultCluster: string;
  tlsSecrets: { public: string; internal: string };
  accessTierMiddlewares: { vpn: string; internal: string };
  internalHostAllowlist: string[];
  externalRouteDomains: string[];
  homepageServiceMap: Record<string, string>;
}

/** Identity from env overrides + typed defaults (levels 2–3), no git. */
export function envAndDefaultIdentity(): ResolvedPlatformIdentity {
  return {
    baseDomain: BASE_DOMAIN,
    brandName: process.env.PLATFORM_BRAND_NAME?.trim() || DEFAULT_BRAND_NAME,
    registryHost: registryHost(),
    argocdUrl: argocdApiBase(),
    authentikUrl: authentikUrl(),
    authentikIssuer: authentikIssuer(),
    defaultCluster: defaultClusterId(),
    tlsSecrets: { ...DEFAULT_TLS_SECRETS },
    accessTierMiddlewares: { ...DEFAULT_ACCESS_TIER_MIDDLEWARES },
    internalHostAllowlist: [...DEFAULT_INTERNAL_HOST_ALLOWLIST],
    externalRouteDomains: [...DEFAULT_EXTERNAL_ROUTE_DOMAINS],
    homepageServiceMap: { ...DEFAULT_HOMEPAGE_SERVICE_MAP },
  };
}

/** Overlay validated git-backed identity (level 1) onto the env/default base. */
export function overlayIdentity(base: ResolvedPlatformIdentity, git: PlatformIdentityInput): ResolvedPlatformIdentity {
  return {
    ...base,
    ...(git.baseDomain ? { baseDomain: git.baseDomain } : {}),
    ...(git.brandName ? { brandName: git.brandName } : {}),
    ...(git.registryHost ? { registryHost: git.registryHost } : {}),
    ...(git.argocdUrl ? { argocdUrl: git.argocdUrl } : {}),
    ...(git.authentikUrl ? { authentikUrl: git.authentikUrl } : {}),
    ...(git.authentikIssuer ? { authentikIssuer: git.authentikIssuer } : {}),
    ...(git.defaultCluster ? { defaultCluster: git.defaultCluster } : {}),
    tlsSecrets: { ...base.tlsSecrets, ...(git.tlsSecrets ?? {}) },
    accessTierMiddlewares: { ...base.accessTierMiddlewares, ...(git.accessTierMiddlewares ?? {}) },
    // Collections are ADDITIVE — git entries extend the built-in defaults rather
    // than replace them, so forks add hosts/domains without dropping the
    // service hosts (and NAS hosts) the console relies on.
    internalHostAllowlist: [...new Set([...base.internalHostAllowlist, ...(git.internalHostAllowlist ?? [])])],
    externalRouteDomains: [...new Set([...base.externalRouteDomains, ...(git.externalRouteDomains ?? [])])],
    homepageServiceMap: { ...base.homepageServiceMap, ...(git.homepageServiceMap ?? {}) },
  };
}

// The git-backed resolver `getPlatformIdentity()` lives in the server-only
// module ./platform-config-server (it imports node-only git-provider/js-yaml).
// This file stays sync and client-safe so client components can import the
// constants/helpers above without dragging node:fs into the browser bundle.
