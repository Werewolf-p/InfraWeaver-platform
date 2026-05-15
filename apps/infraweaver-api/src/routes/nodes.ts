import { Hono } from 'hono';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

export const nodesRoute = new Hono<AppBindings>();

nodesRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const nodes = await coreApi.listNode();
    const result = ((nodes as { items?: unknown[] }).items ?? []).map((item: unknown) => {
      const node = item as {
        metadata?: { name?: string; labels?: Record<string, string>; creationTimestamp?: Date };
        status?: {
          conditions?: Array<{ type?: string; status?: string }>;
          nodeInfo?: { kubeletVersion?: string; osImage?: string };
          capacity?: { cpu?: string; memory?: string };
          addresses?: Array<{ type?: string; address?: string }>;
        };
        spec?: { unschedulable?: boolean };
      };

      return {
        name: node.metadata?.name ?? '',
        status: node.status?.conditions?.find((condition) => condition.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
        roles: Object.keys(node.metadata?.labels ?? {})
          .filter((label) => label.startsWith('node-role.kubernetes.io/'))
          .map((label) => label.replace('node-role.kubernetes.io/', '')),
        version: node.status?.nodeInfo?.kubeletVersion ?? '',
        os: node.status?.nodeInfo?.osImage ?? '',
        cpu: node.status?.capacity?.cpu ?? '',
        memory: node.status?.capacity?.memory ?? '',
        ip: node.status?.addresses?.find((address) => address.type === 'InternalIP')?.address ?? '',
        unschedulable: node.spec?.unschedulable ?? false,
        age: node.metadata?.creationTimestamp?.toISOString?.() ?? null,
      };
    });

    return c.json({ nodes: result, clusterId: user.clusterId });
  } catch {
    return c.json({ error: 'Failed to fetch nodes' }, 502);
  }
});
