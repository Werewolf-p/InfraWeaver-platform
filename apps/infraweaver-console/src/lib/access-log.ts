/**
 * Per-request access logging: method + path + actor for every mutating API call.
 *
 * Distinct from `auditLog` (which records semantic actions like "pod:restart").
 * This is the raw HTTP access trail used to catch *which* caller hit a route —
 * e.g. pinning the exact route + page (referer) that keeps deleting an
 * installing game pod during a console rolling update. Emitted as a single
 * `type:"access"` JSON line so it is greppable in pod logs.
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AccessLogFields {
  method: string;
  path: string;
  actor: string;
  ip?: string;
  referer?: string;
  userAgent?: string;
  clusterId?: string;
  status?: number;
  durationMs?: number;
}

function headerIp(headers: Headers): string | undefined {
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || undefined;
}

function truncate(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.slice(0, max);
}

/**
 * Pull the request-shaped fields (method, path, ip, referer, user-agent) off a
 * Fetch/Next request. `actor` and outcome fields are supplied by the caller,
 * which knows the resolved session identity and response status.
 */
export function accessFieldsFromRequest(
  req: Request,
  actor: string,
  extra: Pick<AccessLogFields, "clusterId" | "status" | "durationMs"> = {},
): AccessLogFields {
  let path = "";
  try {
    path = new URL(req.url).pathname;
  } catch {
    path = req.url;
  }
  return {
    method: req.method,
    path,
    actor: actor || "unknown",
    ip: headerIp(req.headers),
    referer: truncate(req.headers.get("referer"), 512),
    userAgent: truncate(req.headers.get("user-agent"), 512),
    ...extra,
  };
}

export function logAccess(fields: AccessLogFields): void {
  // Never let logging break a request.
  try {
    console.log(JSON.stringify({ type: "access", ...fields }));
  } catch {
    /* swallow — diagnostics only */
  }
}

/**
 * Convenience: log a mutating request's access line. No-op for read-only
 * (GET/HEAD/OPTIONS) methods so the trail stays focused on state changes.
 */
export function logMutatingAccess(
  req: Request,
  actor: string,
  extra: Pick<AccessLogFields, "clusterId" | "status" | "durationMs"> = {},
): void {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return;
  logAccess(accessFieldsFromRequest(req, actor, extra));
}
