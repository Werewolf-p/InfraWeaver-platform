import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { signHmac, verifyHmac } from '../lib/hmac.js';
import { applyElevatedPermissions } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

// Grace window for previous secret during rotation (5 minutes)
const ROTATION_GRACE_MS = 5 * 60 * 1000;

// Replay guard for mutating requests: a captured signed header set must not be
// reusable to issue additional mutations within the freshness window. The
// signature (which covers ts:userId:roles:clusterId) is accepted at most once
// for POST/PUT/PATCH/DELETE. Entries live for the max window a signature can
// still validate (30s freshness, or ROTATION_GRACE_MS on the previous key).
// NOTE: full method/path/body binding additionally requires the console-side
// signer (apps/infraweaver-console/src/lib/iw-api.ts) to sign those fields;
// this cache closes the "replay one mutation N times" and "turn one observed
// mutation's headers into other mutations" paths verifier-side.
const REPLAY_TTL_MS = ROTATION_GRACE_MS;
const REPLAY_SWEEP_THRESHOLD = 10_000;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const seenSignatures = new Map<string, number>();

function isReplayedSignature(sig: string): boolean {
  const now = Date.now();
  // Opportunistic sweep keeps the map bounded without a background timer.
  if (seenSignatures.size >= REPLAY_SWEEP_THRESHOLD) {
    for (const [key, expiry] of seenSignatures) {
      if (expiry <= now) seenSignatures.delete(key);
    }
  }
  const existing = seenSignatures.get(sig);
  if (existing !== undefined && existing > now) {
    return true;
  }
  seenSignatures.set(sig, now + REPLAY_TTL_MS);
  return false;
}

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

  // Bind the target cluster into the signed message so a client cannot swap
  // x-cluster-id on a valid request to target a cluster it lacks access to.
  const clusterId = c.req.header('x-cluster-id') ?? 'local';
  const message = `${ts}:${userId}:${rolesHeader}:${clusterId}`;
  let validSecret: string | null = null;
  let keyUsed: 'current' | 'previous' = 'current';

  if (verifyHmac(message, sig, currentSecret)) {
    validSecret = currentSecret;
    keyUsed = 'current';
  } else {
    const prevSecret = process.env.CONSOLE_API_SECRET_PREV;
    if (prevSecret && age <= ROTATION_GRACE_MS && verifyHmac(message, sig, prevSecret)) {
      validSecret = prevSecret;
      keyUsed = 'previous';
      console.warn('[auth] Request authenticated with previous HMAC secret — rotate CONSOLE_API_SECRET_PREV out soon');
    }
  }

  if (!validSecret) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Fail closed on signature reuse for mutating methods: each signed header
  // set authorizes at most one mutation. The console signs every request with
  // a fresh millisecond timestamp, so legitimate mutations do not collide.
  if (MUTATING_METHODS.has(c.req.method) && isReplayedSignature(sig)) {
    return c.json({ error: 'Replayed request signature' }, 401);
  }

  const roles = rolesHeader ? rolesHeader.split(',').filter(Boolean) : [];
  const user = { id: userId, roles, clusterId };
  c.set('user', user);

  // Independently honor active PIM elevations + custom-group permissions read
  // from the console's ConfigMap. Fail-secure: errors grant no extra access.
  await applyElevatedPermissions(user).catch(() => {});

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
