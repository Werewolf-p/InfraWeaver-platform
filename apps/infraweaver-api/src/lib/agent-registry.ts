import { createPublicKey, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ApiMode } from './mode.js';
import { getAgentPublicKey, saveAgentPublicKey } from './cluster-registry.js';
import { getSignaturePayload, verifyFrame, type HeartbeatStatus, type SignedFrame } from './frame-signature.js';
import * as logger from './logger.js';

// Signed frames older/newer than this are rejected — bounds replay of captured
// frames while tolerating hub/agent clock skew (both NTP-synced in practice).
const FRAME_MAX_SKEW_MS = 5 * 60 * 1000;

// Frames a not-yet-verified /v1/ws/cluster socket may queue while the
// persisted key loads. Anything beyond this is a client misbehaving.
const MAX_EARLY_FRAMES = 32;

// Test hook: 'off' keeps agent keys purely in-memory so unit tests never touch
// a real Kubernetes API (agent-registry.test.ts).
const isKeyPersistenceEnabled = () => process.env.IW_AGENT_KEY_PERSISTENCE !== 'off';

export interface AgentConnection {
  clusterId: string;
  ws: WebSocket;
  publicKey: KeyObject;
  connectedAt: Date;
  lastHeartbeat: Date;
  status: { nodeCount: number; podCount: number; ready: boolean };
}

export interface PendingRegistration {
  token: string;
  clusterId: string;
  clusterName: string;
  expiresAt: Date;
}

export interface DiscoveryRequest {
  agentId: string;
  clusterName: string;
  publicKeyBase64: string;
  clusterCaFingerprint: string;
  receivedAt: Date;
  ws: WebSocket;
}

const _agents = new Map<string, AgentConnection>();
const _pending = new Map<string, PendingRegistration>();
const _pendingDiscovery = new Map<string, DiscoveryRequest>();
const _registeredKeys = new Map<string, KeyObject>();

let _hubKeyPair: { privateKey: KeyObject; publicKey: KeyObject } | null = null;

function importPublicKey(publicKeyBase64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

export function getHubKeyPair() {
  if (!_hubKeyPair) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    _hubKeyPair = { privateKey, publicKey };
  }
  return _hubKeyPair;
}

