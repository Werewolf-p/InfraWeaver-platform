import { createHash, createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import type { Session } from 'next-auth';
import type { Permission } from '@/lib/rbac';
import { getRequestClusterId } from '@/lib/cluster-context';
import { withRoute } from '@/lib/route-utils';

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

// ─── Proxy-route factory ──────────────────────────────────────────────────────
// Ready-made GET/PATCH/DELETE handlers for the thin pass-through routes
// (config-maps / secrets / longhorn / updates …): resolve the cluster id,
// validate the body (zod → canonical 400 "Validation failed"), build the
// upstream path, forward via iwApiFetch, and mirror the upstream status +
// JSON body back. ADDITIVE — adopt route-by-route; export ONLY the methods
// you configured (unconfigured methods return 405 if exported by mistake).

export type IwProxyHandler = ReturnType<typeof withRoute>;

export interface IwProxyReadConfig {
  permission: Permission | Permission[];
  /** Query params forwarded upstream when present on the request (allowlist). */
  queryParams?: readonly string[];
}

export interface IwProxyWriteConfig<T> {
  permission: Permission | Permission[];
  /** Validated against the JSON body; failures return the canonical 400 "Validation failed" envelope. */
  schema: ZodType<T>;
  /** Upstream path built from the validated body (encode segments with encodeURIComponent). Defaults to `basePath`. */
  toPath?: (body: T) => string;
  /**
   * Upstream JSON body. Defaults: PATCH forwards the validated body; DELETE
   * sends no body. Return undefined to send no body.
   */
  toBody?: (body: T) => unknown;
}

export interface IwProxyRouteConfig<TPatch, TDelete> {
  /** Upstream base path, e.g. "/config-maps". */
  basePath: string;
  get?: IwProxyReadConfig;
  patch?: IwProxyWriteConfig<TPatch>;
  delete?: IwProxyWriteConfig<TDelete>;
}

const METHOD_NOT_ALLOWED: IwProxyHandler = async () =>
  NextResponse.json({ error: 'Method not allowed' }, { status: 405 });

async function forwardIwResponse(res: Response): Promise<NextResponse> {
  return NextResponse.json(await res.json(), { status: res.status });
}

/**
 * Build ready GET/PATCH/DELETE route handlers proxying to infraweaver-api.
 *
 * Usage (mirrors app/api/config-maps/route.ts):
 *   export const { GET, PATCH, DELETE } = makeIwProxyRoute({
 *     basePath: "/config-maps",
 *     get: { permission: "config:read", queryParams: ["namespace"] },
 *     patch: {
 *       permission: "config:write",
 *       schema: configMapPatchSchema,
 *       toPath: (b) => `/config-maps/${encodeURIComponent(b.namespace)}/${encodeURIComponent(b.name)}`,
 *       toBody: (b) => ({ data: b.data }),
 *     },
 *     delete: {
 *       permission: "config:write",
 *       schema: configMapDeleteSchema,
 *       toPath: (b) => `/config-maps/${encodeURIComponent(b.namespace)}/${encodeURIComponent(b.name)}`,
 *     },
 *   });
 */
export function makeIwProxyRoute<TPatch = never, TDelete = never>(
  config: IwProxyRouteConfig<TPatch, TDelete>,
): { GET: IwProxyHandler; PATCH: IwProxyHandler; DELETE: IwProxyHandler } {
  const { basePath } = config;

  const makeGet = (cfg: IwProxyReadConfig): IwProxyHandler =>
    withRoute(cfg.permission, async (request: NextRequest, session) => {
      const clusterId = getRequestClusterId(request);
      const search = new URLSearchParams();
      for (const key of cfg.queryParams ?? []) {
        const value = request.nextUrl.searchParams.get(key);
        if (value !== null) search.set(key, value);
      }
      const qs = search.toString();
      const res = await iwApiFetch(qs ? `${basePath}?${qs}` : basePath, session, clusterId);
      return forwardIwResponse(res);
    });

  const makeWrite = <T>(
    method: 'PATCH' | 'DELETE',
    cfg: IwProxyWriteConfig<T>,
    forwardBodyByDefault: boolean,
  ): IwProxyHandler =>
    withRoute(cfg.permission, async (request: NextRequest, session) => {
      const clusterId = getRequestClusterId(request);
      const rawBody = await request.json().catch(() => null);
      const parsed = cfg.schema.safeParse(rawBody);
      if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      }
      const path = cfg.toPath ? cfg.toPath(parsed.data) : basePath;
      const upstreamBody = cfg.toBody ? cfg.toBody(parsed.data) : forwardBodyByDefault ? parsed.data : undefined;
      const res = await iwApiFetch(path, session, clusterId, {
        method,
        ...(upstreamBody === undefined ? {} : { body: JSON.stringify(upstreamBody) }),
      });
      return forwardIwResponse(res);
    });

  return {
    GET: config.get ? makeGet(config.get) : METHOD_NOT_ALLOWED,
    PATCH: config.patch ? makeWrite('PATCH', config.patch, true) : METHOD_NOT_ALLOWED,
    DELETE: config.delete ? makeWrite('DELETE', config.delete, false) : METHOD_NOT_ALLOWED,
  };
}
