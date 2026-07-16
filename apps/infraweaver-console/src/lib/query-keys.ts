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
  secrets: {
    all: () => ["secrets"] as const,
    // Shared collector key for the Secret & GitOps lifecycle report. Subject 2's
    // observability board queries this exact key via SecretHealthSummary.
    lifecycle: () => ["secrets", "lifecycle"] as const,
  },
  audit: {
    all: () => ["audit"] as const,
    query: (params: Record<string, string | number | undefined>) => ["audit", "query", params] as const,
  },
  rbac: {
    all: () => ["rbac"] as const,
    myPermissions: () => ["rbac", "my-permissions"] as const,
    subjects: () => ["rbac", "subjects"] as const,
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
    costAttribution: () => ["cluster", "cost-attribution"] as const,
    rightsizing: () => ["cluster", "rightsizing"] as const,
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
  selfService: {
    all: () => ["self-service"] as const,
    /** The caller's own requests (My Requests). */
    mine: () => ["self-service", "mine"] as const,
    /** The admin approval queue (pending requests across all users). */
    pending: () => ["self-service", "pending"] as const,
    /** The caller's own expandable PVCs, feeding the storage-quota form. */
    ownedPvcs: () => ["self-service", "owned-pvcs"] as const,
  },
} as const;
