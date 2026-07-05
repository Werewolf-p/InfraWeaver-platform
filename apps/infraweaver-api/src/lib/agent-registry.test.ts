/**
 * C5: the agent WebSocket hub must reject unregistered clusters and verify
 * every inbound frame signature against the stored per-cluster public key.
 *
 * Run: npm test (node --import tsx --test src/lib/agent-registry.test.ts)
 */
process.env.IW_AGENT_KEY_PERSISTENCE = 'off';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

import {
  createPendingRegistration,
  getConnectedAgents,
  sendToAgent,
  setupWebSocketServer,
} from './agent-registry.js';
import { getSignaturePayload, type SignedFrame } from './frame-signature.js';

let server: Server;
let port: number;

before(async () => {
  server = createServer();
  setupWebSocketServer(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
});

after(() => {
  server.close();
});

function generateAgentKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function sign(message: string, privateKey: KeyObject): string {
  const signer = createSign('SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(privateKey, 'base64');
}

function signedFrame(frame: SignedFrame, privateKey: KeyObject): SignedFrame {
  return { ...frame, sig: sign(getSignaturePayload(frame), privateKey) };
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Register a cluster over the real /v1/ws/register flow; returns its key pair. */
async function registerCluster(clusterId: string) {
  const keyPair = generateAgentKeyPair();
  const token = createPendingRegistration(clusterId, `${clusterId}-name`);
  const frame = signedFrame(
    {
      type: 'register',
      token,
      publicKey: (keyPair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
      clusterCaFingerprint: 'test-fingerprint',
      ts: Date.now(),
    },
    keyPair.privateKey,
  );

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/register`);
  await once(ws, 'open');
  const registered = new Promise<Record<string, unknown>>((resolve) => {
    ws.on('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
  ws.send(JSON.stringify(frame));
  const reply = await registered;
  assert.equal(reply.type, 'registered', `registration failed: ${JSON.stringify(reply)}`);
  return keyPair;
}

function connectCluster(clusterId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/cluster/${clusterId}`);
  return once(ws, 'open').then(() => ws);
}

function heartbeat(privateKey: KeyObject, ts = Date.now()): SignedFrame {
  return signedFrame(
    { type: 'heartbeat', ts, status: { ready: true, nodeCount: 3, podCount: 42 } },
    privateKey,
  );
}

// ── payload format pin ───────────────────────────────────────────────────────
// Guards against drift from apps/infraweaver-node/src/types/index.ts — if this
// string changes shape, deployed agents' signatures stop verifying.

test('heartbeat signature payload matches the agent wire format', () => {
  const payload = getSignaturePayload({
    type: 'heartbeat',
    ts: 123,
    status: { ready: true, nodeCount: 1, podCount: 2 },
  });
  assert.equal(payload, 'heartbeat:123:{"nodeCount":1,"podCount":2,"ready":true}');
});

// ── connection gating ────────────────────────────────────────────────────────

test('rejects connection for a cluster with no registered key', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/cluster/never-registered`);
  const { code } = await waitForClose(ws);
  assert.equal(code, 4401);
  assert.ok(!getConnectedAgents().some((a) => a.clusterId === 'never-registered'));
});

test('registered agent with signed heartbeat becomes connected', async () => {
  const keyPair = await registerCluster('cluster-good');
  const ws = await connectCluster('cluster-good');
  ws.send(JSON.stringify(heartbeat(keyPair.privateKey)));

  await waitFor(() => getConnectedAgents().some((a) => a.clusterId === 'cluster-good'));
  const agent = getConnectedAgents().find((a) => a.clusterId === 'cluster-good');
  assert.ok(agent);
  assert.equal(agent.status.nodeCount, 3);
  assert.equal(agent.status.podCount, 42);
  ws.close();
  await waitFor(() => !getConnectedAgents().some((a) => a.clusterId === 'cluster-good'));
});

test('unsigned heartbeat is rejected and never registers the agent', async () => {
  await registerCluster('cluster-unsigned');
  const ws = await connectCluster('cluster-unsigned');
  ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now(), status: { ready: true, nodeCount: 9, podCount: 9 } }));

  const { code } = await waitForClose(ws);
  assert.equal(code, 4403);
  assert.ok(!getConnectedAgents().some((a) => a.clusterId === 'cluster-unsigned'));
});

test('heartbeat signed with the wrong key is rejected', async () => {
  await registerCluster('cluster-wrongkey');
  const attackerKeys = generateAgentKeyPair();
  const ws = await connectCluster('cluster-wrongkey');
  ws.send(JSON.stringify(heartbeat(attackerKeys.privateKey)));

  const { code } = await waitForClose(ws);
  assert.equal(code, 4403);
  assert.ok(!getConnectedAgents().some((a) => a.clusterId === 'cluster-wrongkey'));
});

test('replayed frame with a stale timestamp is rejected', async () => {
  const keyPair = await registerCluster('cluster-replay');
  const ws = await connectCluster('cluster-replay');
  const staleTs = Date.now() - 10 * 60 * 1000;
  ws.send(JSON.stringify(heartbeat(keyPair.privateKey, staleTs)));

  const { code } = await waitForClose(ws);
  assert.equal(code, 4408);
  assert.ok(!getConnectedAgents().some((a) => a.clusterId === 'cluster-replay'));
});

test('tampered heartbeat content fails verification', async () => {
  const keyPair = await registerCluster('cluster-tamper');
  const ws = await connectCluster('cluster-tamper');
  const frame = heartbeat(keyPair.privateKey) as SignedFrame & { status: { nodeCount: number } };
  frame.status.nodeCount = 999;
  ws.send(JSON.stringify(frame));

  const { code } = await waitForClose(ws);
  assert.equal(code, 4403);
});

// ── hijack resistance ────────────────────────────────────────────────────────

test('an unauthenticated socket cannot evict a live verified agent', async () => {
  const keyPair = await registerCluster('cluster-hijack');
  const legit = await connectCluster('cluster-hijack');
  legit.send(JSON.stringify(heartbeat(keyPair.privateKey)));
  await waitFor(() => getConnectedAgents().some((a) => a.clusterId === 'cluster-hijack'));

  // Attacker connects for the same clusterId and pushes an unsigned frame.
  const attacker = await connectCluster('cluster-hijack');
  attacker.send(JSON.stringify({ type: 'heartbeat', ts: Date.now(), status: { ready: true, nodeCount: 0, podCount: 0 } }));
  const { code } = await waitForClose(attacker);
  assert.equal(code, 4403);

  // Legit agent still owns the slot and still receives hub frames.
  const agent = getConnectedAgents().find((a) => a.clusterId === 'cluster-hijack');
  assert.ok(agent, 'legit agent must survive the hijack attempt');
  const received = new Promise<string>((resolve) => {
    legit.on('message', (raw) => resolve(raw.toString()));
  });
  assert.equal(sendToAgent('cluster-hijack', { type: 'noop', ts: Date.now() }), true);
  const delivered = JSON.parse(await received) as { type: string };
  assert.equal(delivered.type, 'noop');
  legit.close();
  await waitFor(() => !getConnectedAgents().some((a) => a.clusterId === 'cluster-hijack'));
});

test('a lingering idle socket closing does not evict a newer verified agent', async () => {
  const keyPair = await registerCluster('cluster-stale-close');
  const idle = await connectCluster('cluster-stale-close');

  const fresh = await connectCluster('cluster-stale-close');
  fresh.send(JSON.stringify(heartbeat(keyPair.privateKey)));
  await waitFor(() => getConnectedAgents().some((a) => a.clusterId === 'cluster-stale-close'));

  idle.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    getConnectedAgents().some((a) => a.clusterId === 'cluster-stale-close'),
    'verified agent must survive the idle socket closing',
  );
  fresh.close();
  await waitFor(() => !getConnectedAgents().some((a) => a.clusterId === 'cluster-stale-close'));
});

// ── registration hardening ───────────────────────────────────────────────────

test('register frame with a tampered signature is rejected', async () => {
  const keyPair = generateAgentKeyPair();
  const otherKeys = generateAgentKeyPair();
  const token = createPendingRegistration('cluster-badreg', 'cluster-badreg-name');
  // Signed with a key that does not match the embedded public key.
  const frame = signedFrame(
    {
      type: 'register',
      token,
      publicKey: (keyPair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
      clusterCaFingerprint: 'test-fingerprint',
      ts: Date.now(),
    },
    otherKeys.privateKey,
  );

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/register`);
  await once(ws, 'open');
  ws.send(JSON.stringify(frame));
  const { code } = await waitForClose(ws);
  assert.equal(code, 4005);

  // The cluster must not have a usable key: connections stay rejected.
  const probe = new WebSocket(`ws://127.0.0.1:${port}/v1/ws/cluster/cluster-badreg`);
  const closed = await waitForClose(probe);
  assert.equal(closed.code, 4401);
});