export function getHubPublicKeyBase64(): string {
  const kp = getHubKeyPair();
  return (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
}

function signFrame(message: string): string {
  const sign = createSign('SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(getHubKeyPair().privateKey, 'base64');
}

function persistAgentKey(clusterId: string, publicKeyBase64: string): void {
  if (!isKeyPersistenceEnabled()) {
    return;
  }
  void saveAgentPublicKey(clusterId, publicKeyBase64).catch((error) => {
    logger.error(
      `[agent-registry] Failed to persist agent key for ${clusterId} — agent must re-register after a hub restart:`,
      error,
    );
  });
}

async function resolveAgentKey(clusterId: string): Promise<KeyObject | null> {
  const cached = _registeredKeys.get(clusterId);
  if (cached) {
    return cached;
  }
  if (!isKeyPersistenceEnabled()) {
    return null;
  }
  try {
    const publicKeyBase64 = await getAgentPublicKey(clusterId);
    if (!publicKeyBase64) {
      return null;
    }
    const key = importPublicKey(publicKeyBase64);
    _registeredKeys.set(clusterId, key);
    return key;
  } catch (error) {
    logger.error(`[agent-registry] Failed to load persisted agent key for ${clusterId}:`, error);
    return null;
  }
}

/**
 * Verify an inbound agent frame end-to-end (C5): signature over the shared
 * payload format against the cluster's registered public key, plus a
 * timestamp freshness bound against replay. Returns the reason for rejection,
 * or null when the frame is authentic.
 */
function rejectInboundFrame(frame: SignedFrame & { sig?: string }, publicKey: KeyObject):
  | { code: number; reason: string }
  | null {
  if (typeof frame.sig !== 'string' || frame.sig.length === 0) {
    return { code: 4403, reason: 'Missing frame signature' };
  }
  const { sig, ...unsigned } = frame;
  if (!verifyFrame(getSignaturePayload(unsigned as SignedFrame), sig, publicKey)) {
    return { code: 4403, reason: 'Invalid frame signature' };
  }
  if (typeof frame.ts !== 'number' || Math.abs(Date.now() - frame.ts) > FRAME_MAX_SKEW_MS) {
    return { code: 4408, reason: 'Stale frame timestamp' };
  }
  return null;
}

export function createPendingRegistration(clusterId: string, clusterName: string): string {
  const token = randomBytes(32).toString('hex');
  _pending.set(token, {
    token,
    clusterId,
    clusterName,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  return token;
}

export function getPendingRegistration(token: string): PendingRegistration | null {
  const entry = _pending.get(token);
  if (!entry) return null;
  if (entry.expiresAt.getTime() < Date.now()) {
    _pending.delete(token);
    return null;
  }
  return entry;
}

export function getConnectedAgents(): AgentConnection[] {
  return Array.from(_agents.values());
}

export function getPendingDiscoveries(): Omit<DiscoveryRequest, 'ws'>[] {
  return Array.from(_pendingDiscovery.values()).map(({ ws, ...rest }) => rest);
}

export function approveDiscovery(agentId: string, clusterId: string, clusterName: string): boolean {
  const req = _pendingDiscovery.get(agentId);
  if (!req) {
    return false;
  }

  const pubKey = importPublicKey(req.publicKeyBase64);
  _registeredKeys.set(clusterId, pubKey);
  persistAgentKey(clusterId, req.publicKeyBase64);

  req.ws.send(JSON.stringify({
    type: 'approved',
    clusterId,
    hubPublicKey: getHubPublicKeyBase64(),
    ts: Date.now(),
  }));

  setTimeout(() => req.ws.close(1000, 'approved'), 500);
  _pendingDiscovery.delete(agentId);
  logger.info(`[agent-registry] Approved discovery request: ${agentId} -> ${clusterId} (${clusterName})`);
  return true;
}

export function rejectDiscovery(agentId: string, reason: string): boolean {
  const req = _pendingDiscovery.get(agentId);
  if (!req) {
    return false;
  }

  req.ws.send(JSON.stringify({ type: 'rejected', reason, ts: Date.now() }));
  setTimeout(() => req.ws.close(1000, 'rejected'), 500);
  _pendingDiscovery.delete(agentId);
  logger.info(`[agent-registry] Rejected discovery request: ${agentId}`);
  return true;
}

export function broadcastToAgents(frame: object) {
  const payload = JSON.stringify(frame);
  for (const agent of _agents.values()) {
    if (agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.send(payload);
    }
  }
}

export function sendToAgent(clusterId: string, frame: object): boolean {
  const agent = _agents.get(clusterId);
  if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  agent.ws.send(JSON.stringify(frame));
  return true;
}

export function broadcastModeChange(mode: ApiMode) {
  broadcastToAgents({ type: 'mode-change', mode, ts: Date.now() });
}

export function setupWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url?.split('?')[0] ?? '';

    if (url.startsWith('/v1/ws/register')) {
      wss.handleUpgrade(req, socket, head, (ws) => handleRegister(ws));
      return;
    }

    if (url.startsWith('/v1/ws/discover')) {
      wss.handleUpgrade(req, socket, head, (ws) => handleDiscover(ws, req));
      return;
    }

    const match = url.match(/^\/v1\/ws\/cluster\/([^/]+)$/);
    if (match) {
      wss.handleUpgrade(req, socket, head, (ws) => handleCluster(ws, match[1]));
      return;
    }

    socket.destroy();
  });
}

function handleRegister(ws: WebSocket) {
  ws.once('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        token?: string;
        publicKey?: string;
        clusterCaFingerprint?: string;
        ts?: number;
        sig?: string;
      };
      if (msg.type !== 'register') {
        ws.close(4001, 'Expected register frame');
        return;
      }
      if (!msg.token || !msg.publicKey) {
        ws.close(4002, 'Missing registration data');
        return;
      }

      const pending = _pending.get(msg.token);
      if (!pending) {
        ws.close(4002, 'Invalid or expired token');
        return;
      }
      if (pending.expiresAt < new Date()) {
        _pending.delete(msg.token);
        ws.close(4003, 'Token expired');
        return;
      }

      const agentPublicKey = importPublicKey(msg.publicKey);

      // Proof of possession: the register frame must be signed by the private
      // key matching the public key it carries (C5).
      const registerPayload = getSignaturePayload({
        type: 'register',
        token: msg.token,
        publicKey: msg.publicKey,
        clusterCaFingerprint: msg.clusterCaFingerprint ?? '',
        ts: msg.ts ?? 0,
      });
      if (typeof msg.sig !== 'string' || !verifyFrame(registerPayload, msg.sig, agentPublicKey)) {
        ws.close(4005, 'Invalid register frame signature');
        return;
      }

      _pending.delete(msg.token);
      _registeredKeys.set(pending.clusterId, agentPublicKey);
      persistAgentKey(pending.clusterId, msg.publicKey);

      const registeredFrame = {
        type: 'registered' as const,
        clusterId: pending.clusterId,
        hubPublicKey: getHubPublicKeyBase64(),
        ts: Date.now(),
      };

      ws.send(JSON.stringify({
        ...registeredFrame,
        sig: signFrame(getSignaturePayload(registeredFrame)),
      }));
      ws.close();

      logger.info(`[agent-registry] Registered new cluster: ${pending.clusterId} (${pending.clusterName})`);
    } catch (error) {
      logger.error('[agent-registry] Registration error:', error);
      ws.close(4000, 'Registration failed');
    }
  });
}

