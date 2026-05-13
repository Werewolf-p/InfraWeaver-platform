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
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}`;

interface GHTreeItem {
  path: string;
  type: string;
  url: string;
}

interface GHFileContent {
  content: string;
  encoding: string;
}

async function ghListTree(treePath: string): Promise<GHTreeItem[]> {
  const res = await fetch(
    `${GH_API}/contents/${treePath}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
      cache: "no-store",
    }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list ${treePath}: ${res.status}`);
  return res.json() as Promise<GHTreeItem[]>;
}

async function ghGetFile(filePath: string): Promise<string | null> {
  const res = await fetch(
    `${GH_API}/contents/${filePath}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
      cache: "no-store",
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as GHFileContent;
  if (data.encoding !== "base64") return null;
  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
}

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
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // List all bootstrap files
    const bootstrapFiles = await ghListTree("kubernetes/bootstrap");
    const communityAppFiles = bootstrapFiles.filter(
      (f) => f.type === "file" && f.path.match(/^kubernetes\/bootstrap\/catalog-.+-manifests\.yaml$/)
    );

    // Read each ArgoCD Application and check if it's a community app
    const installedApps: InstalledApp[] = [];

    await Promise.all(
      communityAppFiles.map(async (file) => {
        const content = await ghGetFile(file.path);
        if (!content) return;

        // Only include community apps (has infraweaver.io/source: community-apps label)
        if (!content.includes("infraweaver.io/source: community-apps")) return;

        // Extract slug from file name: catalog-<slug>-manifests.yaml
        const slugMatch = file.path.match(/catalog-(.+)-manifests\.yaml$/);
        if (!slugMatch) return;
        const slug = slugMatch[1];

        // Read catalog.yaml for metadata
        const catalogContent = await ghGetFile(`kubernetes/catalog/${slug}/catalog.yaml`);
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
