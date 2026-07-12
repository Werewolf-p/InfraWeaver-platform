import { Hono } from 'hono';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import { errMessage } from '../lib/errors.js';
import { forbidden, badRequest, invalidBody, upstream } from '../lib/responses.js';
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
  if (!hasPermission(user, 'cluster:admin')) return forbidden(c);
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
  if (!hasPermission(user, 'cluster:admin')) return forbidden(c);
  if (user.clusterId === 'all') return badRequest(c, 'Select a specific cluster before performing this action');

  const { namespace, name } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return invalidBody(c, parsed.error);

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const existing = await coreApi.readNamespacedConfigMap({ name, namespace });
    await coreApi.replaceNamespacedConfigMap({ name, namespace, body: { ...existing, data: parsed.data.data } });
    const updated = await coreApi.readNamespacedConfigMap({ name, namespace });
    return c.json({ ok: true, configMap: toSummary(updated) });
  } catch (err) {
    return upstream(c, errMessage(err, 'Operation failed'));
  }
});

configMapsRoute.delete('/:namespace/:name', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return forbidden(c);
  if (user.clusterId === 'all') return badRequest(c, 'Select a specific cluster before performing this action');

  const { namespace, name } = c.req.param();
  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    await coreApi.deleteNamespacedConfigMap({ namespace, name });
    return c.json({ ok: true, namespace, name });
  } catch (err) {
    return upstream(c, errMessage(err, 'Operation failed'));
  }
});
