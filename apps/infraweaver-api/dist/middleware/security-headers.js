import { createMiddleware } from 'hono/factory';
const SENSITIVE_PATH_PREFIXES = [
    '/v1/clusters',
    '/api/clusters',
    '/v1/rbac',
    '/api/rbac',
    '/v1/agents',
    '/api/agents',
];
function isSensitivePath(path) {
    return SENSITIVE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
/**
 * Adds security-related HTTP response headers to every API response.
 * - X-Content-Type-Options: nosniff — prevent MIME sniffing
 * - X-Frame-Options: DENY — prevent framing
 * - Removes X-Powered-By — avoid server fingerprinting
 * - Cache-Control: no-store for sensitive endpoints
 */
export const securityHeaders = createMiddleware(async (c, next) => {
    await next();
    // Prevent MIME type sniffing
    c.header('X-Content-Type-Options', 'nosniff');
    // Prevent framing of API responses
    c.header('X-Frame-Options', 'DENY');
    // Remove framework fingerprinting
    c.res.headers.delete('X-Powered-By');
    // Enforce no-cache on sensitive management endpoints
    if (isSensitivePath(c.req.path)) {
        c.header('Cache-Control', 'no-store');
    }
    // Ensure API responses include CORS vary
    if (!c.res.headers.has('Vary')) {
        c.header('Vary', 'Origin, Accept-Encoding');
    }
});
//# sourceMappingURL=security-headers.js.map