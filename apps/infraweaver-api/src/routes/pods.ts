import { Hono } from 'hono';
import { z } from 'zod';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

const podTargetSchema = z.object({
  namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'Invalid namespace'),
  name: z.string().regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'Invalid pod name'),
});

export const podsRoute = new Hono<AppBindings>();

podsRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const namespace = c.req.query('namespace');

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const podList = namespace
      ? await coreApi.listNamespacedPod({ namespace })
      : await coreApi.listPodForAllNamespaces();

    const pods = ((podList as { items?: unknown[] }).items ?? []).map((item: unknown) => {
      const pod = item as {
        metadata?: { name?: string; namespace?: string; creationTimestamp?: Date };
        spec?: { containers?: Array<{ name: string }>; nodeName?: string };
        status?: {
          phase?: string;
          containerStatuses?: Array<{ restartCount?: number; state?: { waiting?: { reason?: string } } }>;
        };
      };

      const containerStatuses = pod.status?.containerStatuses ?? [];
      const waitingReason = containerStatuses.find((status) => status.state?.waiting?.reason)?.state?.waiting?.reason ?? '';

      return {
        name: pod.metadata?.name ?? '',
        namespace: pod.metadata?.namespace ?? '',
        status: waitingReason || pod.status?.phase || 'Unknown',
        containers: (pod.spec?.containers ?? []).map((container) => container.name),
        nodeName: pod.spec?.nodeName ?? '',
        createdAt: pod.metadata?.creationTimestamp?.toISOString?.() ?? '',
        restartCount: containerStatuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
      };
    });

    return c.json({ pods, clusterId: user.clusterId });
  } catch {
    return c.json({ error: 'Failed to fetch pods' }, 502);
  }
});

podsRoute.get('/:namespace/:name/logs', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const parsed = podTargetSchema.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: 'Invalid pod target' }, 400);
  }

  const tailLines = Math.min(Math.max(Number.parseInt(c.req.query('lines') ?? '500', 10) || 500, 1), 1000);

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const pod = await coreApi.readNamespacedPod({
      name: parsed.data.name,
      namespace: parsed.data.namespace,
    }) as {
      spec?: { containers?: Array<{ name?: string }> };
    };

    const container = c.req.query('container') ?? pod.spec?.containers?.[0]?.name;
    if (!container) {
      return c.json({ error: 'Pod container not found' }, 404);
    }

    const logs = await coreApi.readNamespacedPodLog({
      name: parsed.data.name,
      namespace: parsed.data.namespace,
      container,
      tailLines,
      timestamps: true,
    }) as unknown as string;

    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(logs);
  } catch {
    return c.json({ error: 'Failed to fetch pod logs' }, 502);
  }
});
