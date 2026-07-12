import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { getMode, setMode } from '../lib/mode.js';
import { hasPermission } from '../lib/rbac.js';
import { forbidden } from '../lib/responses.js';
import type { AppBindings } from '../types/index.js';

export const modeRoute = new Hono<AppBindings>();

modeRoute.get('/', async (c) => {
  const mode = await getMode();
  return c.json({ mode });
});

modeRoute.put(
  '/',
  zValidator('json', z.object({ mode: z.enum(['live', 'deployment']) })),
  async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:admin')) {
      return forbidden(c, 'Forbidden — cluster:admin required');
    }

    const { mode } = c.req.valid('json');
    await setMode(mode);
    return c.json({ mode, updatedAt: new Date().toISOString() });
  },
);
