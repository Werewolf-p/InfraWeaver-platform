import { Hono } from 'hono';
import { getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

/**
 * DNS route — Traefik IngressRoute inspection and DNS preset catalogue
 *
 * GET  /api/v1/dns/traefik-routes   — list all IngressRoutes with extracted hosts + access metadata
 * GET  /api/v1/dns/presets          — predefined DNS/IngressRoute preset templates
 * POST /api/v1/dns/from-traefik     — derive DNS record bodies from live IngressRoutes (preview / sync helper)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Access tier as annotated on IngressRoutes */
type AccessTier = "internal" | "external" | "vpn" | "unknown";

/** A host extracted from an IngressRoute match rule */
interface TraefikHost {
  /** The full FQDN, e.g. "adguard.int.rlservers.com" */
  fqdn: string;
  /** "internal", "external", "vpn", or "unknown" */
  accessTier: AccessTier;
  /** IngressRoute name */
  routeName: string;
  /** Namespace the IngressRoute lives in */
  namespace: string;
  /** Backing k8s services referenced by this route */
  services: Array<{ name: string; namespace: string; port: number | string }>;
  /** TLS secret used, if any */
  tlsSecret?: string;
  /** Entry points (websecure, web, …) */
  entryPoints: string[];
  /** Middlewares applied */
  middlewares: string[];
}

/** Synthesised DNS record suggestion */
interface DnsRecordSuggestion {
  fqdn: string;
  type: "A" | "CNAME";
  /** The value to point at (IP or CNAME target) */
  value: string;
  /** TTL in seconds */
  ttl: number;
  /** Whether Cloudflare should proxy the record */
  proxied: boolean;
  accessTier: AccessTier;
  /** True if a matching Cloudflare record already exists (filled in by the console) */
  exists?: boolean;
}

// ── Preset catalogue ──────────────────────────────────────────────────────────

/** A preset describes a typical IngressRoute + DNS pattern */
interface DnsPreset {
  id: string;
  label: string;
  description: string;
  category: "internal" | "external" | "vpn" | "game" | "dev";
  /** IngressRoute template fields */
  template: {
    entryPoints: string[];
    middlewares: Array<{ name: string; namespace: string }>;
    tlsSecret: string;
    accessTierLabel: AccessTier;
    /** Domain suffix to use */
    domainSuffix: string;
  };
  /** DNS record template */
  dns: {
    type: "A" | "CNAME";
    /** Placeholder target; console fills in actual IP/CNAME */
    targetPlaceholder: string;
    ttl: number;
    proxied: boolean;
  };
  /** Optional: extra annotations or notes for the user */
  notes?: string;
}

const PRESETS: DnsPreset[] = [
  {
    id: "internal-service",
    label: "Internal Service",
    description: "VPN / LAN-only service behind the internal wildcard cert. Accessible only from the internal network.",
    category: "internal",
    template: {
      entryPoints: ["websecure"],
      middlewares: [
        { name: "secure-headers", namespace: "traefik" },
        { name: "internal-only", namespace: "traefik" },
      ],
      tlsSecret: "platform-wildcard-int-tls",
      accessTierLabel: "internal",
      domainSuffix: "int.rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "10.10.0.200",
      ttl: 120,
      proxied: false,
    },
    notes: "Use for dashboards, admin panels, or any service that must not be internet-reachable.",
  },
  {
    id: "external-service",
    label: "External / Public Service",
    description: "Publicly accessible service proxied through Cloudflare with DDoS protection.",
    category: "external",
    template: {
      entryPoints: ["websecure"],
      middlewares: [
        { name: "secure-headers", namespace: "traefik" },
        { name: "rate-limit", namespace: "traefik" },
      ],
      tlsSecret: "platform-wildcard-tls",
      accessTierLabel: "external",
      domainSuffix: "rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "<public-ipv4>",
      ttl: 1,
      proxied: true,
    },
    notes: "Cloudflare proxied (orange cloud). Ensure origin rules allow Cloudflare IPs only.",
  },
  {
    id: "vpn-only",
    label: "VPN-Only Service",
    description: "Service accessible exclusively via NetBird VPN — not reachable from LAN or internet.",
    category: "vpn",
    template: {
      entryPoints: ["websecure"],
      middlewares: [
        { name: "secure-headers", namespace: "traefik" },
        { name: "vpn-only", namespace: "traefik" },
      ],
      tlsSecret: "platform-wildcard-int-tls",
      accessTierLabel: "vpn",
      domainSuffix: "int.rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "100.64.0.1",
      ttl: 120,
      proxied: false,
    },
    notes: "VPN IP range is 100.64.0.0/10 (NetBird). Verify the vpn-only middleware exists in Traefik.",
  },
  {
    id: "media-service",
    label: "Media / Streaming Service",
    description: "Optimised for Plex, Jellyfin, and similar services — WebSocket support, large response buffers.",
    category: "internal",
    template: {
      entryPoints: ["websecure"],
      middlewares: [
        { name: "secure-headers", namespace: "traefik" },
        { name: "internal-only", namespace: "traefik" },
      ],
      tlsSecret: "platform-wildcard-int-tls",
      accessTierLabel: "internal",
      domainSuffix: "int.rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "10.10.0.200",
      ttl: 120,
      proxied: false,
    },
    notes: "Enable sticky sessions on the Traefik service if using multiple replicas.",
  },
  {
    id: "game-server",
    label: "Game Server (TCP/UDP)",
    description: "Raw TCP/UDP IngressRoute for game servers. Uses Traefik TCP router — no HTTP middleware.",
    category: "game",
    template: {
      entryPoints: ["minecraft", "valheim", "custom-game"],
      middlewares: [],
      tlsSecret: "",
      accessTierLabel: "external",
      domainSuffix: "rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "<public-ipv4>",
      ttl: 60,
      proxied: false,
    },
    notes: "Game servers need direct IPs — do NOT proxy through Cloudflare (orange cloud). DNS-only.",
  },
  {
    id: "dev-service",
    label: "Development / Staging Service",
    description: "Internal service on the dev sub-domain. Not production — for testing and staging only.",
    category: "dev",
    template: {
      entryPoints: ["websecure"],
      middlewares: [
        { name: "secure-headers", namespace: "traefik" },
        { name: "internal-only", namespace: "traefik" },
        { name: "auth-forward", namespace: "traefik" },
      ],
      tlsSecret: "platform-wildcard-int-tls",
      accessTierLabel: "internal",
      domainSuffix: "dev.int.rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "10.10.0.200",
      ttl: 60,
      proxied: false,
    },
    notes: "Staging routes often benefit from auth-forward middleware to gate access.",
  },
  {
    id: "api-service",
    label: "API Service",
    description: "Public REST / GraphQL API endpoint with CORS and rate-limiting pre-configured.",
    category: "external",
    template: {
      entryPoints: ["websecure"],
      middlewares: [
        { name: "secure-headers", namespace: "traefik" },
        { name: "rate-limit", namespace: "traefik" },
        { name: "cors-api", namespace: "traefik" },
      ],
      tlsSecret: "platform-wildcard-tls",
      accessTierLabel: "external",
      domainSuffix: "rlservers.com",
    },
    dns: {
      type: "A",
      targetPlaceholder: "<public-ipv4>",
      ttl: 1,
      proxied: true,
    },
    notes: "Ensure the cors-api middleware allows your frontend origin. Rate-limit is 200 req/min by default.",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract FQDNs from a Traefik match rule like `Host(`foo.example.com`) && PathPrefix(`/`)` */
function extractHostsFromMatch(match: string): string[] {
  const pattern = /Host\(`([^`]+)`\)/g;
  const hosts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(match)) !== null) {
    hosts.push(m[1].toLowerCase());
  }
  return hosts;
}

function resolveAccessTier(labels?: Record<string, string>): AccessTier {
  const tier = labels?.["infraweaver.io/access-tier"];
  if (tier === "internal" || tier === "external" || tier === "vpn") return tier;
  return "unknown";
}

// ── Route ─────────────────────────────────────────────────────────────────────

export const dnsRoute = new Hono<AppBindings>();

/**
 * GET /api/v1/dns/traefik-routes
 * Returns all Traefik IngressRoutes in the cluster with extracted host information.
 */
dnsRoute.get("/traefik-routes", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user, "config:read")) return c.json({ error: "Forbidden" }, 403);

  try {
    const customApi = await getCustomApiForCluster(user.clusterId);
    const resp = await customApi.listClusterCustomObject({
      group: "traefik.io",
      version: "v1alpha1",
      plural: "ingressroutes",
    }) as { items?: unknown[] };

    const routes: TraefikHost[] = [];

    for (const item of resp.items ?? []) {
      const ir = item as {
        metadata?: {
          name?: string;
          namespace?: string;
          labels?: Record<string, string>;
        };
        spec?: {
          entryPoints?: string[];
          routes?: Array<{
            match?: string;
            middlewares?: Array<{ name?: string; namespace?: string }>;
            services?: Array<{ name?: string; namespace?: string; port?: number | string }>;
          }>;
          tls?: { secretName?: string };
        };
      };

      const name = ir.metadata?.name ?? "";
      const namespace = ir.metadata?.namespace ?? "";
      const accessTier = resolveAccessTier(ir.metadata?.labels);
      const tlsSecret = ir.spec?.tls?.secretName;
      const entryPoints = ir.spec?.entryPoints ?? [];

      for (const specRoute of ir.spec?.routes ?? []) {
        const hosts = extractHostsFromMatch(specRoute.match ?? "");
        const services = (specRoute.services ?? []).map((s) => ({
          name: s.name ?? "",
          namespace: s.namespace ?? namespace,
          port: s.port ?? 80,
        }));
        const middlewares = (specRoute.middlewares ?? []).map(
          (mw) => `${mw.namespace ?? namespace}/${mw.name ?? ""}`,
        );

        for (const fqdn of hosts) {
          routes.push({
            fqdn,
            accessTier,
            routeName: name,
            namespace,
            services,
            tlsSecret,
            entryPoints,
            middlewares,
          });
        }
      }
    }

    // Sort: internal first, then by FQDN
    routes.sort((a, b) => {
      const tierOrder: Record<AccessTier, number> = { internal: 0, vpn: 1, external: 2, unknown: 3 };
      const tierDiff = (tierOrder[a.accessTier] ?? 3) - (tierOrder[b.accessTier] ?? 3);
      return tierDiff !== 0 ? tierDiff : a.fqdn.localeCompare(b.fqdn);
    });

    return c.json({
      total: routes.length,
      routes,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Failed to list IngressRoutes", detail: msg }, 500);
  }
});

/**
 * GET /api/v1/dns/presets
 * Returns the predefined DNS / IngressRoute preset catalogue.
 */
dnsRoute.get("/presets", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user, "config:read")) return c.json({ error: "Forbidden" }, 403);

  const { category } = c.req.query() as { category?: string };
  const filtered = category
    ? PRESETS.filter((p) => p.category === category)
    : PRESETS;

  return c.json({ presets: filtered, total: filtered.length });
});

/**
 * POST /api/v1/dns/from-traefik
 * Body: { targetIp?: string; internalIp?: string; externalIp?: string }
 * Reads live IngressRoutes and returns suggested DNS record bodies.
 * The console can present these as a preview before calling the Cloudflare API.
 */
dnsRoute.post("/from-traefik", async (c) => {
  const user = c.get("user");
  if (!hasPermission(user, "config:write")) return c.json({ error: "Forbidden" }, 403);

  const body = await c.req.json().catch(() => ({})) as {
    internalIp?: string;
    externalIp?: string;
  };

  const internalIp = body.internalIp ?? "10.10.0.200";
  const externalIp = body.externalIp ?? "";

  try {
    const customApi = await getCustomApiForCluster(user.clusterId);
    const resp = await customApi.listClusterCustomObject({
      group: "traefik.io",
      version: "v1alpha1",
      plural: "ingressroutes",
    }) as { items?: unknown[] };

    const suggestions: DnsRecordSuggestion[] = [];

    for (const item of resp.items ?? []) {
      const ir = item as {
        metadata?: { labels?: Record<string, string> };
        spec?: {
          routes?: Array<{ match?: string }>;
          tls?: { secretName?: string };
        };
      };

      const accessTier = resolveAccessTier(ir.metadata?.labels);

      for (const specRoute of ir.spec?.routes ?? []) {
        const hosts = extractHostsFromMatch(specRoute.match ?? "");

        for (const fqdn of hosts) {
          // Skip wildcard or non-FQDN entries
          if (fqdn.startsWith("*") || !fqdn.includes(".")) continue;

          const isExternal = accessTier === "external";
          const resolvedIp = isExternal ? externalIp : internalIp;

          if (!resolvedIp) continue; // skip if no IP provided for this tier

          suggestions.push({
            fqdn,
            type: "A",
            value: resolvedIp,
            ttl: isExternal ? 1 : 120,
            proxied: isExternal,
            accessTier,
          });
        }
      }
    }

    // Deduplicate by FQDN (keep first occurrence)
    const seen = new Set<string>();
    const deduped = suggestions.filter((s) => {
      if (seen.has(s.fqdn)) return false;
      seen.add(s.fqdn);
      return true;
    });

    deduped.sort((a, b) => a.fqdn.localeCompare(b.fqdn));

    return c.json({
      total: deduped.length,
      internalIp,
      externalIp: externalIp || null,
      suggestions: deduped,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return c.json({ error: "Failed to derive DNS records from Traefik", detail: msg }, 500);
  }
});
