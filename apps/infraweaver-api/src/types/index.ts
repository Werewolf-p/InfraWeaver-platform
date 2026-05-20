export interface ClusterMeta {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  tags: string[];
  status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  lastSeen: string;
  isLocal: boolean;
  argocdServer?: string;
  argocdToken?: string;
}

export interface UserContext {
  id: string;
  roles: string[];
  clusterId: string;
}

export interface AppBindings {
  Variables: {
    user: UserContext;
    requestId: string;
  };
}
