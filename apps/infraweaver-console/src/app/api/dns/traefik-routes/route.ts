import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { auth } from "@/lib/auth";
import { loadKubeConfig } from "@/lib/k8s";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

interface RouteSummary {
  name: string;
  hostname: string;
  service: string;
  namespace: string;
  tls: boolean;
  pathPrefix?: string;
}

interface TraefikIngressRoute {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    entryPoints?: string[];
    tls?: Record<string, unknown>;
    routes?: Array<{
      match?: string;
      services?: Array<{ name?: string }>;
    }>;
  };
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

function extractMatchValues(expression: string | undefined, matcher: "Host" | "PathPrefix") {
  if (!expression) return [] as string[];

  const values: string[] = [];
  const regex = new RegExp(`${matcher}\\(([^)]*)\\)`, "g");

  for (const match of expression.matchAll(regex)) {
    const args = match[1] ?? "";
    const quotedValues = [...args.matchAll(/`([^`]+)`|'([^']+)'|"([^"]+)"/g)]
      .map((part) => part[1] ?? part[2] ?? part[3] ?? "")
      .map((value) => value.trim())
      .filter(Boolean);

    if (quotedValues.length > 0) {
      values.push(...quotedValues);
      continue;
    }

    values.push(...args.split(",").map((value) => value.trim()).filter(Boolean));
  }

  return [...new Set(values)];
}

function mapTraefikIngressRoutes(items: TraefikIngressRoute[]): RouteSummary[] {
  const routes: RouteSummary[] = [];

  for (const item of items) {
    const name = item.metadata?.name ?? "unknown";
    const namespace = item.metadata?.namespace ?? "default";
    const tls = Boolean(item.spec?.tls)
      || (item.spec?.entryPoints ?? []).some((entryPoint) => entryPoint.toLowerCase().includes("websecure"));

    for (const route of item.spec?.routes ?? []) {
      const hostnames = extractMatchValues(route.match, "Host").map(normalizeHostname).filter(Boolean);
      if (hostnames.length === 0) continue;

      const serviceNames = [...new Set(
        (route.services ?? [])
          .map((service) => service.name?.trim())
          .filter((value): value is string => Boolean(value)),
      )];
      const pathPrefix = extractMatchValues(route.match, "PathPrefix")[0]?.trim() || undefined;
      const service = serviceNames.join(", ") || "unknown";

      for (const hostname of hostnames) {
        routes.push({
          name,
          hostname,
          service,
          namespace,
          tls,
          pathPrefix,
        });
      }
    }
  }

  return routes;
}

function ingressUsesTls(spec: k8s.V1IngressSpec | undefined, hostname: string) {
  return (spec?.tls ?? []).some((entry) => {
    if (!entry.hosts || entry.hosts.length === 0) return true;
    return entry.hosts.some((host) => normalizeHostname(host) === hostname);
  });
}

function mapStandardIngressRoutes(items: k8s.V1Ingress[]): RouteSummary[] {
  const routes: RouteSummary[] = [];

  for (const item of items) {
    const name = item.metadata?.name ?? "unknown";
    const namespace = item.metadata?.namespace ?? "default";

    for (const rule of item.spec?.rules ?? []) {
      const hostname = normalizeHostname(rule.host ?? "");
      if (!hostname) continue;

      const tls = ingressUsesTls(item.spec, hostname);
      const paths = rule.http?.paths ?? [];
      if (paths.length === 0) {
        routes.push({
          name,
          hostname,
          service: "unknown",
          namespace,
          tls,
        });
        continue;
      }

      for (const path of paths) {
        routes.push({
          name,
          hostname,
          service: path.backend?.service?.name?.trim() || "unknown",
          namespace,
          tls,
          pathPrefix: path.path?.trim() || undefined,
        });
      }
    }
  }

  return routes;
}

function dedupeRoutes(routes: RouteSummary[]) {
  return [...new Map(routes.map((route) => {
    const key = [
      route.namespace,
      route.name,
      route.hostname,
      route.service,
      route.pathPrefix ?? "",
      route.tls ? "tls" : "plain",
    ].join("|");

    return [key, route] as const;
  })).values()].sort((left, right) => (
    left.hostname.localeCompare(right.hostname)
    || left.namespace.localeCompare(right.namespace)
    || left.service.localeCompare(right.service)
    || (left.pathPrefix ?? "").localeCompare(right.pathPrefix ?? "")
  ));
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const kc = loadKubeConfig();
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);

    const [traefikIngressRoutes, standardIngresses] = await Promise.all([
      customApi.listClusterCustomObject({
        group: "traefik.io",
        version: "v1alpha1",
        plural: "ingressroutes",
      }).catch(() => ({ items: [] } as { items?: TraefikIngressRoute[] })),
      networkingApi.listIngressForAllNamespaces().catch(() => ({ items: [] } as k8s.V1IngressList)),
    ]);

    const routes = dedupeRoutes([
      ...mapTraefikIngressRoutes((traefikIngressRoutes as { items?: TraefikIngressRoute[] }).items ?? []),
      ...mapStandardIngressRoutes(standardIngresses.items ?? []),
    ]);

    return NextResponse.json({ routes });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
