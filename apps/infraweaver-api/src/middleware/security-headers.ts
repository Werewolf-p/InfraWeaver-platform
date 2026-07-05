import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../types/index.js';

// Management surfaces that must never be cached by a browser client. Routes are
// mounted under /api/v1/<resource> (see index.ts `app.route('/api/v1', api)`),
// so match the resource segment anywhere in the path rather than a fixed prefix
// — the previous '/v1/clusters' / '/api/clusters' prefixes matched none of the
// real '/api/v1/clusters' paths and left RBAC/cluster/agent data cacheable.
const SENSITIVE_RESOURCE_SEGMENTS = /(?:^|\/)(?:clusters|rbac|agents)(?:\/|$)/;

function isSensitivePath(path: string): boolean {
  return SENSITIVE_RESOURCE_SEGMENTS.test(path);
}

/**
 * Adds security-related HTTP response headers to every API response.
 * - X-Content-Type-Options: nosniff — prevent MIME sniffing
 * - X-Frame-Options: DENY — prevent framing
 * - Removes X-Powered-By — avoid server fingerprinting
 * - Cache-Control: no-store for sensitive endpoints
 */
export const securityHeaders = createMiddleware<AppBindings>(async (c, next) => {
  await next();

  // Prevent MIME type sniffing
  c.header('X-Content-Type-Options', 'nosniff');

  // Prevent framing of API responses
  c.header('X-Frame-Options', 'DENY');

  // Remove framework fingerprinting
  c.res.headers.delete('X-Powered-By');

  // Reduce metadata leakage from browser clients
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Enforce no-cache on sensitive management endpoints
  if (isSensitivePath(c.req.path)) {
    c.header('Cache-Control', 'no-store');
  }

  // Ensure API responses include CORS vary
  if (!c.res.headers.has('Vary')) {
    c.header('Vary', 'Origin, Accept-Encoding');
  }
});
