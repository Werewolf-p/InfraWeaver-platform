import { createHmac, timingSafeEqual } from 'node:crypto';

export function signHmac(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function verifyHmac(message: string, sig: string, secret: string): boolean {
  const expected = signHmac(message, secret);
  // Reject malformed signatures before decoding: non-hex input makes
  // Buffer.from(..., 'hex') silently truncate, which would throw inside
  // timingSafeEqual on a length mismatch and surface as a 500 instead of a 401.
  if (sig.length !== expected.length || !/^[0-9a-f]+$/i.test(sig)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}
