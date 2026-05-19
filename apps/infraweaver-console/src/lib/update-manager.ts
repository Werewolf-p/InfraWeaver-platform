import jsYaml from "js-yaml";
import { gitReadFile } from "@/lib/git-provider";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export const MANAGED_UPDATE_SECTIONS = ["core", "monitoring", "platform", "catalog", "apps"] as const;

export interface ApplicationYaml {
  repoURL?: string;
  targetRevision?: string;
  chart?: string;
  releaseName?: string;
  namespace?: string;
}

export interface ArgoSource {
  chart?: string;
  path?: string;
  ref?: string;
  repoURL?: string;
  targetRevision?: string;
}

export interface ArgoApplication {
  metadata: { name: string };
  spec: {
    destination?: { namespace?: string };
    source?: ArgoSource;
    sources?: ArgoSource[];
  };
  status: {
    history?: Array<{ deployedAt?: string }>;
    operationState?: { finishedAt?: string };
    sync?: { status?: string };
  };
}

interface HelmIndexEntry {
  version?: string;
}

function argoHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    ...(ARGOCD_TOKEN ? { Authorization: `Bearer ${ARGOCD_TOKEN}` } : {}),
  };
}

export function parseManagedAppName(name: string): { section: string; appDir: string } | null {
  for (const section of MANAGED_UPDATE_SECTIONS) {
    const prefix = `${section}-`;
    if (name.startsWith(prefix)) {
      return { section, appDir: name.slice(prefix.length) };
    }
  }
  return null;
}

export function getManagedApplicationFilePath(name: string): string | null {
  const parsed = parseManagedAppName(name);
  if (!parsed) return null;
  return `kubernetes/${parsed.section}/${parsed.appDir}/application.yaml`;
}

export async function readManagedApplicationFile(name: string) {
  const path = getManagedApplicationFilePath(name);
  if (!path) return null;
  const file = await gitReadFile(path);
  if (!file) return null;
  return { path, file };
}

export async function readManagedApplicationYaml(name: string): Promise<(ApplicationYaml & { path: string; sha: string; content: string }) | null> {
  const managed = await readManagedApplicationFile(name);
  if (!managed) return null;
  const parsed = jsYaml.load(managed.file.content) as ApplicationYaml | null;
  return {
    ...(parsed ?? {}),
    content: managed.file.content,
    path: managed.path,
    sha: managed.file.sha,
  };
}

export function getHelmSource(app: ArgoApplication): ArgoSource | null {
  return app.spec.sources?.find((source) => source.chart && source.repoURL)
    ?? (app.spec.source?.chart && app.spec.source.repoURL ? app.spec.source : null);
}

export async function listArgoApplications(limit = 500): Promise<ArgoApplication[]> {
  const response = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=${limit}`, {
    headers: argoHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`ArgoCD applications list failed: ${response.status} — ${await response.text()}`);
  }
  const data = await response.json() as { items?: ArgoApplication[] };
  return data.items ?? [];
}

export async function getArgoApplication(name: string): Promise<ArgoApplication | null> {
  const response = await fetch(`${ARGOCD_SERVER}/api/v1/applications/${encodeURIComponent(name)}`, {
    headers: argoHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`ArgoCD application lookup failed for ${name}: ${response.status} — ${await response.text()}`);
  }
  return await response.json() as ArgoApplication;
}

function tokenizeVersion(version: string) {
  return version
    .replace(/^v/i, "")
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

function compareVersionDesc(a: string, b: string) {
  const left = tokenizeVersion(a);
  const right = tokenizeVersion(b);
  const max = Math.max(left.length, right.length);

  for (let index = 0; index < max; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return 1;
    if (rightPart === undefined) return -1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return rightPart - leftPart;
    }
    return String(rightPart).localeCompare(String(leftPart), undefined, { numeric: true, sensitivity: "base" });
  }

  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

export async function fetchHelmVersions(repoUrl: string, chart: string): Promise<string[]> {
  const indexUrl = `${repoUrl.replace(/\/$/, "")}/index.yaml`;
  const response = await fetch(indexUrl, {
    cache: "no-store",
    headers: { "User-Agent": "infraweaver-console/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Helm index fetch failed: ${response.status} from ${indexUrl}`);
  }

  const parsed = jsYaml.load(await response.text()) as { entries?: Record<string, HelmIndexEntry[]> } | null;
  const versions = parsed?.entries?.[chart]?.map((entry) => entry.version ?? "").filter(Boolean) ?? [];
  return Array.from(new Set(versions)).sort(compareVersionDesc);
}

export function patchTargetRevision(content: string, version: string): string {
  const patched = content.replace(/^(\s*targetRevision\s*:\s*)["']?[^"'\n]+["']?/m, `$1"${version}"`);
  if (patched === content) {
    return `${content.trimEnd()}\ntargetRevision: "${version}"\n`;
  }
  return patched;
}
