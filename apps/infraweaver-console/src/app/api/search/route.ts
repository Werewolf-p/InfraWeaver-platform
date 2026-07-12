import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import { makeCoreApi } from "@/lib/kube-client";
import { makeGameHubClients } from "@/lib/game-hub-server";
import { filterNavGroupsByPermissions } from "@/lib/navigation-rbac";
import { NAV_GROUPS } from "@/lib/nav-config";
import { getEffectivePermissions } from "@/lib/rbac";
import { EMPTY_SEARCH_RESPONSE, type SearchResponse, type SearchResult } from "@/lib/search";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { withAuth } from "@/lib/with-auth";

function includesQuery(query: string, ...values: Array<string | null | undefined>) {
  if (!query) return true;
  return values.some((value) => (value ?? "").toLowerCase().includes(query));
}

function badgeForStatus(status: string) {
  const value = status.toLowerCase();
  if (["healthy", "running", "synced", "open", "ready"].includes(value)) {
    return "bg-emerald-500/10 text-emerald-300";
  }
  if (["degraded", "failed", "error"].includes(value)) {
    return "bg-red-500/10 text-red-300";
  }
  if (["starting", "pending", "progressing", "unknown"].includes(value)) {
    return "bg-yellow-500/10 text-yellow-200";
  }
  return "bg-[#1f1f1f] text-[#888]";
}

async function searchApps(query: string): Promise<SearchResult[]> {
  try {
    const { apps } = await getArgocdAppsCached();
    return apps
      .filter((app) =>
        includesQuery(
          query,
          app.metadata?.name,
          app.spec?.destination?.namespace,
          app.spec?.project,
          app.status?.health?.status,
          app.status?.sync?.status,
        ),
      )
      .slice(0, 16)
      .map((app) => ({
        id: `app-${app.metadata?.name ?? "unknown"}`,
        title: app.metadata?.name ?? "Unknown app",
        subtitle: [app.spec?.destination?.namespace, app.spec?.project].filter(Boolean).join(" · "),
        href: `/apps/${encodeURIComponent(app.metadata?.name ?? "")}`,
        category: "app",
        icon: "📦",
        badge: app.status?.health?.status ?? app.status?.sync?.status ?? undefined,
        badgeColor: badgeForStatus(app.status?.health?.status ?? app.status?.sync?.status ?? ""),
      }));
  } catch {
    return [];
  }
}

async function searchPods(query: string, clusterId: string): Promise<SearchResult[]> {
  try {
    const podList = await makeCoreApi(clusterId).listPodForAllNamespaces();
    return (podList.items ?? [])
      .filter((pod) =>
        includesQuery(
          query,
          pod.metadata?.name,
          pod.metadata?.namespace,
          pod.status?.phase,
          ...(pod.spec?.containers ?? []).map((container) => container.name),
        ),
      )
      .slice(0, 20)
      .map((pod) => ({
        id: `pod-${pod.metadata?.namespace ?? "default"}-${pod.metadata?.name ?? "unknown"}`,
        title: pod.metadata?.name ?? "Unknown pod",
        subtitle: [pod.metadata?.namespace, pod.status?.phase].filter(Boolean).join(" · "),
        href: `/logs?namespace=${encodeURIComponent(pod.metadata?.namespace ?? "default")}&pod=${encodeURIComponent(pod.metadata?.name ?? "")}`,
        category: "pod",
        icon: "☸️",
        badge: pod.status?.phase ?? undefined,
        badgeColor: badgeForStatus(pod.status?.phase ?? ""),
      }));
  } catch {
    return [];
  }
}

