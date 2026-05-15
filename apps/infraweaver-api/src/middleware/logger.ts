import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../types/index.js';

export const requestLogger = createMiddleware<AppBindings>(async (c, next) => {
  const startedAt = Date.now();
  await next();

  const user = c.get('user');
  const forwardedFor = c.req.header('x-forwarded-for');
  const clientIp = forwardedFor ? forwardedFor.split(',')[0]?.trim() : null;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
    userId: user?.id ?? null,
    clusterId: user?.clusterId ?? c.req.header('x-cluster-id') ?? null,
    clientIp,
  }));
});
