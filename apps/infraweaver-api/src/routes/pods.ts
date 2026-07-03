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
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  const limit = Math.min(500, Math.max(1, Number.parseInt(c.req.query('limit') ?? '0', 10) || 0));
  const paginated = c.req.query('page') !== undefined || c.req.query('limit') !== undefined;

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);
    const podList = namespace
      ? await coreApi.listNamespacedPod({ namespace })
      : await coreApi.listPodForAllNamespaces();

    const pods = ((podList as { items?: unknown[] }).items ?? []).map((item: unknown) => {
      const pod = item as {
        metadata?: {
          name?: string;
          namespace?: string;
          creationTimestamp?: Date;
          labels?: Record<string, string>;
          ownerReferences?: Array<{ kind?: string; name?: string }>;
        };
        spec?: { containers?: Array<{ name: string }>; nodeName?: string };
        status?: { phase?: string; containerStatuses?: Array<{ restartCount?: number; state?: { waiting?: { reason?: string } } }> };
      };
      const cs = pod.status?.containerStatuses ?? [];
      return {
        name: pod.metadata?.name ?? '',
        namespace: pod.metadata?.namespace ?? '',
        status: cs.find((s) => s.state?.waiting?.reason)?.state?.waiting?.reason || pod.status?.phase || 'Unknown',
        containers: (pod.spec?.containers ?? []).map((c) => c.name),
        nodeName: pod.spec?.nodeName ?? '',
        createdAt: pod.metadata?.creationTimestamp?.toISOString?.() ?? '',
        restartCount: cs.reduce((sum, s) => sum + (s.restartCount ?? 0), 0),
        // The console resolves pod→app ownership from these (lib/pod-app-grouping).
        labels: pod.metadata?.labels ?? {},
        ownerReferences: (pod.metadata?.ownerReferences ?? []).map((o) => ({ kind: o.kind ?? '', name: o.name ?? '' })),
      };
    });

    if (paginated && limit > 0) {
      const total = pods.length;
      const offset = (page - 1) * limit;
      return c.json({ pods: pods.slice(offset, offset + limit), total, page, pages: Math.max(1, Math.ceil(total / limit)), clusterId: user.clusterId });
    }
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

    const podContainers = (pod.spec?.containers ?? [])
      .map((ct) => ct.name)
      .filter((n): n is string => Boolean(n));
    const requested = c.req.query('container');
    // Only forward a container name that actually exists on the pod, never the
    // raw query value, so a crafted name can't be used to manipulate the
    // request sent to the kube-apiserver.
    if (requested && !podContainers.includes(requested)) {
      return c.json({ error: 'Unknown container for pod' }, 400);
    }
    const container = requested ?? podContainers[0];
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
