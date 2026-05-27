import { Hono } from 'hono';
import { z } from 'zod';
import { VERSION_SOURCES, type VersionSource, type VersionSourceType } from '../config/version-sources.js';
import { getCluster } from '../lib/cluster-registry.js';
import {
  githubGetFile, githubGetTree, githubPutFile,
  isOnedev, onedevGetFile, onedevGetTreeAndFiles, onedevPutFile,
} from '../lib/git-provider.js';
import { getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

interface ApplicationManifest {
  appName: string;
  chart: string | null;
  filePath: string;
  id: string;
  namespace: string | null;
  releaseName: string | null;
  repoUrl: string | null;
  section: string;
  targetRevision: string | null;
}

interface ArgoApplication {
  metadata?: { name?: string; namespace?: string };
  spec?: { destination?: { namespace?: string } };
  status?: {
    health?: { status?: string };
    operationState?: {
      finishedAt?: string;
      phase?: string;
      startedAt?: string;
      syncResult?: { revision?: string };
    };
    reconciledAt?: string;
    summary?: { images?: string[] };
    sync?: { revision?: string; status?: string };
  };
}

interface VersionLookupResponse {
  note?: string;
  source: VersionSourceType | 'unknown';
  versions: string[];
}

const appNameSchema = z.object({
  appName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid app name'),
});

const updateBodySchema = z.object({
  version: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9.*:+_-]+$/, 'Invalid version'),
});

const argoAppsCache = new Map<string, { fetchedAt: number; items: ArgoApplication[] }>();
let manifestsCache: { fetchedAt: number; items: ApplicationManifest[] } | null = null;

function normalizeVersionTag(version: string) {
  return version.trim().replace(/^v/i, '');
}

