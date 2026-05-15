import { Hono } from 'hono';
import { getCoreApiForCluster, getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

function parseCpuToMillicores(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  if (value.endsWith('n')) {
    return Math.round(Number.parseInt(value, 10) / 1_000_000);
  }
  if (value.endsWith('m')) {
    return Number.parseInt(value, 10) || 0;
  }
  return Math.round((Number.parseFloat(value) || 0) * 1000);
}

function parseMemoryToKi(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  if (value.endsWith('Ki')) {
    return Number.parseInt(value, 10) || 0;
  }
  if (value.endsWith('Mi')) {
    return (Number.parseInt(value, 10) || 0) * 1024;
  }
  if (value.endsWith('Gi')) {
    return (Number.parseInt(value, 10) || 0) * 1024 * 1024;
  }
  return Math.round((Number.parseInt(value, 10) || 0) / 1024);
}

function parseMemoryToMi(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  if (value.endsWith('Ki')) {
    return Math.round((Number.parseInt(value, 10) || 0) / 1024);
  }
  if (value.endsWith('Mi')) {
    return Number.parseInt(value, 10) || 0;
  }
  if (value.endsWith('Gi')) {
    return (Number.parseInt(value, 10) || 0) * 1024;
  }
  return Number.parseInt(value, 10) || 0;
}

export const metricsRoute = new Hono<AppBindings>();

metricsRoute.get('/nodes', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const [customApi, coreApi] = await Promise.all([
      getCustomApiForCluster(user.clusterId),
      getCoreApiForCluster(user.clusterId),
    ]);
    const [metricsResponse, nodesResponse] = await Promise.all([
      customApi.listClusterCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        plural: 'nodes',
      }) as Promise<{ items?: unknown[] }>,
      coreApi.listNode(),
    ]);

    const capacityMap: Record<string, { cpuCores: number; memoryKi: number; pods: number }> = {};
    for (const item of (nodesResponse as { items?: unknown[] }).items ?? []) {
      const node = item as {
        metadata?: { name?: string };
        status?: { capacity?: { cpu?: string; memory?: string; pods?: string } };
      };

      const name = node.metadata?.name ?? '';
      capacityMap[name] = {
        cpuCores: Number.parseFloat(node.status?.capacity?.cpu ?? '0') || 0,
        memoryKi: parseMemoryToKi(node.status?.capacity?.memory),
        pods: Number.parseInt(node.status?.capacity?.pods ?? '110', 10) || 110,
      };
    }

    const metrics = (metricsResponse.items ?? []).map((item: unknown) => {
      const metric = item as {
        metadata?: { name?: string };
        usage?: { cpu?: string; memory?: string };
      };

      const name = metric.metadata?.name ?? '';
      const cpuMillicores = parseCpuToMillicores(metric.usage?.cpu);
      const memoryKi = parseMemoryToKi(metric.usage?.memory);
      const capacity = capacityMap[name] ?? { cpuCores: 0, memoryKi: 0, pods: 110 };

      return {
        name,
        cpuPct: capacity.cpuCores > 0 ? Math.min(Math.round((cpuMillicores / (capacity.cpuCores * 1000)) * 100), 100) : 0,
        memPct: capacity.memoryKi > 0 ? Math.min(Math.round((memoryKi / capacity.memoryKi) * 100), 100) : 0,
        cpuMillicores,
        memKi: memoryKi,
      };
    });

    return c.json({ metrics, timestamp: new Date().toISOString(), clusterId: user.clusterId });
  } catch {
    return c.json({ error: 'Failed to fetch node metrics' }, 502);
  }
});

metricsRoute.get('/pods', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const [customApi, coreApi] = await Promise.all([
      getCustomApiForCluster(user.clusterId),
      getCoreApiForCluster(user.clusterId),
    ]);
    const [metricsResponse, podsResponse] = await Promise.all([
      customApi.listClusterCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        plural: 'pods',
      }) as Promise<{ items?: unknown[] }>,
      coreApi.listPodForAllNamespaces(),
    ]);

    const limitsMap: Record<string, Record<string, { cpuLimit: number; memLimit: number }>> = {};
    for (const item of (podsResponse as { items?: unknown[] }).items ?? []) {
      const pod = item as {
        metadata?: { name?: string; namespace?: string };
        spec?: { containers?: Array<{ name?: string; resources?: { limits?: { cpu?: string; memory?: string } } }> };
      };

      const key = `${pod.metadata?.namespace ?? ''}/${pod.metadata?.name ?? ''}`;
      limitsMap[key] = {};
      for (const container of pod.spec?.containers ?? []) {
        limitsMap[key][container.name ?? ''] = {
          cpuLimit: parseCpuToMillicores(container.resources?.limits?.cpu),
          memLimit: parseMemoryToMi(container.resources?.limits?.memory),
        };
      }
    }

    const pods = (metricsResponse.items ?? []).map((item: unknown) => {
      const metric = item as {
        metadata?: { name?: string; namespace?: string };
        containers?: Array<{ name?: string; usage?: { cpu?: string; memory?: string } }>;
      };

      const key = `${metric.metadata?.namespace ?? ''}/${metric.metadata?.name ?? ''}`;
      return {
        namespace: metric.metadata?.namespace ?? '',
        name: metric.metadata?.name ?? '',
        containers: (metric.containers ?? []).map((container) => {
          const limit = limitsMap[key]?.[container.name ?? ''] ?? { cpuLimit: 0, memLimit: 0 };
          return {
            name: container.name ?? '',
            cpu_m: parseCpuToMillicores(container.usage?.cpu),
            memory_mi: parseMemoryToMi(container.usage?.memory),
            cpu_limit_m: limit.cpuLimit,
            memory_limit_mi: limit.memLimit,
          };
        }),
      };
    });

    return c.json({ pods, timestamp: new Date().toISOString(), clusterId: user.clusterId });
  } catch {
    return c.json({ error: 'Failed to fetch pod metrics' }, 502);
  }
});
