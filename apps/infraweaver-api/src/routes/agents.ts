import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  approveDiscovery,
  createPendingRegistration,
  getConnectedAgents,
  getHubPublicKeyBase64,
  getPendingDiscoveries,
  rejectDiscovery,
} from '../lib/agent-registry.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

export const agentsRoute = new Hono<AppBindings>();

const NODE_IMAGE = process.env.NODE_AGENT_IMAGE ?? 'onedev.yourdomain.com/infraweaver/infraweaver-node:main';
const HUB_URL = process.env.HUB_URL ?? 'https://api.int.yourdomain.com';

agentsRoute.get('/', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:read')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agents = getConnectedAgents();
  return c.json({
    agents: agents.map((agent) => ({
      clusterId: agent.clusterId,
      connectedAt: agent.connectedAt.toISOString(),
      lastHeartbeat: agent.lastHeartbeat.toISOString(),
      status: agent.status,
    })),
  });
});

agentsRoute.get('/pending', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return c.json({ pending: getPendingDiscoveries() });
});

agentsRoute.post(
  '/pending/:agentId/approve',
  zValidator('json', z.object({
    clusterId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    clusterName: z.string().min(1).max(128).optional(),
    environment: z.enum(['production', 'staging', 'development']).default('development'),
  })),
  async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:admin')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const agentId = c.req.param('agentId');
    const { clusterId, clusterName, environment } = c.req.valid('json');
    const ok = approveDiscovery(agentId, clusterId, clusterName ?? clusterId);
    if (!ok) {
      return c.json({ error: 'Discovery request not found or already processed' }, 404);
    }

    return c.json({ approved: true, clusterId, environment });
  },
);

agentsRoute.post('/pending/:agentId/reject', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agentId = c.req.param('agentId');
  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  const ok = rejectDiscovery(agentId, body.reason ?? 'Rejected by admin');
  if (!ok) {
    return c.json({ error: 'Discovery request not found' }, 404);
  }

  return c.json({ rejected: true });
});

agentsRoute.post(
  '/bootstrap',
  zValidator('json', z.object({
    clusterId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    clusterName: z.string().min(1).max(128),
    environment: z.enum(['production', 'staging', 'development']).default('development'),
    syncMode: z.enum(['hub', 'self', 'none']).default('hub'),
  })),
  async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:admin')) {
      return c.json({ error: 'Forbidden — cluster:admin required' }, 403);
    }

    const { clusterId, clusterName, environment, syncMode } = c.req.valid('json');
    const token = createPendingRegistration(clusterId, clusterName);
    const installUrl = `${HUB_URL}/v1/agents/install/${token}`;

    return c.json({
      clusterId,
      clusterName,
      environment,
      syncMode,
      token,
      installUrl,
      hubPublicKey: getHubPublicKeyBase64(),
      kubectlCommand: `kubectl apply -f "${installUrl}"`,
      expiresIn: '15 minutes',
      instructions: [
        '1. Run this command on the target cluster:',
        `   kubectl apply -f "${installUrl}"`,
        '2. The agent will connect automatically within ~30 seconds',
        '3. Monitor progress in the console at /cluster/registry',
      ],
    });
  },
);

agentsRoute.get('/install/:token', async (c) => {
  const token = c.req.param('token');
  const manifest = generateInstallManifest(token);

  return new Response(manifest, {
    headers: {
      'Content-Type': 'application/yaml',
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="infraweaver-node-install.yaml"',
    },
  });
});

function generateInstallManifest(token: string): string {
  return `# InfraWeaver Node Agent — Auto-generated install manifest
# Generated: ${new Date().toISOString()}
# Apply with: kubectl apply -f <this-file>
---
apiVersion: v1
kind: Namespace
metadata:
  name: infraweaver-system
  labels:
    app.kubernetes.io/name: infraweaver-system
    infraweaver.io/type: system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: infraweaver-node
  namespace: infraweaver-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: infraweaver-node
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "namespaces", "nodes", "events", "services", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
  - apiGroups: ["argoproj.io"]
    resources: ["applications"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "create", "update", "patch"]
    resourceNames: ["infraweaver-node-state"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: infraweaver-node
subjects:
  - kind: ServiceAccount
    name: infraweaver-node
    namespace: infraweaver-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: infraweaver-node
---
apiVersion: v1
kind: Secret
metadata:
  name: infraweaver-node-registration
  namespace: infraweaver-system
type: Opaque
stringData:
  REGISTRATION_TOKEN: "${token}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: infraweaver-node
  namespace: infraweaver-system
  labels:
    app: infraweaver-node
spec:
  replicas: 1
  selector:
    matchLabels:
      app: infraweaver-node
  template:
    metadata:
      labels:
        app: infraweaver-node
    spec:
      serviceAccountName: infraweaver-node
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: node
          image: ${NODE_IMAGE}
          env:
            - name: HUB_URL
              value: "${HUB_URL.replace('https://', 'wss://').replace('http://', 'ws://')}"
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: CLUSTER_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName  # uses the k8s node name as default cluster name
            - name: REGISTRATION_TOKEN
              valueFrom:
                secretKeyRef:
                  name: infraweaver-node-registration
                  key: REGISTRATION_TOKEN
                  optional: true
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
`;
}
