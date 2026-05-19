import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import jsYaml from "js-yaml";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GITHUB_API = "https://api.github.com";
const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";
const HELM_SECTIONS = ["core", "monitoring", "platform"] as const;

// Map app name → section+dir (e.g. "core-argocd" → ["core", "argocd"])
function parseAppName(name: string): [string, string] | null {
  for (const section of HELM_SECTIONS) {
    const prefix = `${section}-`;
    if (name.startsWith(prefix)) return [section, name.slice(prefix.length)];
  }
  return null;
}

interface ApplicationYaml {
  repoURL?: string;
  targetRevision?: string;
  chart?: string;
}

interface HelmIndexEntry {
  version?: string;
  appVersion?: string;
  created?: string;
}

async function readApplicationYaml(section: string, appDir: string): Promise<ApplicationYaml | null> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/kubernetes/${section}/${appDir}/application.yaml`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const file = await res.json() as { content: string };
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    return jsYaml.load(content) as ApplicationYaml;
  } catch {
    return null;
  }
}

// Fetch Helm repo index.yaml and return sorted versions for a chart
async function fetchHelmVersions(repoUrl: string, chart: string): Promise<string[]> {
  const indexUrl = `${repoUrl.replace(/\/$/, "")}/index.yaml`;
  const res = await fetch(indexUrl, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "infraweaver-console/1.0" },
  });
  if (!res.ok) throw new Error(`Helm index fetch failed: ${res.status} from ${indexUrl}`);

  const text = await res.text();
  // Parse only the entries for this chart to avoid loading the entire index into memory
  const parsed = jsYaml.load(text) as { entries?: Record<string, HelmIndexEntry[]> };
  const entries = parsed?.entries?.[chart];
  if (!entries?.length) return [];

  // Sort by semver descending: strip leading 'v', split by '.'
  return entries
    .map((e) => e.version ?? "")
    .filter(Boolean)
    .sort((a, b) => {
      const toNums = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
      const [aMaj, aMin, aPat] = toNums(a);
      const [bMaj, bMin, bPat] = toNums(b);
      return bMaj - aMaj || bMin - aMin || bPat - aPat;
    });
}

// Try to resolve chart/repoURL from ArgoCD live app if not in git manifest
async function resolveFromArgo(appName: string): Promise<{ chart: string; repoURL: string } | null> {
  try {
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications/${encodeURIComponent(appName)}`, {
      headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const app = await res.json() as {
      spec: { sources?: Array<{ chart?: string; repoURL?: string }>; source?: { chart?: string; repoURL?: string } };
    };
    const src = app.spec.sources?.find((s) => s.chart) ?? app.spec.source;
    if (src?.chart && src?.repoURL) return { chart: src.chart, repoURL: src.repoURL };
    return null;
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("updates-versions", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;
  const parts = parseAppName(name);
  if (!parts) return NextResponse.json({ error: "App not found in managed sections" }, { status: 404 });

  const [section, appDir] = parts;
  const appYaml = await readApplicationYaml(section, appDir);

  let chart = appYaml?.chart ?? null;
  let repoUrl = appYaml?.repoURL ?? null;

  // Fall back to live ArgoCD data (e.g. for apps without full application.yaml)
  if (!chart || !repoUrl) {
    const fromArgo = await resolveFromArgo(name);
    chart = chart ?? fromArgo?.chart ?? null;
    repoUrl = repoUrl ?? fromArgo?.repoURL ?? null;
  }

  if (!chart || !repoUrl) {
    return NextResponse.json({ error: "Chart or repo URL not found for this app" }, { status: 404 });
  }

  try {
    const versions = await fetchHelmVersions(repoUrl, chart);
    const source = repoUrl.includes("artifacthub") ? "helm" : "helm";
    return NextResponse.json({ versions, source, note: `${versions.length} versions found in ${repoUrl}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ versions: [], source: "unknown", note: msg });
  }
}
