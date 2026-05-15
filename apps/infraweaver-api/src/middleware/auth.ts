import { createMiddleware } from 'hono/factory';
import { verifyHmac } from '../lib/hmac.js';
import type { AppBindings } from '../types/index.js';

export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const sig = c.req.header('x-console-sig');
  const ts = c.req.header('x-console-ts');
  const userId = c.req.header('x-user-id');
  const rolesHeader = c.req.header('x-user-roles') ?? '';

  if (!sig || !ts || !userId) {
    return c.json({ error: 'Missing authentication headers' }, 401);
  }

  const parsedTs = Number.parseInt(ts, 10);
  if (Number.isNaN(parsedTs)) {
    return c.json({ error: 'Invalid authentication headers' }, 401);
  }

  const age = Math.abs(Date.now() - parsedTs);
  if (age > 30_000) {
    return c.json({ error: 'Request timestamp expired' }, 401);
  }

  const secret = process.env.CONSOLE_API_SECRET;
  if (!secret) {
    console.error('[auth] CONSOLE_API_SECRET not set');
    return c.json({ error: 'Server misconfiguration' }, 500);
  }

  const message = `${ts}:${userId}:${rolesHeader}`;
  const valid = await verifyHmac(message, sig, secret);
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const roles = rolesHeader ? rolesHeader.split(',').filter(Boolean) : [];
  c.set('user', { id: userId, roles, clusterId: c.req.header('x-cluster-id') ?? 'local' });
  await next();
});
