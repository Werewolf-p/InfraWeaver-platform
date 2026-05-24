import { Hono } from 'hono';
import { renderPrometheusMetrics } from '../lib/prom-metrics.js';
export const prometheusRoute = new Hono();
prometheusRoute.get('/', (c) => {
    c.header('Content-Type', 'text/plain; version=0.0.4');
    c.header('Cache-Control', 'no-store');
    return c.text(renderPrometheusMetrics());
});
//# sourceMappingURL=prometheus.js.map