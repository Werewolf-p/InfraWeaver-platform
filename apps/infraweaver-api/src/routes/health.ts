import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import { computeP95, getSampleCount } from '../lib/response-time.js';
import type { AppBindings } from '../types/index.js';

const SERVER_STARTED_AT = new Date().toISOString();

async function checkUrl(url: string, timeoutMs = 3000): Promise<{ ok: boolean; durationMs: number }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return { ok: res.ok, durationMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, durationMs: Date.now() - start };
  }
}

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

function checkK8sApiSync(timeoutMs = 3000): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    try {
      if (!existsSync(SA_TOKEN_PATH) || !existsSync(SA_CA_PATH)) {
        return resolve({ ok: false });
      }
      const token = readFileSync(SA_TOKEN_PATH, 'utf8').trim();
      const ca = readFileSync(SA_CA_PATH, 'utf8');
      const host = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
      const port = parseInt(process.env.KUBERNETES_SERVICE_PORT ?? '443', 10);

      const req = https.request(
        {
          hostname: host,
          port,
          path: '/healthz',
          method: 'GET',
          ca,
          headers: { Authorization: `Bearer ${token}` },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume(); // drain
          resolve({ ok: res.statusCode === 200 });
        }
      );
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.end();
    } catch {
      resolve({ ok: false });
    }
  });
}

export const healthRoute = new Hono<AppBindings>();

healthRoute.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');

  const argocdUrl = process.env.ARGOCD_SERVER ?? 'http://argocd-server.argocd.svc.cluster.local:80';

  const [argocdResult, k8sResult] = await Promise.allSettled([
    checkUrl(`${argocdUrl}/healthz`),
    checkK8sApiSync(),
  ]);

  const p95 = computeP95();

  return c.json({
    status: 'ok',
    version: process.env.npm_package_version ?? '1.0.0',
    timestamp: new Date().toISOString(),
    startedAt: SERVER_STARTED_AT,
    checks: {
      k8sApi: k8sResult.status === 'fulfilled' ? k8sResult.value : { ok: false },
      argocd: argocdResult.status === 'fulfilled' ? argocdResult.value : { ok: false, durationMs: -1 },
    },
    performance: {
      p95ResponseTimeMs: p95,
      sampleCount: getSampleCount(),
    },
  });
});
