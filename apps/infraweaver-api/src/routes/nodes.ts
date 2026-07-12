import { Hono } from 'hono';
import { z } from 'zod';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import { errMessage } from '../lib/errors.js';
import { forbidden, badRequest, invalidBody, upstream } from '../lib/responses.js';
import type { AppBindings } from '../types/index.js';

const cordonSchema = z.object({ cordon: z.boolean() });

export const nodesRoute = new Hono<AppBindings>();

nodesRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return forbidden(c);
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
    return upstream(c, 'Failed to fetch nodes');
  }
});

nodesRoute.patch('/:name/cordon', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) return forbidden(c);
  if (user.clusterId === 'all') return badRequest(c, 'Select a specific cluster before performing this action');

  const { name } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const parsed = cordonSchema.safeParse(body);
  if (!parsed.success) return invalidBody(c, parsed.error);

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    await coreApi.patchNode({ name, body: { spec: { unschedulable: parsed.data.cordon } }, fieldManager: 'infraweaver' });
    return c.json({ ok: true, node: name, cordon: parsed.data.cordon });
  } catch (err) {
    return c.json({ ok: false, error: errMessage(err, 'Operation failed') }, 502);
  }
});
