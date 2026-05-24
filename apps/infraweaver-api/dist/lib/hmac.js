import { createHmac, timingSafeEqual } from 'node:crypto';
export function signHmac(message, secret) {
    return createHmac('sha256', secret).update(message).digest('hex');
}
export function verifyHmac(message, sig, secret) {
    const expected = signHmac(message, secret);
    if (sig.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}
//# sourceMappingURL=hmac.js.map