function compareVersions(left: string, right: string) {
  return normalizeVersionTag(right).localeCompare(normalizeVersionTag(left), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function uniqueSortedVersions(versions: string[]) {
  return [...new Set(versions.map((version) => version.trim()).filter(Boolean))].sort(compareVersions);
}

function parseFlatYaml(content: string) {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === '---' || line.startsWith('#')) {
      continue;
    }

    const delimiterIndex = line.indexOf(':');
    if (delimiterIndex === -1) {
      continue;
    }

    const key = line.slice(0, delimiterIndex).trim();
    const rawValue = line.slice(delimiterIndex + 1).trim();
    values[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
  }

  return values;
}

function extractImageTag(image: string) {
  if (!image) {
    return null;
  }

  const digestSeparatorIndex = image.indexOf('@');
  if (digestSeparatorIndex !== -1) {
    return image.slice(digestSeparatorIndex + 1);
  }

  const tagSeparatorIndex = image.lastIndexOf(':');
  const pathSeparatorIndex = image.lastIndexOf('/');
  if (tagSeparatorIndex > pathSeparatorIndex) {
    return image.slice(tagSeparatorIndex + 1);
  }

  return null;
}

function getCurrentVersion(liveApp: ArgoApplication | undefined, manifest: ApplicationManifest) {
  const liveRevision = liveApp?.status?.operationState?.syncResult?.revision
    ?? liveApp?.status?.sync?.revision
    ?? liveApp?.status?.summary?.images?.map(extractImageTag).find(Boolean)
    ?? manifest.targetRevision;

  return liveRevision ?? 'unknown';
}

function getSyncStatus(liveApp: ArgoApplication | undefined) {
  const phase = liveApp?.status?.operationState?.phase;
  if (phase === 'Running' || phase === 'Pending' || phase === 'Terminating') {
    return 'Progressing';
  }

  return liveApp?.status?.sync?.status
    ?? liveApp?.status?.health?.status
    ?? 'Unknown';
}

function getLastSync(liveApp: ArgoApplication | undefined) {
  return liveApp?.status?.operationState?.finishedAt
    ?? liveApp?.status?.operationState?.startedAt
    ?? liveApp?.status?.reconciledAt
    ?? null;
}

function matchLiveApp(manifest: ApplicationManifest, apps: ArgoApplication[]) {
  return apps.find((app) => app.metadata?.name === manifest.appName)
    ?? apps.find((app) => (app.metadata?.name ?? '').includes(manifest.appName));
}

function getFallbackSource(manifest: ApplicationManifest | undefined): VersionSource | null {
  if (!manifest?.repoUrl || !manifest.chart) {
    return null;
  }

  return {
    type: 'helm',
    repoUrl: manifest.repoUrl,
    chartName: manifest.chart,
  };
}

function extractHelmChartVersions(indexYaml: string, chartName: string) {
  const versions: string[] = [];
  const lines = indexYaml.split(/\r?\n/);
  let afterEntries = false;
  let chartHeaderRe: RegExp | null = null;
  let itemVersionRe: RegExp | null = null;
  let insideChart = false;

  for (const line of lines) {
    if (!afterEntries) {
      if (line.trim() === 'entries:') afterEntries = true;
      continue;
    }

    // Auto-detect chart header indent from the first chart-level key.
    // Different repos use different indent sizes (2-space, 3-space, etc.).
    if (!chartHeaderRe) {
      const m = /^(\s+)([a-zA-Z][a-zA-Z0-9._-]*):\s*$/.exec(line);
      if (m) {
        chartHeaderRe = new RegExp(`^${m[1]}([a-zA-Z][a-zA-Z0-9._-]*):\\s*$`);
        // Chart list items sit at chartIndent + 2 spaces ("- " prefix).
        // Pinning to this exact depth prevents capturing dependency version fields.
        const itemIndent = `${m[1]}  `;
        itemVersionRe = new RegExp(`^${itemIndent}version:\\s*['"]?([^'"\\n]+)['"]?\\s*$`);
        insideChart = m[2] === chartName;
      }
      continue;
    }

    const headerMatch = chartHeaderRe.exec(line);
    if (headerMatch) {
      insideChart = headerMatch[1] === chartName;
      continue;
    }

    if (!insideChart) continue;

    const vm = itemVersionRe!.exec(line);
    if (vm) versions.push(vm[1].trim());
  }

  return uniqueSortedVersions(versions).slice(0, 15);
}

function parseDockerImage(image: string) {
  const [owner, repository] = image.includes('/')
    ? image.split('/', 2)
    : ['library', image];

  return { owner, repository };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchHelmVersions(source: Extract<VersionSource, { type: 'helm' }>): Promise<VersionLookupResponse> {
  const repoUrl = source.repoUrl.endsWith('/') ? source.repoUrl : `${source.repoUrl}/`;
  const indexUrl = new URL('index.yaml', repoUrl).toString();
  const indexYaml = await fetch(indexUrl, { signal: AbortSignal.timeout(25000) }).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to fetch Helm index from ${indexUrl}`);
    }

    return response.text();
  });

  return {
    source: 'helm',
    versions: extractHelmChartVersions(indexYaml, source.chartName),
  };
}

async function fetchDockerVersions(source: Extract<VersionSource, { type: 'docker' }>): Promise<VersionLookupResponse> {
  const { owner, repository } = parseDockerImage(source.image);
  const response = await fetchJson<{ results?: Array<{ name?: string }> }>(
    `https://hub.docker.com/v2/repositories/${owner}/${repository}/tags?page_size=25&ordering=last_updated`,
  );

  return {
    source: 'docker',
    versions: uniqueSortedVersions((response.results ?? []).map((tag) => tag.name ?? '')).slice(0, 15),
  };
}

async function fetchGhcrVersions(source: Extract<VersionSource, { type: 'ghcr' }>): Promise<VersionLookupResponse> {
  const ghcrToken = process.env.GHCR_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  if (!ghcrToken) {
    return {
      source: 'ghcr',
      versions: [],
      note: 'GHCR token not configured.',
    };
  }

  const candidateUrls = [
    `https://ghcr.io/v2/${source.owner}/${source.packageName}/tags/list`,
    `https://ghcr.io/v2/${source.owner}/${source.repo}/tags/list`,
    `https://ghcr.io/v2/${source.owner}/${source.repo}/${source.packageName}/tags/list`,
  ];

  for (const url of candidateUrls) {
    try {
      const response = await fetchJson<{ tags?: string[] }>(url, {
        headers: {
          Authorization: `Bearer ${ghcrToken}`,
        },
      });

      return {
        source: 'ghcr',
        versions: uniqueSortedVersions(response.tags ?? []).slice(0, 15),
      };
    } catch {
      // Try the next public package path.
    }
  }

  return {
    source: 'ghcr',
    versions: [],
    note: 'Unable to read GHCR tags for this package.',
  };
}

async function getAvailableVersions(source: VersionSource | null): Promise<VersionLookupResponse> {
  if (!source) {
    return {
      source: 'unknown',
      versions: [],
      note: 'No version source configured for this application.',
    };
  }

  try {
    if (source.type === 'helm') {
      return await fetchHelmVersions(source);
    }

    if (source.type === 'docker') {
      return await fetchDockerVersions(source);
    }

    return await fetchGhcrVersions(source);
  } catch {
    return {
      source: source.type,
      versions: [],
      note: 'Version list unavailable right now.',
    };
  }
}


function parseManifestEntry(filePath: string, content: string): ApplicationManifest {
  const values = parseFlatYaml(content);
  const relativePath = filePath.replace(/^kubernetes\//, '');
  const pathParts = relativePath.split('/');
  const section = pathParts[0] ?? 'apps';
  const appName = pathParts[pathParts.length - 2] ?? section;
  return {
    appName,
    chart: values.chart ?? null,
    filePath,
    id: `${section}-${appName}`,
    namespace: values.namespace ?? null,
    releaseName: values.releaseName ?? null,
    repoUrl: values.repoURL ?? null,
    section,
    targetRevision: values.targetRevision ?? null,
  };
}

async function collectApplicationManifests(): Promise<ApplicationManifest[]> {
  const now = Date.now();
  if (manifestsCache && now - manifestsCache.fetchedAt < 60_000) {
    return manifestsCache.items;
  }

  let rawEntries: Array<{ path: string; content: string }>;

  if (isOnedev()) {
    rawEntries = await onedevGetTreeAndFiles();
  } else {
    const treeItems = await githubGetTree();
    rawEntries = (await Promise.all(
      treeItems.map(async ({ path: p }) => {
        const file = await githubGetFile(p);
        return file ? { path: p, content: file.content } : null;
      }),
    )).filter((e): e is { path: string; content: string } => e !== null);
  }

  const items = rawEntries
    .map(({ path: p, content }) => parseManifestEntry(p, content))
    .sort((a, b) => a.appName.localeCompare(b.appName));

  manifestsCache = { fetchedAt: now, items };
  return items;
}

async function getArgoConfig(clusterId: string): Promise<{ server: string; token: string }> {
  const cluster = await getCluster(clusterId).catch(() => null);

  // Use env vars for the local cluster (either clusterId === 'local' or isLocal flag).
  if (!clusterId || clusterId === 'local' || cluster?.isLocal) {
    return {
      server: cluster?.argocdServer ?? process.env.ARGOCD_SERVER ?? 'http://argocd-server.argocd.svc.cluster.local:80',
      token: cluster?.argocdToken ?? process.env.ARGOCD_TOKEN ?? '',
    };
  }

  return {
    server: cluster?.argocdServer ?? '',
    token: cluster?.argocdToken ?? '',
  };
}

async function listApplicationCrds(clusterId: string): Promise<ArgoApplication[] | null> {
  try {
    const customApi = await getCustomApiForCluster(clusterId);
    const response = await customApi.listNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
    }) as { items?: ArgoApplication[] };
    return Array.isArray(response.items) ? response.items : [];
  } catch {
    return null;
  }
}

