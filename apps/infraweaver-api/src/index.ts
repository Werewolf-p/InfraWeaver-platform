import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { broadcastModeChange, setupWebSocketServer } from './lib/agent-registry.js';
import { initLocalCluster } from './lib/cluster-registry.js';
import { registerBroadcastFn } from './lib/mode.js';
import { authMiddleware } from './middleware/auth.js';
import { modeGuard } from './middleware/mode-guard.js';
import { requestLogger } from './middleware/logger.js';
import { agentsRoute } from './routes/agents.js';
import { argocdRoute } from './routes/argocd.js';
import { clustersRoute } from './routes/clusters.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { longhornRoute } from './routes/longhorn.js';
import { metricsRoute } from './routes/metrics.js';
import { nodesRoute } from './routes/nodes.js';
import { podsRoute } from './routes/pods.js';
import { modeRoute } from './routes/mode.js';
import { rbacSyncRoute } from './routes/rbac-sync.js';
import type { AppBindings } from './types/index.js';

registerBroadcastFn(broadcastModeChange);

const app = new Hono<AppBindings>();

app.use('*', requestLogger);
app.use('*', cors({
  origin: process.env.CONSOLE_URL ?? 'https://infraweaver.int.rlservers.com',
  credentials: true,
}));

app.route('/health', healthRoute);

const api = new Hono<AppBindings>();
api.use('*', authMiddleware);
api.use('*', modeGuard);
api.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' && !c.res.headers.has('Cache-Control')) {
    c.header('Cache-Control', 'private, max-age=30');
  }
});
api.route('/clusters', clustersRoute);
api.route('/k8s/nodes', nodesRoute);
api.route('/k8s/pods', podsRoute);
api.route('/argocd', argocdRoute);
api.route('/longhorn', longhornRoute);
api.route('/k8s/events', eventsRoute);
api.route('/metrics', metricsRoute);
api.route('/mode', modeRoute);
api.route('/rbac', rbacSyncRoute);
api.route('/agents', agentsRoute);

app.route('/v1', api);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[error]', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

initLocalCluster().catch((error) => {
  console.error('[infraweaver-api] Failed to initialize local cluster', error);
});

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
console.log(`[infraweaver-api] Starting on port ${port}`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[infraweaver-api] Listening on port ${info.port}`);
});

setupWebSocketServer(server as Parameters<typeof setupWebSocketServer>[0]);
