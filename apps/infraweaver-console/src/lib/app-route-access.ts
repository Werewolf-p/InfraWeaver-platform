import type { AccessTier } from "@/lib/access-tier";

export interface RouteAccessCandidate {
  name: string;
  hosts: string[];
  accessTier: AccessTier;
}

export interface AppRouteAccessMatch {
  tier: AccessTier;
  host: string | null;
  routeName: string;
}

export interface AppRouteAccessSummary {
  matches: AppRouteAccessMatch[];
  tiers: AccessTier[];
  primaryHost: string | null;
}

function extractHost(value: string) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function appNeedles(values: Array<string | null | undefined>) {
  const results = new Set<string>();
  for (const value of values) {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) continue;
    results.add(normalized);
    let current = normalized;
    for (const prefix of ["platform-", "apps-", "catalog-", "community-"]) {
      if (current.startsWith(prefix)) {
        current = current.slice(prefix.length);
        results.add(current);
      }
    }
    for (const suffix of ["-manifests", "-manifest", "-app", "-apps"]) {
      if (current.endsWith(suffix)) {
        results.add(current.slice(0, -suffix.length));
      }
    }
    if (current.includes("-")) {
      for (const part of current.split("-")) {
        if (part.length > 2) results.add(part);
      }
    }
  }
  return Array.from(results);
}

function routeScore(route: RouteAccessCandidate, needles: string[], hosts: string[]) {
  let score = 0;
  const routeName = route.name.toLowerCase();
  const routeHosts = route.hosts.map((host) => host.toLowerCase());

  for (const host of hosts) {
    if (routeHosts.includes(host)) score = Math.max(score, 100);
  }
  for (const needle of needles) {
    if (routeHosts.some((host) => host.includes(needle))) score = Math.max(score, 80);
    if (routeName === needle || routeName.startsWith(`${needle}-`) || routeName.includes(needle)) score = Math.max(score, 60);
  }

  return score;
}

export function resolveAppRouteAccess(
  routes: RouteAccessCandidate[],
  values: { name: string; argoName?: string; ingressHost?: string; urls?: string[] },
): AppRouteAccessSummary {
  const hosts = [values.ingressHost, ...(values.urls ?? []).map(extractHost)]
    .map((host) => host?.toLowerCase() ?? null)
    .filter((host): host is string => Boolean(host));
  const needles = appNeedles([values.name, values.argoName, ...hosts]);

  const matches = routes
    .map((route) => ({ route, score: routeScore(route, needles, hosts) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.route.name.localeCompare(right.route.name))
    .map(({ route }) => ({
      tier: route.accessTier,
      host: route.hosts[0] ?? null,
      routeName: route.name,
    }));

  const uniqueMatches = matches.filter((match, index, all) =>
    all.findIndex((entry) => entry.tier === match.tier && entry.routeName === match.routeName) === index,
  );

  return {
    matches: uniqueMatches,
    tiers: Array.from(new Set(uniqueMatches.map((match) => match.tier))),
    primaryHost: hosts[0] ?? uniqueMatches[0]?.host ?? null,
  };
}
