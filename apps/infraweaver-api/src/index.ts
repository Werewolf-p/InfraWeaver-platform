import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { broadcastModeChange, setupWebSocketServer } from './lib/agent-registry.js';
import { bootstrapConsoleSecret } from './lib/bootstrap.js';
import { initLocalCluster } from './lib/cluster-registry.js';
import { registerBroadcastFn } from './lib/mode.js';
import { authMiddleware } from './middleware/auth.js';
import { modeGuard } from './middleware/mode-guard.js';
import { requestLogger } from './middleware/logger.js';
import { securityHeaders } from './middleware/security-headers.js';
import { agentsRoute } from './routes/agents.js';
import { argocdRoute } from './routes/argocd.js';
import { clusterRoute } from './routes/cluster.js';
import { clustersRoute } from './routes/clusters.js';
import { communityAppsRoute } from './routes/community-apps.js';
import { configMapsRoute } from './routes/config-maps.js';
import { eventsRoute } from './routes/events.js';
import { execRoute } from './routes/exec.js';
import { healthRoute } from './routes/health.js';
import { longhornRoute } from './routes/longhorn.js';
import { metricsRoute } from './routes/metrics.js';
import { networkRoute } from './routes/network.js';
import { nodesRoute } from './routes/nodes.js';
import { podsRoute } from './routes/pods.js';
import { modeRoute } from './routes/mode.js';
import { prometheusRoute } from './routes/prometheus.js';
import { rbacSyncRoute } from './routes/rbac-sync.js';
import { secretsRoute } from './routes/secrets.js';
import { updatesRoute } from './routes/updates.js';
import { platformRoute } from './routes/platform.js';
import { dnsRoute } from './routes/dns.js';
import type { AppBindings } from './types/index.js';

const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  await next();
});
app.use('*', requestLogger);
app.use('*', securityHeaders);
app.use('*', cors({
  origin: process.env.CONSOLE_URL ?? 'https://infraweaver.int.yourdomain.com',
  credentials: true,
}));

app.route('/health', healthRoute);
app.route('/metrics', prometheusRoute);

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
api.route('/updates', updatesRoute);
api.route('/platform', platformRoute);
api.route('/cluster', clusterRoute);
api.route('/network', networkRoute);
api.route('/dns', dnsRoute);
api.route('/config-maps', configMapsRoute);
api.route('/secrets', secretsRoute);
api.route('/exec', execRoute);
api.route('/community-apps', communityAppsRoute);

app.route('/api/v1', api);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[error]', err.message, err.stack);
  return c.json({ error: 'Internal server error' }, 500);
});

async function main() {
  await bootstrapConsoleSecret().catch((error) => {
    console.warn('[bootstrap] Could not auto-bootstrap secret (running outside cluster?):', error.message);
  });

  registerBroadcastFn(broadcastModeChange);

  initLocalCluster().catch((error) => {
    console.error('[infraweaver-api] Failed to initialize local cluster', error);
  });

  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  console.log(`[infraweaver-api] Starting on port ${port}`);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[infraweaver-api] Listening on port ${info.port}`);
  });

  setupWebSocketServer(server as Parameters<typeof setupWebSocketServer>[0]);

  const shutdown = (signal: string) => {
    process.stdout.write(JSON.stringify({ level: 'info', event: 'shutdown', signal, timestamp: new Date().toISOString() }) + '\n');
    const httpServer = server as { close?: (cb: () => void) => void };
    const timeout = setTimeout(() => {
      process.stdout.write(JSON.stringify({ level: 'warn', event: 'shutdown_timeout', timestamp: new Date().toISOString() }) + '\n');
      process.exit(0);
    }, 30_000);
    timeout.unref();
    if (httpServer.close) {
      httpServer.close(() => {
        process.stdout.write(JSON.stringify({ level: 'info', event: 'shutdown_complete', timestamp: new Date().toISOString() }) + '\n');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[infraweaver-api] Fatal error', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  process.stdout.write(JSON.stringify({ level: 'error', event: 'unhandledRejection', reason: String(reason), timestamp: new Date().toISOString() }) + '\n');
});

process.on('uncaughtException', (error) => {
  process.stdout.write(JSON.stringify({ level: 'fatal', event: 'uncaughtException', error: error.message, stack: error.stack, timestamp: new Date().toISOString() }) + '\n');
  process.exit(1);
});