async function fetchArgoApplications(clusterId: string): Promise<ArgoApplication[]> {
  const cached = argoAppsCache.get(clusterId);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.items;
  }

  const { server, token } = await getArgoConfig(clusterId);
  if (server && token) {
    try {
      const response = await fetch(`${server}/api/v1/applications?limit=500`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json() as { items?: ArgoApplication[] };
        const items = Array.isArray(data.items) ? data.items : [];
        argoAppsCache.set(clusterId, { items, fetchedAt: Date.now() });
        return items;
      }
    } catch {
      // Fall back to CRDs below.
    }
  }

  const crdItems = await listApplicationCrds(clusterId);
  if (crdItems) {
    argoAppsCache.set(clusterId, { items: crdItems, fetchedAt: Date.now() });
    return crdItems;
  }

  return cached?.items ?? [];
}

function replaceTargetRevision(content: string, version: string) {
  const pattern = /^(\s*targetRevision\s*:\s*)(['"]?)([^'"\r\n#]+)(\2)(\s*(?:#.*)?)$/m;
  const match = content.match(pattern);
  if (!match) {
    return null;
  }

  const currentVersion = match[3].trim();
  const updatedContent = content.replace(pattern, (_, prefix: string, quote: string, _current: string, closingQuote: string, suffix: string) => {
    return `${prefix}${quote}${version}${closingQuote}${suffix ?? ''}`;
  });

  return { currentVersion, updatedContent };
}

async function updateManifestVersion(manifest: ApplicationManifest, version: string) {
  const getFile = isOnedev() ? onedevGetFile : githubGetFile;
  const file = await getFile(manifest.filePath);
  if (!file) throw new Error('Application manifest not found');

  const updated = replaceTargetRevision(file.content, version);
  if (!updated) throw new Error('targetRevision not found in application.yaml');
  if (updated.currentVersion === version) throw new Error('Version already set in GitOps manifest');

  const message = `chore(updates): bump ${manifest.appName} to ${version}`;
  const commitSha = isOnedev()
    ? await onedevPutFile(manifest.filePath, updated.updatedContent, message)
    : await githubPutFile(manifest.filePath, updated.updatedContent, message, file.sha);

  manifestsCache = null;
  return { currentVersion: updated.currentVersion, commitSha };
}

export const updatesRoute = new Hono<AppBindings>();

updatesRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const [manifests, liveApps] = await Promise.all([
    collectApplicationManifests(),
    fetchArgoApplications(user.clusterId),
  ]);

  const payload = manifests.map((manifest) => {
    const liveApp = matchLiveApp(manifest, liveApps);

    return {
      id: manifest.id,
      name: manifest.appName,
      namespace: liveApp?.spec?.destination?.namespace ?? liveApp?.metadata?.namespace ?? manifest.namespace ?? 'default',
      section: manifest.section,
      currentVersion: getCurrentVersion(liveApp, manifest),
      targetVersion: manifest.targetRevision,
      chart: manifest.chart,
      repoUrl: manifest.repoUrl,
      syncStatus: getSyncStatus(liveApp),
      lastSync: getLastSync(liveApp),
    };
  });

  return c.json(payload);
});

