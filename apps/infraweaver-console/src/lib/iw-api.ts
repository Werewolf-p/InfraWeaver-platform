import { createHmac } from 'node:crypto';
import type { Session } from 'next-auth';

const API_URL = process.env.INFRAWEAVER_API_URL ?? 'http://infraweaver-api:3001';
const DEFAULT_TIMEOUT_MS = 30_000;

interface IWUser { email?: string | null; groups?: string[] }

function sign(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
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
  // Bind the HTTP method into the signature so a captured signature (e.g. from a
  // GET) cannot be replayed as a different-method request such as a mutation.
  const method = (init.method ?? 'GET').toUpperCase();

  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  headers.set('x-console-sig', sign(`${ts}:${method}:${userId}:${roles}:${clusterId}`, secret));
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
