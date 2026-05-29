// Server-side helpers for the container registry hosted by OneDev.
//
// OneDev exposes an OCI/Docker Registry HTTP API v2 endpoint, but the standard
// `/v2/_catalog` listing is UNSUPPORTED. Instead the list of container image
// repositories is discovered through the OneDev REST packages API
// (`/~api/packages`), which returns one entry per image name + version (tag).
// Per-repository tags and per-tag digest/size are then read from the Docker
// Registry v2 API (`/v2/<path>/tags/list` and `/v2/<path>/manifests/<ref>`).

const DEFAULT_ONEDEV_URL = "http://onedev.onedev.svc.cluster.local";
const DEFAULT_PUBLIC_HOST = "onedev.rlservers.com";
const DEFAULT_PROJECT_PATH = "InfraWeaver-platform";

const CONTAINER_IMAGE_TYPE = "Container Image";
const MANIFEST_ACCEPT =
  "application/vnd.oci.image.index.v1+json," +
  "application/vnd.docker.distribution.manifest.list.v2+json," +
  "application/vnd.docker.distribution.manifest.v2+json," +
  "application/vnd.oci.image.manifest.v1+json";

export interface RegistryConfig {
  apiUrl: string; // internal OneDev base URL used for server-side API calls
  username: string;
  token: string;
  projectPath: string; // e.g. "InfraWeaver-platform"
  registryHost: string; // public host shown in pull/login commands
  configured: boolean;
}

export interface RegistryTag {
  tag: string;
  digest: string;
  size: number;
  pushedAt: string | null;
}

interface OneDevPackage {
  type: string;
  name: string;
  version: string;
  publishDate: string | null;
}

export function getRegistryConfig(): RegistryConfig {
  const apiUrl = (process.env.ONEDEV_URL ?? DEFAULT_ONEDEV_URL).replace(/\/+$/, "");
  const username = process.env.ONEDEV_USERNAME ?? "admin";
  const token = process.env.ONEDEV_TOKEN ?? "";
  const projectPath = (process.env.ONEDEV_PROJECT_PATH ?? DEFAULT_PROJECT_PATH).replace(/^\/+|\/+$/g, "");
  const registryHost = (process.env.REGISTRY_HOST ?? DEFAULT_PUBLIC_HOST)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return { apiUrl, username, token, projectPath, registryHost, configured: Boolean(token) };
}

function authHeaders(cfg: RegistryConfig, accept = "application/json"): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  if (cfg.token) {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.token}`).toString("base64")}`;
  }
  return headers;
}

// The OCI repository path under which images for this project are published,
// e.g. "infraweaver-platform". Used for both the v2 API path and pull commands.
export function registryRepoPath(cfg: RegistryConfig, name: string): string {
  return `${cfg.projectPath.toLowerCase()}/${name}`;
}

export function pullCommand(cfg: RegistryConfig, name: string, tag: string): string {
  return `docker pull ${cfg.registryHost}/${registryRepoPath(cfg, name)}:${tag}`;
}

