import { createHmac, timingSafeEqual } from 'node:crypto';

export function signHmac(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export async function verifyHmac(message: string, sig: string, secret: string): Promise<boolean> {
  const expected = signHmac(message, secret);
  if (sig.length !== expected.length) {
    return false;
  }

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return timingSafeEqual(a, b);
}
