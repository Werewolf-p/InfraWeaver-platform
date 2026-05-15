import { Hono } from 'hono';
import { getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

export const longhornRoute = new Hono<AppBindings>();

longhornRoute.get('/volumes', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const customApi = await getCustomApiForCluster(user.clusterId);
    const response = await customApi.listNamespacedCustomObject({
      group: 'longhorn.io',
      version: 'v1beta2',
      namespace: 'longhorn-system',
      plural: 'volumes',
    }) as { items?: unknown[] };

    const volumes = (response.items ?? []).map((item: unknown) => {
      const volume = item as {
        metadata?: { name?: string };
        spec?: { size?: string; numberOfReplicas?: number };
        status?: {
          actualSize?: string;
          robustness?: string;
          state?: string;
          kubernetesStatus?: unknown;
        };
      };

      return {
        name: volume.metadata?.name ?? '',
        size: Number.parseInt(volume.spec?.size ?? '0', 10) || 0,
        actualSize: Number.parseInt(volume.status?.actualSize ?? '0', 10) || 0,
        robustness: volume.status?.robustness ?? 'unknown',
        numberOfReplicas: volume.spec?.numberOfReplicas ?? 0,
        state: volume.status?.state ?? 'unknown',
        kubernetesStatus: volume.status?.kubernetesStatus ?? null,
      };
    });

    return c.json(volumes);
  } catch {
    return c.json({ error: 'Failed to fetch Longhorn volumes' }, 502);
  }
});
