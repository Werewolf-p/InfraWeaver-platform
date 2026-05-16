export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
}

export function createOpenApiDocument(serverUrl = 'http://localhost:3001'): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'InfraWeaver API',
      version: process.env.npm_package_version ?? '1.0.0',
      description: 'Developer-facing contract for the InfraWeaver hub API and cluster operations routes.',
    },
    servers: [
      { url: serverUrl, description: 'active API origin' },
      { url: 'http://localhost:3001', description: 'local development' },
    ],
    tags: [
      { name: 'System', description: 'health and documentation endpoints' },
      { name: 'Clusters', description: 'cluster registration and health checks' },
      { name: 'Kubernetes', description: 'node, pod, and event reads' },
      { name: 'ArgoCD', description: 'application state and sync operations' },
      { name: 'Storage', description: 'Longhorn volume insights' },
      { name: 'Metrics', description: 'node and pod metrics' },
      { name: 'Mode', description: 'deployment and live mode controls' },
      { name: 'RBAC', description: 'rbac sync operations' },
      { name: 'Agents', description: 'node-agent registration and lifecycle' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'API health check',
          responses: {
            '200': { description: 'API is healthy' },
          },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['System'],
          summary: 'Fetch generated OpenAPI document',
          responses: {
            '200': { description: 'OpenAPI document' },
          },
        },
      },
      '/api/v1/clusters': {
        get: {
          tags: ['Clusters'],
          summary: 'List registered clusters',
          responses: {
            '200': { description: 'Cluster list' },
            '403': { description: 'Missing cluster:admin permission' },
          },
        },
        post: {
          tags: ['Clusters'],
          summary: 'Register a cluster',
          responses: {
            '201': { description: 'Cluster created' },
            '400': { description: 'Invalid body' },
            '409': { description: 'Cluster already exists' },
          },
        },
      },
      '/api/v1/clusters/{id}/health': {
        get: {
          tags: ['Clusters'],
          summary: 'Probe cluster health',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Cluster health result' },
            '404': { description: 'Cluster not found' },
          },
        },
      },
      '/api/v1/k8s/nodes': {
        get: {
          tags: ['Kubernetes'],
          summary: 'List Kubernetes nodes',
          responses: {
            '200': { description: 'Node list' },
            '502': { description: 'Upstream cluster fetch failed' },
          },
        },
      },
      '/api/v1/k8s/pods': {
        get: {
          tags: ['Kubernetes'],
          summary: 'List pods',
          parameters: [
            { name: 'namespace', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Pod list' },
          },
        },
      },
      '/api/v1/k8s/pods/{namespace}/{name}/logs': {
        get: {
          tags: ['Kubernetes'],
          summary: 'Read pod logs',
          parameters: [
            { name: 'namespace', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'container', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'lines', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000 } },
          ],
          responses: {
            '200': { description: 'Plain-text pod logs' },
            '404': { description: 'Container not found' },
          },
        },
      },
      '/api/v1/k8s/events': {
        get: {
          tags: ['Kubernetes'],
          summary: 'List recent cluster events',
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Event list' },
          },
        },
      },
      '/api/v1/argocd/apps': {
        get: {
          tags: ['ArgoCD'],
          summary: 'List ArgoCD applications',
          responses: {
            '200': { description: 'Application list' },
          },
        },
      },
      '/api/v1/argocd/apps/{name}': {
        get: {
          tags: ['ArgoCD'],
          summary: 'Get an ArgoCD application',
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Application detail' },
            '404': { description: 'Application not found' },
          },
        },
        delete: {
          tags: ['ArgoCD'],
          summary: 'Delete an ArgoCD application',
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Application deleted or mocked' },
          },
        },
      },
      '/api/v1/argocd/apps/{name}/sync': {
        post: {
          tags: ['ArgoCD'],
          summary: 'Trigger an ArgoCD sync',
          parameters: [
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Sync accepted' },
          },
        },
      },
      '/api/v1/longhorn/volumes': {
        get: {
          tags: ['Storage'],
          summary: 'List Longhorn volumes',
          responses: {
            '200': { description: 'Volume list' },
          },
        },
      },
      '/api/v1/metrics/nodes': {
        get: {
          tags: ['Metrics'],
          summary: 'Read node metrics',
          responses: {
            '200': { description: 'Node metrics' },
          },
        },
      },
      '/api/v1/metrics/pods': {
        get: {
          tags: ['Metrics'],
          summary: 'Read pod metrics',
          responses: {
            '200': { description: 'Pod metrics' },
          },
        },
      },
      '/api/v1/mode': {
        get: {
          tags: ['Mode'],
          summary: 'Get current operation mode',
          responses: {
            '200': { description: 'Current mode' },
          },
        },
        put: {
          tags: ['Mode'],
          summary: 'Update operation mode',
          responses: {
            '200': { description: 'Mode updated' },
            '403': { description: 'Missing cluster:admin permission' },
          },
        },
      },
      '/api/v1/rbac/sync': {
        get: {
          tags: ['RBAC'],
          summary: 'Inspect RBAC sync status',
          responses: {
            '200': { description: 'RBAC sync payload preview' },
          },
        },
        post: {
          tags: ['RBAC'],
          summary: 'Broadcast RBAC sync to agents',
          responses: {
            '200': { description: 'Sync result' },
          },
        },
      },
      '/api/v1/agents': {
        get: {
          tags: ['Agents'],
          summary: 'List connected agents',
          responses: {
            '200': { description: 'Connected agents' },
          },
        },
      },
      '/api/v1/agents/pending': {
        get: {
          tags: ['Agents'],
          summary: 'List pending discovery requests',
          responses: {
            '200': { description: 'Pending discoveries' },
          },
        },
      },
      '/api/v1/agents/pending/{agentId}/approve': {
        post: {
          tags: ['Agents'],
          summary: 'Approve a pending agent discovery',
          parameters: [
            { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Discovery approved' },
            '404': { description: 'Discovery request not found' },
          },
        },
      },
      '/api/v1/agents/pending/{agentId}/reject': {
        post: {
          tags: ['Agents'],
          summary: 'Reject a pending agent discovery',
          parameters: [
            { name: 'agentId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Discovery rejected' },
            '404': { description: 'Discovery request not found' },
          },
        },
      },
      '/api/v1/agents/bootstrap': {
        post: {
          tags: ['Agents'],
          summary: 'Create a bootstrap token and install manifest',
          responses: {
            '200': { description: 'Bootstrap payload' },
          },
        },
      },
      '/api/v1/agents/install/{token}': {
        get: {
          tags: ['Agents'],
          summary: 'Download the generated agent install manifest',
          parameters: [
            { name: 'token', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'YAML manifest' },
          },
        },
      },
    },
  };
}
