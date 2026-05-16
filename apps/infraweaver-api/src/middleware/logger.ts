import { createMiddleware } from 'hono/factory';
import { incrementRequestTotal, recordRequestDuration } from '../lib/prom-metrics.js';
import { recordResponseTime } from '../lib/response-time.js';
import type { AppBindings } from '../types/index.js';

export const requestLogger = createMiddleware<AppBindings>(async (c, next) => {
  const startedAt = Date.now();
  await next();

  const user = c.get('user');
  const forwardedFor = c.req.header('x-forwarded-for');
  const clientIp = forwardedFor ? forwardedFor.split(',')[0]?.trim() : null;
  const path = new URL(c.req.url).pathname;
  const durationMs = Date.now() - startedAt;
  const status = c.res.status;

  recordResponseTime(durationMs);
  incrementRequestTotal(c.req.method, path, status);
  recordRequestDuration(c.req.method, path, durationMs);

  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    requestId: c.get('requestId') ?? null,
    method: c.req.method,
    path,
    status,
    durationMs,
    userId: user?.id ?? null,
    clusterId: user?.clusterId ?? c.req.header('x-cluster-id') ?? null,
    clientIp,
  }) + '\n');
});
