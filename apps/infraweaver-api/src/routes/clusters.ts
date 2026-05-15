import { Hono } from 'hono';
import { z } from 'zod';
import { addCluster, getCluster, listClusters, removeCluster, updateClusterStatus } from '../lib/cluster-registry.js';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings, ClusterMeta } from '../types/index.js';

const clusterIdSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid cluster id'),
});

const createClusterSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid cluster id'),
  name: z.string().min(1),
  description: z.string().default(''),
  endpoint: z.string().url(),
  tags: z.array(z.string()).default([]),
  kubeconfig: z.string().min(1),
  argocdServer: z.string().url().optional(),
  argocdToken: z.string().min(1).optional(),
});

export const clustersRoute = new Hono<AppBindings>();

clustersRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json(await listClusters());
});

clustersRoute.post('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = createClusterSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  if (await getCluster(parsed.data.id)) {
    return c.json({ error: 'Cluster already exists' }, 409);
  }

  const meta: ClusterMeta = {
    id: parsed.data.id,
    name: parsed.data.name,
    description: parsed.data.description,
    endpoint: parsed.data.endpoint,
    tags: parsed.data.tags,
    status: 'unknown',
    lastSeen: new Date().toISOString(),
    isLocal: false,
    argocdServer: parsed.data.argocdServer,
    argocdToken: parsed.data.argocdToken,
  };

  await addCluster(meta, parsed.data.kubeconfig);
  return c.json({ ok: true, cluster: { ...meta, argocdToken: undefined } }, 201);
});

clustersRoute.delete('/:id', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = clusterIdSchema.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: 'Invalid cluster id' }, 400);
  }

  const existing = await getCluster(parsed.data.id);
  if (!existing) {
    return c.json({ error: 'Cluster not found' }, 404);
  }

  await removeCluster(parsed.data.id);
  return c.json({ ok: true });
});

clustersRoute.get('/:id/health', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = clusterIdSchema.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: 'Invalid cluster id' }, 400);
  }

  const cluster = await getCluster(parsed.data.id);
  if (!cluster) {
    return c.json({ error: 'Cluster not found' }, 404);
  }

  try {
    const coreApi = await getCoreApiForCluster(parsed.data.id);
    await coreApi.listNamespace({ limit: 1 });
    await updateClusterStatus(parsed.data.id, 'healthy');
    const fresh = await getCluster(parsed.data.id);
    return c.json({ id: parsed.data.id, status: 'healthy', lastSeen: fresh?.lastSeen ?? new Date().toISOString() });
  } catch {
    await updateClusterStatus(parsed.data.id, 'offline');
    const fresh = await getCluster(parsed.data.id);
    return c.json({ id: parsed.data.id, status: 'offline', lastSeen: fresh?.lastSeen ?? new Date().toISOString() });
  }
});
