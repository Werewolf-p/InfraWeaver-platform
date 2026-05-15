import { createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ApiMode } from './mode.js';

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

const _agents = new Map<string, AgentConnection>();
const _pending = new Map<string, PendingRegistration>();
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

export function getConnectedAgents(): AgentConnection[] {
  return Array.from(_agents.values());
}

export function getAgent(clusterId: string): AgentConnection | undefined {
  return _agents.get(clusterId);
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
      const msg = JSON.parse(raw.toString()) as { type?: string; token?: string; publicKey?: string };
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
      _pending.delete(msg.token);
      _registeredKeys.set(pending.clusterId, agentPublicKey);

      ws.send(JSON.stringify({
        type: 'registered',
        clusterId: pending.clusterId,
        hubPublicKey: getHubPublicKeyBase64(),
        ts: Date.now(),
      }));
      ws.close();

      console.log(`[agent-registry] Registered new cluster: ${pending.clusterId} (${pending.clusterName})`);
    } catch (error) {
      console.error('[agent-registry] Registration error:', error);
      ws.close(4000, 'Registration failed');
    }
  });
}

function handleCluster(ws: WebSocket, clusterId: string) {
  const conn: AgentConnection = {
    clusterId,
    ws,
    publicKey: _registeredKeys.get(clusterId) ?? getHubKeyPair().publicKey,
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
    status: { nodeCount: 0, podCount: 0, ready: false },
  };
  _agents.set(clusterId, conn);
  console.log(`[agent-registry] Agent connected: ${clusterId}`);

  ws.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString()) as {
        type?: string;
        status?: AgentConnection['status'];
        requestId?: string;
      };

      if (frame.type === 'heartbeat') {
        conn.lastHeartbeat = new Date();
        conn.status = frame.status ?? conn.status;
      } else if (frame.type === 'response' && frame.requestId) {
        ws.emit(`response:${frame.requestId}`, frame);
      }
    } catch {
      // Ignore malformed frames.
    }
  });

  ws.on('close', () => {
    _agents.delete(clusterId);
    console.log(`[agent-registry] Agent disconnected: ${clusterId}`);
  });
}
