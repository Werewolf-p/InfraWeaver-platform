import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { signHmac, verifyHmac } from '../lib/hmac.js';
import type { AppBindings } from '../types/index.js';

// Grace window for previous secret during rotation (5 minutes)
const ROTATION_GRACE_MS = 5 * 60 * 1000;

export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  if (c.req.method === 'GET' && c.req.path.startsWith('/v1/agents/install/')) {
    await next();
    return;
  }

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

  const currentSecret = process.env.CONSOLE_API_SECRET;
  if (!currentSecret) {
    console.error('[auth] CONSOLE_API_SECRET not set');
    return c.json({ error: 'Server misconfiguration' }, 500);
  }

  const message = `${ts}:${userId}:${rolesHeader}`;
  let validSecret: string | null = null;
  let keyUsed: 'current' | 'previous' = 'current';

  // Try current secret first
  if (await verifyHmac(message, sig, currentSecret)) {
    validSecret = currentSecret;
    keyUsed = 'current';
  } else {
    // Try previous secret within grace window for zero-downtime rotation
    const prevSecret = process.env.CONSOLE_API_SECRET_PREV;
    if (prevSecret && age <= ROTATION_GRACE_MS) {
      if (await verifyHmac(message, sig, prevSecret)) {
        validSecret = prevSecret;
        keyUsed = 'previous';
        console.warn('[auth] Request authenticated with previous HMAC secret — rotate CONSOLE_API_SECRET_PREV out soon');
      }
    }
  }

  if (!validSecret) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const roles = rolesHeader ? rolesHeader.split(',').filter(Boolean) : [];
  c.set('user', { id: userId, roles, clusterId: c.req.header('x-cluster-id') ?? 'local' });

  const requestId = c.req.header('x-request-id') ?? randomUUID();
  c.set('requestId', requestId);

  await next();

  const responseTs = Date.now().toString();
  // Sign response with the same key that authenticated the request
  const responseSig = signHmac(`${c.res.status}:${requestId}:${responseTs}`, validSecret);
  c.header('X-Api-Sig', responseSig);
  c.header('X-Request-Id', requestId);
  c.header('X-Api-Ts', responseTs);
  if (keyUsed === 'previous') {
    c.header('X-Auth-Key', 'previous');
  }
});
