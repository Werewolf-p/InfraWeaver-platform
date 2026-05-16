export const queryKeys = {
  argocd: {
    all: () => ["argocd"] as const,
    apps: () => ["argocd", "apps"] as const,
    app: (name: string) => ["argocd", "apps", name] as const,
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
    detail: (namespace: string, name: string) => ["pods", namespace, name] as const,
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
    memoryHeatmap: () => ["cluster", "memory-heatmap"] as const,
    topConsumers: () => ["cluster", "top-consumers"] as const,
    scheduledTasks: () => ["cluster", "scheduled-tasks"] as const,
    configDrift: () => ["cluster", "config-drift"] as const,
    quota: () => ["cluster", "quota"] as const,
    cost: () => ["cluster", "cost"] as const,
  },
  profile: {
    all: () => ["profile"] as const,
    summary: () => ["profile", "summary"] as const,
    sessions: () => ["profile", "sessions"] as const,
    activity: () => ["profile", "activity"] as const,
  },
  settings: {
    all: () => ["settings"] as const,
    connection: (label: string) => ["settings", "connection", label.toLowerCase()] as const,
  },
  wiki: {
    all: () => ["wiki"] as const,
    search: () => ["wiki", "search"] as const,
  },
} as const;
