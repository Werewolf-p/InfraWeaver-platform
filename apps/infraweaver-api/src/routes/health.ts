import { Hono } from 'hono';
import { execSync } from 'node:child_process';
import { computeP95, getSampleCount } from '../lib/response-time.js';
import type { AppBindings } from '../types/index.js';

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

export const healthRoute = new Hono<AppBindings>();

healthRoute.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');

  const argocdUrl = process.env.ARGOCD_SERVER ?? 'http://argocd-server.argocd.svc.cluster.local:80';

  const [argocdResult] = await Promise.allSettled([
    checkUrl(`${argocdUrl}/healthz`),
  ]);

  let k8sApiOk = false;
  try {
    execSync('kubectl get --raw /healthz', { timeout: 3000, stdio: 'pipe' });
    k8sApiOk = true;
  } catch {
    k8sApiOk = false;
  }

  const p95 = computeP95();

  return c.json({
    status: 'ok',
    version: process.env.npm_package_version ?? '1.0.0',
    timestamp: new Date().toISOString(),
    checks: {
      k8sApi: { ok: k8sApiOk },
      argocd: argocdResult.status === 'fulfilled' ? argocdResult.value : { ok: false, durationMs: -1 },
    },
    performance: {
      p95ResponseTimeMs: p95,
      sampleCount: getSampleCount(),
    },
  });
});
