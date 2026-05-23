import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import https from 'node:https';
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

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT ?? '443';

async function checkK8sApi(timeoutMs = 3000): Promise<{ ok: boolean }> {
  try {
    if (!existsSync(SA_TOKEN_PATH) || !existsSync(SA_CA_PATH)) {
      return { ok: false };
    }
    const token = readFileSync(SA_TOKEN_PATH, 'utf8').trim();
    const ca = readFileSync(SA_CA_PATH, 'utf8');
    const agent = new https.Agent({ ca });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://${K8S_HOST}:${K8S_PORT}/healthz`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore undici dispatcher option for node fetch
        dispatcher: new (await import('undici').then(m => m.Agent))({ connect: { ca } }),
      });
      return { ok: res.status === 200 };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false };
  }
}

export const healthRoute = new Hono<AppBindings>();

healthRoute.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');

  const argocdUrl = process.env.ARGOCD_SERVER ?? 'http://argocd-server.argocd.svc.cluster.local:80';

  const [argocdResult, k8sResult] = await Promise.allSettled([
    checkUrl(`${argocdUrl}/healthz`),
    checkK8sApi(),
  ]);

  const p95 = computeP95();

  return c.json({
    status: 'ok',
    version: process.env.npm_package_version ?? '1.0.0',
    timestamp: new Date().toISOString(),
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
