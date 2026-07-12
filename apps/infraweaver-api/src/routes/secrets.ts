import { Hono } from 'hono';
import { getCoreApiForCluster, getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import { errMessage } from '../lib/errors.js';
import { forbidden, badRequest, upstream } from '../lib/responses.js';
import type { AppBindings } from '../types/index.js';

export const secretsRoute = new Hono<AppBindings>();

secretsRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'security:read') && !hasPermission(user, 'cluster:admin')) return forbidden(c);
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
      customApi.listClusterCustomObject({ group: 'external-secrets.io', version: 'v1', plural: 'externalsecrets' }).catch(() => ({ items: [] })),
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
  if (!hasPermission(user, 'cluster:admin')) return forbidden(c);
  if (user.clusterId === 'all') return badRequest(c, 'Select a specific cluster before performing this action');

  const { namespace, name } = c.req.param();
  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    await coreApi.deleteNamespacedSecret({ namespace, name });
    return c.json({ ok: true, namespace, name });
  } catch (err) {
    return upstream(c, errMessage(err, 'Operation failed'));
  }
});
