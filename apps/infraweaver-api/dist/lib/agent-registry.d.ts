import { type KeyObject } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import type { ApiMode } from './mode.js';
export interface AgentConnection {
    clusterId: string;
    ws: WebSocket;
    publicKey: KeyObject;
    connectedAt: Date;
    lastHeartbeat: Date;
    status: {
        nodeCount: number;
        podCount: number;
        ready: boolean;
    };
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
export declare function getHubKeyPair(): {
    privateKey: KeyObject;
    publicKey: KeyObject;
};
export declare function getHubPublicKeyBase64(): string;
export declare function createPendingRegistration(clusterId: string, clusterName: string): string;
export declare function getConnectedAgents(): AgentConnection[];
export declare function getAgent(clusterId: string): AgentConnection | undefined;
export declare function getPendingDiscoveries(): Omit<DiscoveryRequest, 'ws'>[];
export declare function approveDiscovery(agentId: string, clusterId: string, clusterName: string): boolean;
export declare function rejectDiscovery(agentId: string, reason: string): boolean;
export declare function broadcastToAgents(frame: object): void;
export declare function sendToAgent(clusterId: string, frame: object): boolean;
export declare function broadcastModeChange(mode: ApiMode): void;
export declare function setupWebSocketServer(server: Server): void;
//# sourceMappingURL=agent-registry.d.ts.map