function handleDiscover(ws: WebSocket, _req: IncomingMessage) {
  ws.once('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString()) as {
        type?: string;
        agentId?: string;
        clusterName?: string;
        publicKey?: string;
        clusterCaFingerprint?: string;
      };

      if (frame.type !== 'hello') {
        ws.close(4001, 'Expected hello frame');
        return;
      }

      const { agentId, clusterName, publicKey, clusterCaFingerprint } = frame;
      if (!agentId || !clusterName || !publicKey) {
        ws.close(4001, 'Missing required fields');
        return;
      }

      const request: DiscoveryRequest = {
        agentId,
        clusterName,
        publicKeyBase64: publicKey,
        clusterCaFingerprint: clusterCaFingerprint ?? 'unknown',
        receivedAt: new Date(),
        ws,
      };

      _pendingDiscovery.set(agentId, request);
      logger.info(`[agent-registry] New discovery request from: ${clusterName} (${agentId})`);
      ws.send(JSON.stringify({ type: 'ack', status: 'pending_approval', ts: Date.now() }));

      ws.on('close', () => {
        _pendingDiscovery.delete(agentId);
        logger.info(`[agent-registry] Discovery disconnected: ${agentId}`);
      });
    } catch (error) {
      logger.error('[agent-registry] Discovery error:', error);
      ws.close(4000, 'Discovery failed');
    }
  });
}

function handleCluster(ws: WebSocket, clusterId: string) {
  // C5: only clusters with a registered signing key may connect, every
  // inbound frame is signature-verified against that key, and a connection
  // claims the _agents slot only after its first authentic frame — an
  // unauthenticated socket must never evict or impersonate a live agent.
  let publicKey: KeyObject | null = _registeredKeys.get(clusterId) ?? null;
  let conn: AgentConnection | null = null;
  let ready = publicKey !== null;
  const earlyFrames: string[] = [];

  const processFrame = (raw: string) => {
    if (!publicKey) {
      return;
    }

    let frame: SignedFrame & { status?: HeartbeatStatus; requestId?: string };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return; // Ignore malformed JSON.
    }
    if (frame.type !== 'heartbeat' && frame.type !== 'response') {
      return; // Unknown frame types are ignored, never trusted.
    }

    const rejection = rejectInboundFrame(frame, publicKey);
    if (rejection) {
      logger.warn(`[agent-registry] Rejected ${frame.type} frame from ${clusterId}: ${rejection.reason}`);
      ws.close(rejection.code, rejection.reason);
      return;
    }

    if (!conn) {
      conn = {
        clusterId,
        ws,
        publicKey,
        connectedAt: new Date(),
        lastHeartbeat: new Date(),
        status: { nodeCount: 0, podCount: 0, ready: false },
      };
      const existing = _agents.get(clusterId);
      if (existing && existing.ws !== ws) {
        // A verified newcomer replaces the previous connection (agent restart /
        // reconnect); the old socket is closed so it cannot linger half-dead.
        existing.ws.close(4410, 'Replaced by a newer verified connection');
      }
      _agents.set(clusterId, conn);
      logger.info(`[agent-registry] Agent connected (frame verified): ${clusterId}`);
    }

    if (frame.type === 'heartbeat') {
      conn.lastHeartbeat = new Date();
      conn.status = frame.status ?? conn.status;
    } else if (frame.requestId) {
      ws.emit(`response:${frame.requestId}`, frame);
    }
  };

  ws.on('message', (raw) => {
    const text = raw.toString();
    if (ready) {
      processFrame(text);
      return;
    }
    if (earlyFrames.length >= MAX_EARLY_FRAMES) {
      ws.close(4429, 'Too many frames before key verification');
      return;
    }
    earlyFrames.push(text);
  });

  ws.on('close', () => {
    // Only the socket that owns the slot may free it — a rejected or stale
    // socket closing must not disconnect the live agent.
    if (_agents.get(clusterId)?.ws === ws) {
      _agents.delete(clusterId);
      logger.info(`[agent-registry] Agent disconnected: ${clusterId}`);
    }
  });

  if (!ready) {
    void resolveAgentKey(clusterId).then((key) => {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        return;
      }
      if (!key) {
        logger.warn(`[agent-registry] Rejected connection for unregistered cluster: ${clusterId}`);
        ws.close(4401, 'Unknown cluster — register first');
        return;
      }
      publicKey = key;
      ready = true;
      for (const raw of earlyFrames.splice(0)) {
        processFrame(raw);
      }
    });
  }
}
