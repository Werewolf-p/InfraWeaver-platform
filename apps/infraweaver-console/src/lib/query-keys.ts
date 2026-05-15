export const queryKeys = {
  argocd: {
    all: () => ["argocd"] as const,
    apps: () => ["argocd", "apps"] as const,
  },
  security: {
    all: () => ["security"] as const,
    auditLog: () => ["security", "audit-log"] as const,
  },
  rbac: {
    all: () => ["rbac"] as const,
    myPermissions: () => ["rbac", "my-permissions"] as const,
  },
  pods: {
    all: () => ["pods"] as const,
    list: (namespace?: string) => (namespace ? (["pods", namespace] as const) : (["pods"] as const)),
  },
  config: {
    all: () => ["config"] as const,
    platform: () => ["config", "platform"] as const,
    catalogApps: () => ["config", "catalog-apps"] as const,
    users: () => ["config", "users"] as const,
  },
  cluster: {
    all: () => ["cluster"] as const,
    nodes: () => ["cluster", "nodes"] as const,
    metrics: (refreshSeconds?: number) =>
      refreshSeconds === undefined ? (["cluster", "metrics"] as const) : (["cluster", "metrics", refreshSeconds] as const),
    hpa: () => ["cluster", "hpa"] as const,
    nodePods: () => ["cluster", "node-pods"] as const,
    namespaceUsage: () => ["cluster", "namespace-usage"] as const,
    scheduledTasks: () => ["cluster", "scheduled-tasks"] as const,
    configDrift: () => ["cluster", "config-drift"] as const,
  },
} as const;
