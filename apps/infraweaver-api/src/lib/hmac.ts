import { createHmac, timingSafeEqual } from 'node:crypto';

export function signHmac(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function verifyHmac(message: string, sig: string, secret: string): boolean {
  const expected = signHmac(message, secret);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}
