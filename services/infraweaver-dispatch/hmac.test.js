/**
 * Tests for the dispatch HMAC request-auth helper (C-3). Zero deps — run with:
 *   node --test
 *
 * Requiring ./server.js must NOT start a real server (guarded by
 * `if (require.main === module)`), so importing it here is side-effect free.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { signHmac, verifyHmac } = require('./server');

const SECRET = 'test-secret';
const RAW_BODY = JSON.stringify({ feedbackId: 'abc', description: 'fix it' });

function freshTimestamp() {
  return String(Date.now());
}
function sign(rawBody, timestamp, secret = SECRET) {
  return signHmac(`${timestamp}.${rawBody}`, secret);
}

test('valid signature passes', () => {
  const ts = freshTimestamp();
  const sig = sign(RAW_BODY, ts);
  const result = verifyHmac(RAW_BODY, ts, sig, SECRET);
  assert.strictEqual(result.ok, true);
});

test('tampered body fails', () => {
  const ts = freshTimestamp();
  const sig = sign(RAW_BODY, ts);
  const tampered = JSON.stringify({ feedbackId: 'abc', description: 'rm -rf' });
  const result = verifyHmac(tampered, ts, sig, SECRET);
  assert.strictEqual(result.ok, false);
});

test('wrong secret fails', () => {
  const ts = freshTimestamp();
  const sig = sign(RAW_BODY, ts, 'other-secret');
  const result = verifyHmac(RAW_BODY, ts, sig, SECRET);
  assert.strictEqual(result.ok, false);
});

test('expired timestamp fails (> 5 min old)', () => {
  const ts = String(Date.now() - 6 * 60 * 1000);
  const sig = sign(RAW_BODY, ts);
  const result = verifyHmac(RAW_BODY, ts, sig, SECRET);
  assert.strictEqual(result.ok, false);
});

test('future timestamp beyond window fails', () => {
  const ts = String(Date.now() + 6 * 60 * 1000);
  const sig = sign(RAW_BODY, ts);
  const result = verifyHmac(RAW_BODY, ts, sig, SECRET);
  assert.strictEqual(result.ok, false);
});

test('missing signature headers fail', () => {
  const ts = freshTimestamp();
  assert.strictEqual(verifyHmac(RAW_BODY, ts, undefined, SECRET).ok, false);
  assert.strictEqual(verifyHmac(RAW_BODY, undefined, 'deadbeef', SECRET).ok, false);
});

test('non-numeric timestamp fails', () => {
  const sig = sign(RAW_BODY, 'not-a-number');
  const result = verifyHmac(RAW_BODY, 'not-a-number', sig, SECRET);
  assert.strictEqual(result.ok, false);
});

test('missing secret (fail-open path) returns not ok from verify', () => {
  const ts = freshTimestamp();
  const sig = sign(RAW_BODY, ts);
  // verifyHmac itself fails closed with no secret; the fail-OPEN behavior lives
  // in the route layer (which skips verifyHmac entirely when DISPATCH_SECRET='').
  const result = verifyHmac(RAW_BODY, ts, sig, '');
  assert.strictEqual(result.ok, false);
});

test('empty-body publish: "{}" signs and verifies', () => {
  const ts = freshTimestamp();
  const raw = JSON.stringify({}); // "{}"
  const sig = sign(raw, ts);
  assert.strictEqual(verifyHmac(raw, ts, sig, SECRET).ok, true);
});

test('signature is lowercase hex HMAC-SHA256 (matches createHmac)', () => {
  const ts = freshTimestamp();
  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${RAW_BODY}`).digest('hex');
  assert.strictEqual(sign(RAW_BODY, ts), expected);
  assert.match(sign(RAW_BODY, ts), /^[0-9a-f]+$/);
});
