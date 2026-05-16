import { Hono } from 'hono';
import { renderPrometheusMetrics } from '../lib/prom-metrics.js';
import type { AppBindings } from '../types/index.js';

export const prometheusRoute = new Hono<AppBindings>();

prometheusRoute.get('/', (c) => {
  c.header('Content-Type', 'text/plain; version=0.0.4');
  c.header('Cache-Control', 'no-store');
  return c.text(renderPrometheusMetrics());
});
