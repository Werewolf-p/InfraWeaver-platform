import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getMode, setMode } from '../lib/mode.js';
import { hasPermission } from '../lib/rbac.js';
export const modeRoute = new Hono();
modeRoute.get('/', async (c) => {
    const mode = await getMode();
    return c.json({ mode });
});
modeRoute.put('/', zValidator('json', z.object({ mode: z.enum(['live', 'deployment']) })), async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:admin')) {
        return c.json({ error: 'Forbidden — cluster:admin required' }, 403);
    }
    const { mode } = c.req.valid('json');
    await setMode(mode);
    return c.json({ mode, updatedAt: new Date().toISOString() });
});
//# sourceMappingURL=mode.js.map