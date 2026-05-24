import type { AppBindings } from '../types/index.js';
/**
 * Adds security-related HTTP response headers to every API response.
 * - X-Content-Type-Options: nosniff — prevent MIME sniffing
 * - X-Frame-Options: DENY — prevent framing
 * - Removes X-Powered-By — avoid server fingerprinting
 * - Cache-Control: no-store for sensitive endpoints
 */
export declare const securityHeaders: import("hono").MiddlewareHandler<AppBindings, string, {}, Response>;
//# sourceMappingURL=security-headers.d.ts.map