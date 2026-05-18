import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { z } from 'zod';
import { VERSION_SOURCES, type VersionSource, type VersionSourceType } from '../config/version-sources.js';
import { getCluster } from '../lib/cluster-registry.js';
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

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRoot();
const kubernetesRoot = path.join(repoRoot, 'kubernetes');
const argoAppsCache = new Map<string, { fetchedAt: number; items: ArgoApplication[] }>();

function walkUpForRepoRoot(startDir: string) {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(currentDir, 'kubernetes'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function resolveRepoRoot() {
  const candidates = [process.cwd(), moduleDir];

  for (const candidate of candidates) {
    const resolved = walkUpForRepoRoot(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('Unable to resolve repository root');
}

function quoteForShell(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

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
  const directCandidates = new Set([
    manifest.id,
    manifest.appName,
    manifest.releaseName ?? undefined,
    manifest.releaseName ? `${manifest.section}-${manifest.releaseName}` : undefined,
  ]);

  for (const candidate of directCandidates) {
    if (!candidate) {
      continue;
    }

    const directMatch = apps.find((app) => app.metadata?.name === candidate);
    if (directMatch) {
      return directMatch;
    }
  }

  return apps.find((app) => {
    const liveName = app.metadata?.name ?? '';
    return liveName.endsWith(`-${manifest.appName}`)
      || liveName.includes(manifest.appName)
      || (manifest.releaseName ? liveName.includes(manifest.releaseName) : false);
  });
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
  let insideEntries = false;
  let insideChart = false;

  for (const line of lines) {
    if (!insideEntries) {
      if (line.trim() === 'entries:') {
        insideEntries = true;
      }
      continue;
    }

    const chartHeaderMatch = /^  ([^:#][^:]*):\s*$/.exec(line);
    if (chartHeaderMatch) {
      insideChart = chartHeaderMatch[1] === chartName;
      continue;
    }

    if (!insideChart) {
      continue;
    }

    const versionMatch = /^\s+version:\s*['"]?([^'"\n]+)['"]?\s*$/.exec(line);
    if (versionMatch) {
      versions.push(versionMatch[1].trim());
    }
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
  const indexYaml = await fetch(indexUrl, { signal: AbortSignal.timeout(8000) }).then((response) => {
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

async function collectApplicationManifests(directory = kubernetesRoot): Promise<ApplicationManifest[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests: ApplicationManifest[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...await collectApplicationManifests(entryPath));
      continue;
    }

    if (!entry.isFile() || entry.name !== 'application.yaml') {
      continue;
    }

    const fileContent = await readFile(entryPath, 'utf8');
    const values = parseFlatYaml(fileContent);
    const relativePath = path.relative(kubernetesRoot, entryPath);
    const pathParts = relativePath.split(path.sep);
    const section = pathParts[0] ?? 'apps';
    const appName = path.basename(path.dirname(entryPath));

    manifests.push({
      appName,
      chart: values.chart ?? null,
      filePath: entryPath,
      id: `${section}-${appName}`,
      namespace: values.namespace ?? null,
      releaseName: values.releaseName ?? null,
      repoUrl: values.repoURL ?? null,
      section,
      targetRevision: values.targetRevision ?? null,
    });
  }

  return manifests.sort((left, right) => left.appName.localeCompare(right.appName));
}

async function getArgoConfig(clusterId: string): Promise<{ server: string; token: string }> {
  if (clusterId === 'local') {
    return {
      server: process.env.ARGOCD_SERVER ?? 'http://argocd-server.argocd.svc.cluster.local:80',
      token: process.env.ARGOCD_TOKEN ?? '',
    };
  }

  const cluster = await getCluster(clusterId);
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
  const fileContent = await readFile(manifest.filePath, 'utf8');
  const updated = replaceTargetRevision(fileContent, version);

  if (!updated) {
    throw new Error('targetRevision not found in application.yaml');
  }

  if (updated.currentVersion === version) {
    throw new Error('Version already set in GitOps manifest');
  }

  await writeFile(manifest.filePath, updated.updatedContent, 'utf8');
  return updated.currentVersion;
}

function commitAndPushManifestChange(filePath: string, appName: string, version: string) {
  const relativeFilePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  const commitMessage = `chore(updates): bump ${appName} to ${version}`;

  execSync(`git -C ${quoteForShell(repoRoot)} --no-pager add -- ${quoteForShell(relativeFilePath)}`, { stdio: 'pipe' });
  execSync(`git -C ${quoteForShell(repoRoot)} --no-pager commit -m ${quoteForShell(commitMessage)}`, { stdio: 'pipe' });
  const commitSha = execSync(`git -C ${quoteForShell(repoRoot)} rev-parse HEAD`, { encoding: 'utf8', stdio: 'pipe' }).trim();
  execSync(`git -C ${quoteForShell(repoRoot)} --no-pager push`, { stdio: 'pipe' });

  return commitSha;
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
  if (!hasPermission(user, 'apps:write')) {
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
    await updateManifestVersion(manifest, parsedBody.data.version);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update manifest';
    const status = message === 'Version already set in GitOps manifest' ? 409 : 422;
    return c.json({ error: message }, status);
  }

  try {
    const commitSha = commitAndPushManifestChange(manifest.filePath, manifest.appName, parsedBody.data.version);
    return c.json({
      success: true,
      commitSha,
      message: `Updated ${manifest.appName} to ${parsedBody.data.version}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git push failed';
    return c.json({
      error: message,
      success: false,
      message: `Manifest updated but git push failed for ${manifest.appName}`,
    }, 500);
  }
});
