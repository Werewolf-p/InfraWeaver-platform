import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getHelmSource, listArgoApplications, parseManagedAppName, readManagedApplicationYaml } from "@/lib/update-manager";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("updates-list", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const argoApps = await listArgoApplications();

  const items = (
    await Promise.all(
      argoApps.map(async (argoApp) => {
        const helmSource = getHelmSource(argoApp);
        if (!helmSource?.chart || !helmSource.repoURL) return null;

        const managedApp = await readManagedApplicationYaml(argoApp.metadata.name);
        const parsedName = parseManagedAppName(argoApp.metadata.name);
        const lastHistory = argoApp.status.history?.at(-1);

        // Derive the actual deployed chart version from ArgoCD status
        const helmSourceIndex = argoApp.spec.sources
          ? argoApp.spec.sources.findIndex((s) => s.chart && s.repoURL)
          : -1;
        const deployedVersion = helmSourceIndex >= 0
          ? (argoApp.status.sync?.revisions?.[helmSourceIndex] ?? null)
          : (argoApp.status.sync?.revision ?? null);

        const syncStatus = argoApp.status.sync?.status
          ?? (argoApp.status.health?.status === "Healthy" ? "Synced" : "Unknown");

        return {
          id: argoApp.metadata.name,
          name: argoApp.metadata.name,
          namespace: argoApp.spec.destination?.namespace ?? managedApp?.namespace ?? parsedName?.section ?? "default",
          section: parsedName?.section ?? "other",
          currentVersion: helmSource.targetRevision ?? managedApp?.targetRevision ?? "unknown",
          targetVersion: managedApp?.targetRevision ?? helmSource.targetRevision ?? null,
          deployedVersion,
          chart: helmSource.chart ?? managedApp?.chart ?? null,
          repoUrl: helmSource.repoURL ?? managedApp?.repoURL ?? null,
          syncStatus,
          lastSync: argoApp.status.operationState?.finishedAt ?? lastHistory?.deployedAt ?? null,
        };
      })
    )
  )
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => left.section.localeCompare(right.section) || left.name.localeCompare(right.name));

  return NextResponse.json(items);
}
