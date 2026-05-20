/**
 * GET /api/community-apps/installed
 *
 * Returns a list of community apps that have been deployed to the cluster
 * by reading kubernetes/bootstrap/catalog-*-manifests.yaml files that have
 * the label infraweaver.io/source: community-apps.
 *
 * Also reads each app's kubernetes/catalog/<slug>/catalog.yaml for metadata.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gitListDir, gitReadFile, getGitAccessToken } from "@/lib/git-provider";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

export interface InstalledApp {
  slug: string;
  name: string;
  description: string;
  namespace: string;
  tier: string;
  image: string;
  categories: string[];
  ingressHost?: string;
  installedAt: string;
  argoAppName: string;
  manifestsPath: string;
}

function parseSimpleYaml(yaml: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = yaml.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("#") || !line.trim()) continue;

    const listMatch = line.match(/^  - "?(.+?)"?\s*$/);
    if (listMatch && currentList !== null) {
      currentList.push(listMatch[1]);
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*): (.+)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      currentList = null;
      result[currentKey] = kvMatch[2].replace(/^"(.*)"$/, "$1");
    } else if (line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):$/) ) {
      currentKey = line.replace(":", "").trim();
      currentList = [];
      result[currentKey] = currentList;
    }
  }
  return result;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!getGitAccessToken().trim()) {
    return NextResponse.json({ apps: [], total: 0, reason: "github_token_missing" });
  }

  try {
    // List all bootstrap files
    const bootstrapFiles = await gitListDir("kubernetes/bootstrap");
    const communityAppFiles = bootstrapFiles.filter(
      (f) => f.type === "file" && f.path.match(/^kubernetes\/bootstrap\/catalog-.+-manifests\.yaml$/)
    );

    // Read each ArgoCD Application and check if it's a community app
    const installedApps: InstalledApp[] = [];

    await Promise.all(
      communityAppFiles.map(async (file) => {
        const content = (await gitReadFile(file.path))?.content ?? null;
        if (!content) return;

        // Only include community apps (has infraweaver.io/source: community-apps label)
        if (!content.includes("infraweaver.io/source: community-apps")) return;

        // Extract slug from file name: catalog-<slug>-manifests.yaml
        const slugMatch = file.path.match(/catalog-(.+)-manifests\.yaml$/);
        if (!slugMatch) return;
        const slug = slugMatch[1];

        // Read catalog.yaml for metadata
        const catalogContent = (await gitReadFile(`kubernetes/catalog/${slug}/catalog.yaml`))?.content ?? null;
        if (!catalogContent) {
          // Minimal entry from ArgoCD Application alone
          installedApps.push({
            slug,
            name: slug,
            description: "",
            namespace: slug,
            tier: "simple",
            image: "",
            categories: [],
            installedAt: "",
            argoAppName: `catalog-${slug}-manifests`,
            manifestsPath: `kubernetes/catalog/${slug}/manifests`,
          });
          return;
        }

        const meta = parseSimpleYaml(catalogContent);

        // Parse ingressroute host
        const ingressMatch = catalogContent.match(/host:\s*(.+)/);

        installedApps.push({
          slug,
          name: String(meta.name ?? slug),
          description: String(meta.description ?? ""),
          namespace: String(meta.namespace ?? slug),
          tier: String(meta.tier ?? "simple"),
          image: String(meta.image ?? ""),
          categories: Array.isArray(meta.categories) ? meta.categories : [],
          ingressHost: ingressMatch ? ingressMatch[1].trim() : undefined,
          installedAt: String(meta.installed_at ?? ""),
          argoAppName: `catalog-${slug}-manifests`,
          manifestsPath: `kubernetes/catalog/${slug}/manifests`,
        });
      })
    );

    // Sort by install date descending
    installedApps.sort((a, b) => {
      if (!a.installedAt) return 1;
      if (!b.installedAt) return -1;
      return b.installedAt.localeCompare(a.installedAt);
    });

    return NextResponse.json({ apps: installedApps, total: installedApps.length });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 502 });
  }
}
