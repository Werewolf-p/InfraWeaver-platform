import { createMiddleware } from 'hono/factory';
import { getMode } from '../lib/mode.js';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const modeGuard = createMiddleware(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || c.req.path.startsWith('/v1/mode')) {
        await next();
        return;
    }
    const mode = await getMode();
    if (mode === 'deployment') {
        return c.json({ error: 'Service is in deployment mode — mutations are temporarily disabled', mode: 'deployment' }, 503, { 'Retry-After': '60' });
    }
    await next();
});
//# sourceMappingURL=mode-guard.js.map