import { createPublicKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
const _agents = new Map();
const _pending = new Map();
const _pendingDiscovery = new Map();
const _registeredKeys = new Map();
let _hubKeyPair = null;
function importPublicKey(publicKeyBase64) {
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
export function getHubPublicKeyBase64() {
    const kp = getHubKeyPair();
    return kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}
function signFrame(message) {
    const sign = createSign('SHA256');
    sign.update(message);
    sign.end();
    return sign.sign(getHubKeyPair().privateKey, 'base64');
}
function getRegisteredSignaturePayload(frame) {
    return [frame.type, frame.ts, frame.clusterId, frame.hubPublicKey].join(':');
}
export function createPendingRegistration(clusterId, clusterName) {
    const token = randomBytes(32).toString('hex');
    _pending.set(token, {
        token,
        clusterId,
        clusterName,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    return token;
}
export function getConnectedAgents() {
    return Array.from(_agents.values());
}
export function getAgent(clusterId) {
    return _agents.get(clusterId);
}
export function getPendingDiscoveries() {
    return Array.from(_pendingDiscovery.values()).map(({ ws, ...rest }) => rest);
}
export function approveDiscovery(agentId, clusterId, clusterName) {
    const req = _pendingDiscovery.get(agentId);
    if (!req) {
        return false;
    }
    const pubKey = importPublicKey(req.publicKeyBase64);
    _registeredKeys.set(clusterId, pubKey);
    req.ws.send(JSON.stringify({
        type: 'approved',
        clusterId,
        hubPublicKey: getHubPublicKeyBase64(),
        ts: Date.now(),
    }));
    setTimeout(() => req.ws.close(1000, 'approved'), 500);
    _pendingDiscovery.delete(agentId);
    console.log(`[agent-registry] Approved discovery request: ${agentId} -> ${clusterId} (${clusterName})`);
    return true;
}
export function rejectDiscovery(agentId, reason) {
    const req = _pendingDiscovery.get(agentId);
    if (!req) {
        return false;
    }
    req.ws.send(JSON.stringify({ type: 'rejected', reason, ts: Date.now() }));
    setTimeout(() => req.ws.close(1000, 'rejected'), 500);
    _pendingDiscovery.delete(agentId);
    console.log(`[agent-registry] Rejected discovery request: ${agentId}`);
    return true;
}
export function broadcastToAgents(frame) {
    const payload = JSON.stringify(frame);
    for (const agent of _agents.values()) {
        if (agent.ws.readyState === WebSocket.OPEN) {
            agent.ws.send(payload);
        }
    }
}
export function sendToAgent(clusterId, frame) {
    const agent = _agents.get(clusterId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    agent.ws.send(JSON.stringify(frame));
    return true;
}
export function broadcastModeChange(mode) {
    broadcastToAgents({ type: 'mode-change', mode, ts: Date.now() });
}
export function setupWebSocketServer(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
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
function handleRegister(ws) {
    ws.once('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
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
            const registeredFrame = {
                type: 'registered',
                clusterId: pending.clusterId,
                hubPublicKey: getHubPublicKeyBase64(),
                ts: Date.now(),
            };
            ws.send(JSON.stringify({
                ...registeredFrame,
                sig: signFrame(getRegisteredSignaturePayload(registeredFrame)),
            }));
            ws.close();
            console.log(`[agent-registry] Registered new cluster: ${pending.clusterId} (${pending.clusterName})`);
        }
        catch (error) {
            console.error('[agent-registry] Registration error:', error);
            ws.close(4000, 'Registration failed');
        }
    });
}
function handleDiscover(ws, _req) {
    ws.once('message', (raw) => {
        try {
            const frame = JSON.parse(raw.toString());
            if (frame.type !== 'hello') {
                ws.close(4001, 'Expected hello frame');
                return;
            }
            const { agentId, clusterName, publicKey, clusterCaFingerprint } = frame;
            if (!agentId || !clusterName || !publicKey) {
                ws.close(4001, 'Missing required fields');
                return;
            }
            const request = {
                agentId,
                clusterName,
                publicKeyBase64: publicKey,
                clusterCaFingerprint: clusterCaFingerprint ?? 'unknown',
                receivedAt: new Date(),
                ws,
            };
            _pendingDiscovery.set(agentId, request);
            console.log(`[agent-registry] New discovery request from: ${clusterName} (${agentId})`);
            ws.send(JSON.stringify({ type: 'ack', status: 'pending_approval', ts: Date.now() }));
            ws.on('close', () => {
                _pendingDiscovery.delete(agentId);
                console.log(`[agent-registry] Discovery disconnected: ${agentId}`);
            });
        }
        catch (error) {
            console.error('[agent-registry] Discovery error:', error);
            ws.close(4000, 'Discovery failed');
        }
    });
}
function handleCluster(ws, clusterId) {
    const conn = {
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
            const frame = JSON.parse(raw.toString());
            if (frame.type === 'heartbeat') {
                conn.lastHeartbeat = new Date();
                conn.status = frame.status ?? conn.status;
            }
            else if (frame.type === 'response' && frame.requestId) {
                ws.emit(`response:${frame.requestId}`, frame);
            }
        }
        catch {
            // Ignore malformed frames.
        }
    });
    ws.on('close', () => {
        _agents.delete(clusterId);
        console.log(`[agent-registry] Agent disconnected: ${clusterId}`);
    });
}
//# sourceMappingURL=agent-registry.js.map