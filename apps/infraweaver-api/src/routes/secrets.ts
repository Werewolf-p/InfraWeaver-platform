import { Hono } from 'hono';
import { getCoreApiForCluster, getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

export const secretsRoute = new Hono<AppBindings>();

secretsRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return c.json({ error: 'Forbidden' }, 403);
  const namespace = c.req.query('namespace');
  try {
    const [coreApi, customApi] = await Promise.all([
      getCoreApiForCluster(user.clusterId),
      getCustomApiForCluster(user.clusterId),
    ]);

    const [secretResponse, externalSecretsResponse] = await Promise.all([
      namespace && namespace !== 'all'
        ? coreApi.listNamespacedSecret({ namespace })
        : coreApi.listSecretForAllNamespaces(),
      customApi.listClusterCustomObject({ group: 'external-secrets.io', version: 'v1beta1', plural: 'externalsecrets' }).catch(() => ({ items: [] })),
    ]);

    const externalSecrets = (((externalSecretsResponse as { items?: unknown[] }).items ?? [])).map((item) => {
      const es = item as { metadata?: { name?: string; namespace?: string }; spec?: { target?: { name?: string } } };
      return { name: es.metadata?.name ?? '', namespace: es.metadata?.namespace ?? 'default', targetSecret: es.spec?.target?.name ?? es.metadata?.name ?? '' };
    });

    const managedSecrets = new Map(externalSecrets.map((es) => [`${es.namespace}/${es.targetSecret}`, `${es.namespace}/${es.name}`] as const));

    const secrets = secretResponse.items
      .map((secret) => {
        const ns = secret.metadata?.namespace ?? 'default';
        const name = secret.metadata?.name ?? '';
        const keyNames = Object.keys(secret.data ?? {}).sort();
        const ownerRef = secret.metadata?.ownerReferences?.find((o) => o.kind === 'ExternalSecret')?.name ?? null;
        return {
          name,
          namespace: ns,
          type: secret.type ?? 'Opaque',
          age: secret.metadata?.creationTimestamp?.toISOString?.() ?? null,
          keyCount: keyNames.length,
          keyNames,
          externalSecret: ownerRef ? `${ns}/${ownerRef}` : managedSecrets.get(`${ns}/${name}`) ?? null,
        };
      })
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

    return c.json({ secrets });
  } catch {
    return c.json({ error: 'Kubernetes unavailable' }, 503);
  }
});

secretsRoute.delete('/:namespace/:name', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return c.json({ error: 'Forbidden' }, 403);
  if (user.clusterId === 'all') return c.json({ error: 'Select a specific cluster before performing this action' }, 400);

  const { namespace, name } = c.req.param();
  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    await coreApi.deleteNamespacedSecret({ namespace, name });
    return c.json({ ok: true, namespace, name });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Operation failed' }, 502);
  }
});
