import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import jsYaml from "js-yaml";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GITHUB_API = "https://api.github.com";
const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

// Sections of the kubernetes/ directory that contain application.yaml-managed helm apps
const HELM_SECTIONS = ["core", "monitoring", "platform"] as const;

interface ApplicationYaml {
  repoURL?: string;
  targetRevision?: string;
  chart?: string;
  releaseName?: string;
  namespace?: string;
}

interface ArgoApp {
  metadata: { name: string };
  spec: {
    destination: { namespace: string };
    sources?: Array<{ chart?: string; repoURL?: string; targetRevision?: string }>;
    source?: { chart?: string; repoURL?: string; targetRevision?: string };
  };
  status: {
    sync: { status: string };
    operationState?: { finishedAt?: string };
    history?: Array<{ deployedAt?: string }>;
  };
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(path: string) {
  return fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: ghHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
}

async function readApplicationYaml(section: string, appDir: string): Promise<ApplicationYaml | null> {
  try {
    const res = await ghFetch(`kubernetes/${section}/${appDir}/application.yaml`);
    if (!res.ok) return null;
    const file = await res.json() as { content: string };
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    return jsYaml.load(content) as ApplicationYaml;
  } catch {
    return null;
  }
}

async function listSectionDirs(section: string): Promise<string[]> {
  try {
    const res = await ghFetch(`kubernetes/${section}`);
    if (!res.ok) return [];
    const entries = await res.json() as Array<{ name: string; type: string }>;
    return entries.filter((e) => e.type === "dir").map((e) => e.name);
  } catch {
    return [];
  }
}

async function getArgoApps(): Promise<Map<string, ArgoApp>> {
  try {
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=200`, {
      headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return new Map();
    const data = await res.json() as { items: ArgoApp[] };
    const map = new Map<string, ArgoApp>();
    for (const app of data.items ?? []) map.set(app.metadata.name, app);
    return map;
  } catch {
    return new Map();
  }
}

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

  const [argoApps, ...sectionDirLists] = await Promise.all([
    getArgoApps(),
    ...HELM_SECTIONS.map(listSectionDirs),
  ]);

  const items = (
    await Promise.all(
      HELM_SECTIONS.flatMap((section, idx) =>
        sectionDirLists[idx].map(async (appDir) => {
          const appYaml = await readApplicationYaml(section, appDir);
          if (!appYaml?.chart && !appYaml?.repoURL) return null;

          const argoName = `${section}-${appDir}`;
          const argoApp = argoApps.get(argoName);
          const lastHistory = argoApp?.status.history?.at(-1);

          // Prefer live ArgoCD source data, fall back to git application.yaml
          const liveSrc = argoApp?.spec.sources?.find((s) => s.chart) ?? argoApp?.spec.source;
          const currentVersion = liveSrc?.targetRevision ?? appYaml.targetRevision ?? "unknown";
          const repoUrl = liveSrc?.repoURL ?? appYaml.repoURL ?? null;
          const chart = liveSrc?.chart ?? appYaml.chart ?? null;

          return {
            id: argoName,
            name: argoName,
            namespace: argoApp?.spec.destination.namespace ?? appYaml.namespace ?? section,
            section,
            currentVersion,
            targetVersion: appYaml.targetRevision ?? null,
            chart,
            repoUrl,
            syncStatus: argoApp?.status.sync.status ?? "Unknown",
            lastSync: argoApp?.status.operationState?.finishedAt ?? lastHistory?.deployedAt ?? null,
          };
        })
      )
    )
  ).filter(Boolean);

  return NextResponse.json(items);
}