async function searchGameServers(
  query: string,
  access: Awaited<ReturnType<typeof getSessionRBACContext>>,
): Promise<SearchResult[]> {
  try {
    const { appsApi } = makeGameHubClients();
    const deployments = await appsApi.listNamespacedDeployment({
      namespace: "game-hub",
      labelSelector: "infraweaver/game=true",
    });

    return (deployments.items ?? [])
      .filter((deployment) => {
        const name = deployment.metadata?.name ?? "";
        return name && hasSessionPermission(access, "game-hub:read", `/game-hub/servers/${name}`);
      })
      .filter((deployment) =>
        includesQuery(
          query,
          deployment.metadata?.name,
          deployment.metadata?.annotations?.["infraweaver.io/description"],
          deployment.metadata?.annotations?.["infraweaver/description"],
          deployment.metadata?.labels?.["infraweaver/game-type"],
          deployment.metadata?.annotations?.["infraweaver.io/tags"],
          deployment.metadata?.annotations?.["infraweaver.io/groups"],
        ),
      )
      .slice(0, 16)
      .map((deployment) => {
        const desired = deployment.spec?.replicas ?? 0;
        const ready = deployment.status?.readyReplicas ?? 0;
        const maintenanceMode = deployment.metadata?.annotations?.["infraweaver/maintenance"] === "true";
        const status = maintenanceMode
          ? "maintenance"
          : desired === 0
            ? "stopped"
            : ready > 0
              ? "running"
              : "starting";

        return {
          id: `game-server-${deployment.metadata?.name ?? "unknown"}`,
          title: deployment.metadata?.name ?? "Unknown server",
          subtitle: [
            deployment.metadata?.labels?.["infraweaver/game-type"],
            deployment.metadata?.annotations?.["infraweaver.io/description"] ?? deployment.metadata?.annotations?.["infraweaver/description"],
          ].filter(Boolean).join(" · "),
          href: `/game-hub/${encodeURIComponent(deployment.metadata?.name ?? "")}`,
          category: "game-server",
          icon: deployment.metadata?.annotations?.["infraweaver.io/icon"] ?? deployment.metadata?.annotations?.["infraweaver/icon"] ?? "🎮",
          badge: status,
          badgeColor: badgeForStatus(status),
        } satisfies SearchResult;
      });
  } catch {
    return [];
  }
}

function searchNavigation(
  query: string,
  permissions: Set<string>,
  roleAssignments: Awaited<ReturnType<typeof getSessionRBACContext>>["roleAssignments"],
): Pick<SearchResponse, "navigation" | "settings"> {
  const filteredGroups = filterNavGroupsByPermissions(NAV_GROUPS, permissions, roleAssignments);
  const navigation: SearchResult[] = [];
  const settings: SearchResult[] = [];

  for (const group of filteredGroups) {
    for (const item of group.items) {
      if (!includesQuery(query, item.label, item.description, item.href)) continue;
      // Settings-style pages now live in the Platform group; bucket them by href
      // so the search UI keeps its dedicated "settings" section.
      const isSetting = item.href === "/profile" || item.href.startsWith("/settings");
      const result: SearchResult = {
        id: `nav-${item.href}`,
        title: item.label,
        subtitle: item.description,
        href: item.href,
        category: isSetting ? "setting" : "navigation",
        icon: isSetting ? "⚙️" : "🧭",
      };
      if (isSetting) settings.push(result);
      else navigation.push(result);
    }
  }

  return {
    navigation: navigation.slice(0, 12),
    settings: settings.slice(0, 12),
  };
}

export const GET = withAuth({}, async ({ req, session }) => {
  const access = await getSessionRBACContext(session, 60);
  const permissions = getEffectivePermissions(
    access.groups,
    access.username,
    access.roleAssignments,
    "/",
  );
  const rawQuery = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (rawQuery.length > 200) {
    return NextResponse.json({ error: "Query too long" }, { status: 400 });
  }
  const query = rawQuery.toLowerCase();

  const response: SearchResponse = {
    ...EMPTY_SEARCH_RESPONSE,
    ...searchNavigation(query, permissions, access.roleAssignments),
  };

  if (permissions.has("*") || permissions.has("apps:read")) {
    response.apps = await searchApps(query);
  }

  if (permissions.has("*") || permissions.has("cluster:read") || permissions.has("infra:read")) {
    response.pods = await searchPods(query, getRequestClusterId(req));
  }

  if (
    permissions.has("*") ||
    permissions.has("game-hub:read") ||
    access.roleAssignments.some((assignment) => assignment.scope.startsWith("/game-hub/"))
  ) {
    response.gameServers = await searchGameServers(query, access);
  }

  return NextResponse.json(response);
});