updatesRoute.get('/:appName/versions', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = appNameSchema.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: 'Invalid app name' }, 400);
  }

  const manifests = await collectApplicationManifests();
  const manifest = manifests.find((item) => item.appName === parsed.data.appName || item.id === parsed.data.appName);
  const versionSource = VERSION_SOURCES[parsed.data.appName] ?? getFallbackSource(manifest);

  return c.json(await getAvailableVersions(versionSource));
});

updatesRoute.post('/:appName', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'platform:update')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsedName = appNameSchema.safeParse(c.req.param());
  if (!parsedName.success) {
    return c.json({ error: 'Invalid app name' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsedBody = updateBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const manifests = await collectApplicationManifests();
  const manifest = manifests.find((item) => item.appName === parsedName.data.appName || item.id === parsedName.data.appName);
  if (!manifest) {
    return c.json({ error: 'Application manifest not found' }, 404);
  }

  try {
    const { commitSha } = await updateManifestVersion(manifest, parsedBody.data.version);
    return c.json({
      success: true,
      commitSha,
      message: `Updated ${manifest.appName} to ${parsedBody.data.version}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update manifest';
    if (message === 'Version already set in GitOps manifest') {
      return c.json({ error: message }, 409);
    }

    if (message === 'targetRevision not found in application.yaml' || message === 'Application manifest not found') {
      return c.json({ error: message }, 422);
    }

    return c.json({
      error: message,
      success: false,
      message: `Manifest update failed for ${manifest.appName}`,
    }, 500);
  }
});
