import { createHash, createHmac } from 'node:crypto';
import type { Session } from 'next-auth';

const API_URL = process.env.INFRAWEAVER_API_URL ?? 'http://infraweaver-api:3001';
const DEFAULT_TIMEOUT_MS = 30_000;

interface IWUser { email?: string | null; groups?: string[] }

function sign(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

// sha256 of the exact request-body bytes. Empty string when there is no body,
// matching the verifier's `await c.req.text()` (which returns "" for no body).
function bodyDigest(body: BodyInit | null | undefined): string {
  const raw = typeof body === 'string' ? body : '';
  return createHash('sha256').update(raw).digest('hex');
}

export function iwApiFetch(
  path: string,
  session: Session | null,
  clusterId: string,
  init: RequestInit = {},
): Promise<Response> {
  const secret = process.env.CONSOLE_API_SECRET ?? '';
  const user = session?.user as IWUser | undefined;
  const userId = user?.email ?? 'anonymous';
  const roles = (user?.groups ?? []).join(',');
  const ts = Date.now().toString();
  // Bind method + path + body into the signature so a captured signature cannot be
  // replayed under a different method, path, or body. The signed path is the full
  // request pathname WITHOUT the query string, to match the verifier's c.req.path
  // (Hono strips the query). Empirically confirmed: c.req.path === `/api/v1${path}`
  // (query excluded) and a middleware body-read leaves the handler's read intact.
  const method = (init.method ?? 'GET').toUpperCase();
  const signedPath = `/api/v1${path}`.split('?')[0];
  const bodyHash = bodyDigest(init.body);

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  headers.set('x-console-sig', sign(`${ts}:${method}:${signedPath}:${bodyHash}:${userId}:${roles}:${clusterId}`, secret));
  headers.set('x-console-ts', ts);
  headers.set('x-user-id', userId);
  headers.set('x-user-roles', roles);
  headers.set('x-cluster-id', clusterId);

  return fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}
