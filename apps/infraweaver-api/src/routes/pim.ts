import { Hono } from 'hono';
import { computeElevatedPermissions, hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

/**
 * Read-only PIM endpoints exposing how the *backend* evaluates a request's
 * elevated permissions. The console performs all PIM CRUD directly against the
 * ConfigMap; this route lets clients/tests confirm the backend's independent
 * authorization view (active elevations + custom-group permissions).
 */
export const pimRoute = new Hono<AppBindings>();

pimRoute.get('/me', async (c) => {
  const user = c.get('user');
  const elevated = await computeElevatedPermissions(user.id, user.roles);
  return c.json({
    user: user.id,
    roles: user.roles,
    elevatedPermissions: [...elevated].sort(),
    securityRead: hasPermission(user, 'security:read'),
  });
});

pimRoute.get('/check', async (c) => {
  const user = c.get('user');
  const permission = c.req.query('permission') ?? '';
  if (!permission) return c.json({ error: 'permission query param required' }, 400);
  return c.json({ permission, allowed: hasPermission(user, permission as Parameters<typeof hasPermission>[1]) });
});