function quote(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

async function queryPackages(cfg: RegistryConfig, query: string, max: number): Promise<OneDevPackage[]> {
  const pageSize = 100;
  const results: OneDevPackage[] = [];
  for (let offset = 0; offset < max; offset += pageSize) {
    const count = Math.min(pageSize, max - offset);
    const url = `${cfg.apiUrl}/~api/packages?query=${encodeURIComponent(query)}&offset=${offset}&count=${count}`;
    const res = await fetch(url, {
      headers: authHeaders(cfg),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`OneDev packages query failed: ${res.status}`);
    }
    const page = (await res.json()) as OneDevPackage[];
    results.push(...page);
    if (page.length < count) break;
  }
  return results;
}

// Lists distinct container image repository names published under the project.
export async function listRepositories(cfg: RegistryConfig): Promise<string[]> {
  const query = `"Project" is "${quote(cfg.projectPath)}"`;
  const packages = await queryPackages(cfg, query, 1000);
  const names = new Set<string>();
  for (const pkg of packages) {
    if (pkg.type === CONTAINER_IMAGE_TYPE && pkg.name) names.add(pkg.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

async function manifestInfo(
  cfg: RegistryConfig,
  repoPath: string,
  ref: string,
): Promise<{ digest: string; size: number }> {
  const res = await fetch(`${cfg.apiUrl}/v2/${repoPath}/manifests/${ref}`, {
    headers: authHeaders(cfg, MANIFEST_ACCEPT),
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
  const digest = res.headers.get("Docker-Content-Digest") ?? "";
  const manifest = (await res.json().catch(() => ({}))) as {
    layers?: Array<{ size?: number }>;
    config?: { size?: number };
    manifests?: Array<{ digest?: string }>;
  };

  let size = 0;
  if (Array.isArray(manifest.layers)) {
    size = (manifest.config?.size ?? 0) + manifest.layers.reduce((acc, l) => acc + (l.size ?? 0), 0);
  } else if (Array.isArray(manifest.manifests) && manifest.manifests[0]?.digest) {
    // Multi-arch image index: estimate size from the first platform manifest.
    const platformDigest = manifest.manifests[0].digest as string;
    const platformRes = await fetch(`${cfg.apiUrl}/v2/${repoPath}/manifests/${platformDigest}`, {
      headers: authHeaders(cfg, MANIFEST_ACCEPT),
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (platformRes.ok) {
      const platform = (await platformRes.json().catch(() => ({}))) as {
        layers?: Array<{ size?: number }>;
        config?: { size?: number };
      };
      size =
        (platform.config?.size ?? 0) +
        (platform.layers ?? []).reduce((acc, l) => acc + (l.size ?? 0), 0);
    }
  }
  return { digest: digest.slice(0, 19), size };
}

// Lists tags for a single repository, enriched with digest/size for the most
// recent tags. Tag list and publish dates come from the OneDev packages API;
// digest and size come from the Docker Registry v2 manifest API.
export async function listTags(cfg: RegistryConfig, name: string, enrich = 25): Promise<RegistryTag[]> {
  const query = `"Project" is "${quote(cfg.projectPath)}" and "Name" is "${quote(name)}"`;
  const packages = await queryPackages(cfg, query, 1000);
  const versions = packages
    .filter((p) => p.type === CONTAINER_IMAGE_TYPE && p.version)
    .map((p) => ({ tag: p.version, pushedAt: p.publishDate ?? null }))
    .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));

  const repoPath = registryRepoPath(cfg, name);
  const tags = await Promise.all(
    versions.map(async (v, i) => {
      if (i >= enrich) return { tag: v.tag, digest: "", size: 0, pushedAt: v.pushedAt };
      try {
        const { digest, size } = await manifestInfo(cfg, repoPath, v.tag);
        return { tag: v.tag, digest, size, pushedAt: v.pushedAt };
      } catch {
        return { tag: v.tag, digest: "", size: 0, pushedAt: v.pushedAt };
      }
    }),
  );
  return tags;
}

// Resolves the manifest digest for a tag (used when deleting a tag).
export async function getManifestDigest(cfg: RegistryConfig, name: string, tag: string): Promise<string | null> {
  const repoPath = registryRepoPath(cfg, name);
  const res = await fetch(`${cfg.apiUrl}/v2/${repoPath}/manifests/${tag}`, {
    headers: authHeaders(cfg, MANIFEST_ACCEPT),
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  return res.headers.get("Docker-Content-Digest");
}

export async function deleteManifest(cfg: RegistryConfig, name: string, digest: string): Promise<boolean> {
  const repoPath = registryRepoPath(cfg, name);
  const res = await fetch(`${cfg.apiUrl}/v2/${repoPath}/manifests/${digest}`, {
    method: "DELETE",
    headers: authHeaders(cfg),
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  return res.ok || res.status === 202;
}
