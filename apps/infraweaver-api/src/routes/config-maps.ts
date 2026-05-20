import { Hono } from 'hono';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

const updateSchema = z.object({
  data: z.record(z.string(), z.string()),
});

function toSummary(cm: k8s.V1ConfigMap) {
  const data = cm.data ?? {};
  return {
    name: cm.metadata?.name ?? '',
    namespace: cm.metadata?.namespace ?? 'default',
    age: cm.metadata?.creationTimestamp?.toISOString?.() ?? null,
    immutable: Boolean(cm.immutable),
    keys: Object.keys(data).sort(),
    binaryKeys: Object.keys(cm.binaryData ?? {}).sort(),
    data,
  };
}

export const configMapsRoute = new Hono<AppBindings>();

configMapsRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return c.json({ error: 'Forbidden' }, 403);
  const namespace = c.req.query('namespace');
  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const response = namespace && namespace !== 'all'
      ? await coreApi.listNamespacedConfigMap({ namespace })
      : await coreApi.listConfigMapForAllNamespaces();
    const configMaps = response.items
      .map((item) => toSummary(item))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    return c.json({ configMaps });
  } catch {
    return c.json({ error: 'Kubernetes unavailable' }, 503);
  }
});

configMapsRoute.patch('/:namespace/:name', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return c.json({ error: 'Forbidden' }, 403);
  if (user.clusterId === 'all') return c.json({ error: 'Select a specific cluster before performing this action' }, 400);

  const { namespace, name } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const existing = await coreApi.readNamespacedConfigMap({ name, namespace });
    await coreApi.replaceNamespacedConfigMap({ name, namespace, body: { ...existing, data: parsed.data.data } });
    const updated = await coreApi.readNamespacedConfigMap({ name, namespace });
    return c.json({ ok: true, configMap: toSummary(updated) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Operation failed' }, 502);
  }
});

configMapsRoute.delete('/:namespace/:name', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return c.json({ error: 'Forbidden' }, 403);
  if (user.clusterId === 'all') return c.json({ error: 'Select a specific cluster before performing this action' }, 400);

  const { namespace, name } = c.req.param();
  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    await coreApi.deleteNamespacedConfigMap({ namespace, name });
    return c.json({ ok: true, namespace, name });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Operation failed' }, 502);
  }
});
