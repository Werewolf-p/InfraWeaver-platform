import { Hono } from 'hono';

export const healthRoute = new Hono();

healthRoute.get('/', (c) => {
  c.header('Cache-Control', 'private, max-age=30');
  return c.json({ status: 'ok', version: process.env.npm_package_version ?? '1.0.0' });
});
