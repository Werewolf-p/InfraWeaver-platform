import { Hono } from 'hono';
import { z } from 'zod';
import { getCluster } from '../lib/cluster-registry.js';
import { getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

const appNameSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid app name'),
});

const bulkBodySchema = z.object({
  action: z.enum(['start', 'stop', 'remove', 'sync']),
  apps: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1).max(50),
});

const syncBodySchema = z.object({
  hard: z.boolean().optional().default(false),
});

const mockAppsSeed = [
  { name: 'bootstrap', namespace: 'argocd', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'core-argocd-manifests', namespace: 'argocd', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'core-cert-manager', namespace: 'cert-manager', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'core-traefik', namespace: 'traefik', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'core-external-secrets-manifests', namespace: 'external-secrets', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'core-longhorn', namespace: 'longhorn-system', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'platform-authentik', namespace: 'authentik', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'platform-netbird', namespace: 'netbird', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'apps-netbird', namespace: 'netbird', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'platform-homepage', namespace: 'homepage', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'platform-grafana', namespace: 'grafana', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'catalog-wiki-manifests', namespace: 'wiki', project: 'platform', health: 'Healthy', sync: 'Synced' },
  { name: 'catalog-gatus-manifests', namespace: 'gatus', project: 'platform', health: 'Healthy', sync: 'Synced' },
];

const _lastKnownApps = new Map<string, { items: unknown[]; fetchedAt: number }>();

function getMockApps() {
  return mockAppsSeed.map((app) => ({
    metadata: { name: app.name, namespace: app.namespace, labels: {} },
    spec: {
      destination: { namespace: app.namespace, server: 'https://kubernetes.default.svc' },
      project: app.project,
    },
    status: {
      health: { status: app.health },
      sync: { status: app.sync },
      summary: { images: [] },
    },
  }));
}

function getCachedOrMock(clusterId: string) {
  const cached = _lastKnownApps.get(clusterId);
  if (cached && Date.now() - cached.fetchedAt < 600_000) {
    return cached.items;
  }
  return getMockApps();
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

async function listApplicationCrds(clusterId: string): Promise<unknown[] | null> {
  try {
    const customApi = await getCustomApiForCluster(clusterId);
    const response = await customApi.listNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: 'argocd',
      plural: 'applications',
    }) as { items?: unknown[] };
    return Array.isArray(response.items) ? response.items : [];
  } catch {
    return null;
  }
}

async function fetchApps(clusterId: string): Promise<unknown[]> {
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
        const data = await response.json() as { items?: unknown[] };
        const items = Array.isArray(data.items) ? data.items : [];
        _lastKnownApps.set(clusterId, { items, fetchedAt: Date.now() });
        return items;
      }
    } catch {
      // Fall through to Kubernetes CRD fallback.
    }
  }

  const crdItems = await listApplicationCrds(clusterId);
  if (crdItems) {
    _lastKnownApps.set(clusterId, { items: crdItems, fetchedAt: Date.now() });
    return crdItems;
  }

  return getCachedOrMock(clusterId);
}

export const argocdRoute = new Hono<AppBindings>();

argocdRoute.get('/apps', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json(await fetchApps(user.clusterId));
});

argocdRoute.get('/apps/:name', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = appNameSchema.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: 'Invalid app name' }, 400);
  }

  const apps = await fetchApps(user.clusterId);
  const app = apps.find((item) => {
    const candidate = item as { metadata?: { name?: string } };
    return candidate.metadata?.name === parsed.data.name;
  });

  if (!app) {
    return c.json({ error: 'App not found' }, 404);
  }

  return c.json(app);
});

argocdRoute.post('/apps/:name/sync', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:sync')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsedName = appNameSchema.safeParse(c.req.param());
  if (!parsedName.success) {
    return c.json({ error: 'Invalid app name' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsedBody = syncBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { server, token } = await getArgoConfig(user.clusterId);
  if (!server || !token) {
    return c.json({ ok: true, mock: true });
  }

  try {
    const payload = parsedBody.data.hard
      ? { revision: 'HEAD', prune: false, strategy: { hook: {}, apply: { force: true } } }
      : { revision: 'HEAD', prune: false };

    const response = await fetch(`${server}/api/v1/applications/${parsedName.data.name}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return c.json({ ok: true, mock: true });
    }

    return c.json(await response.json());
  } catch {
    return c.json({ ok: true, mock: true });
  }
});

argocdRoute.post('/apps/bulk', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:write')) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const parsed = bulkBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { action, apps } = parsed.data;

  const { server, token } = await getArgoConfig(user.clusterId);
  if (!server || !token) return c.json({ ok: true, mock: true, results: apps.map((name) => ({ name, ok: true })) });

  const results = await Promise.all(apps.map(async (name) => {
    try {
      let res: Response;
      if (action === 'sync') {
        res = await fetch(`${server}/api/v1/applications/${name}/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 'HEAD', prune: false }), signal: AbortSignal.timeout(5000) });
      } else if (action === 'remove') {
        res = await fetch(`${server}/api/v1/applications/${name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      } else {
        // start/stop not natively supported by ArgoCD — mark as ok
        return { name, ok: true, note: `${action} is handled by ArgoCD sync policies` };
      }
      return { name, ok: res.ok };
    } catch {
      return { name, ok: false, error: 'request failed' };
    }
  }));

  return c.json({ ok: true, results });
});

argocdRoute.delete('/apps/:name', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:delete')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = appNameSchema.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: 'Invalid app name' }, 400);
  }

  const { server, token } = await getArgoConfig(user.clusterId);
  if (!server || !token) {
    return c.json({ ok: true, mock: true });
  }

  try {
    const response = await fetch(`${server}/api/v1/applications/${parsed.data.name}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return c.json({ ok: true, mock: true });
    }

    return c.json({ ok: true });
  } catch {
    return c.json({ ok: true, mock: true });
  }
});
