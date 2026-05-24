import { Hono } from 'hono';
import { getCoreApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
export const eventsRoute = new Hono();
eventsRoute.get('/', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);
    const namespace = c.req.query('namespace');
    const involvedName = c.req.query('name');
    try {
        const coreApi = await getCoreApiForCluster(user.clusterId);
        const fieldSelector = involvedName ? `involvedObject.name=${involvedName}` : undefined;
        const eventsRes = namespace
            ? await coreApi.listNamespacedEvent({ namespace, fieldSelector })
            : await coreApi.listEventForAllNamespaces({ fieldSelector });
        const events = (eventsRes.items ?? [])
            .map((item) => {
            const event = item;
            const timestamp = event.lastTimestamp?.toISOString?.() ?? event.eventTime ?? null;
            return {
                name: event.metadata?.name ?? '',
                namespace: event.metadata?.namespace ?? '',
                reason: event.reason ?? '',
                message: event.message ?? '',
                type: event.type ?? 'Normal',
                count: event.count ?? 1,
                firstTimestamp: event.firstTimestamp?.toISOString?.() ?? null,
                lastTimestamp: timestamp,
                involvedObject: {
                    kind: event.involvedObject?.kind ?? '',
                    name: event.involvedObject?.name ?? '',
                },
            };
        })
            .sort((a, b) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
            .slice(0, limit);
        return c.json({ events, clusterId: user.clusterId });
    }
    catch {
        return c.json({ error: 'Failed to fetch events' }, 502);
    }
});
//# sourceMappingURL=events.js.map