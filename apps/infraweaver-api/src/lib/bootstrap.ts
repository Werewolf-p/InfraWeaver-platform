import * as k8s from '@kubernetes/client-node';
import { randomBytes } from 'node:crypto';

const SECRET_NAME = 'infraweaver-api-console-secret';
const SECRET_NAMESPACE = process.env.SECRET_NAMESPACE ?? 'infraweaver-console';
const SECRET_KEY = 'CONSOLE_API_SECRET';

export async function bootstrapConsoleSecret(): Promise<string> {
  if (process.env.CONSOLE_API_SECRET) {
    return process.env.CONSOLE_API_SECRET;
  }

  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }

  const coreApi: any = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const response = await coreApi.readNamespacedSecret(SECRET_NAME, SECRET_NAMESPACE);
    const existing = (response?.body ?? response)?.data?.[SECRET_KEY];
    if (existing) {
      const secret = Buffer.from(existing, 'base64').toString('utf8');
      console.log('[bootstrap] Loaded CONSOLE_API_SECRET from k8s Secret');
      process.env.CONSOLE_API_SECRET = secret;
      return secret;
    }
  } catch (err: any) {
    if (err?.body?.code !== 404 && err?.statusCode !== 404 && err?.status !== 404) {
      throw err;
    }
  }

  const secret = randomBytes(32).toString('hex');
  console.log('[bootstrap] CONSOLE_API_SECRET not set — generating and storing in k8s Secret');

  try {
    await coreApi.createNamespacedSecret(SECRET_NAMESPACE, {
      metadata: { name: SECRET_NAME, namespace: SECRET_NAMESPACE },
      type: 'Opaque',
      data: { [SECRET_KEY]: Buffer.from(secret).toString('base64') },
    });
    console.log(`[bootstrap] Created k8s Secret ${SECRET_NAMESPACE}/${SECRET_NAME}`);
  } catch (err: any) {
    if (err?.body?.code === 409 || err?.statusCode === 409 || err?.status === 409) {
      const response = await coreApi.readNamespacedSecret(SECRET_NAME, SECRET_NAMESPACE);
      const existing = (response?.body ?? response)?.data?.[SECRET_KEY];
      if (existing) {
        const existingSecret = Buffer.from(existing, 'base64').toString('utf8');
        process.env.CONSOLE_API_SECRET = existingSecret;
        return existingSecret;
      }
    }

    throw err;
  }

  process.env.CONSOLE_API_SECRET = secret;
  return secret;
}
