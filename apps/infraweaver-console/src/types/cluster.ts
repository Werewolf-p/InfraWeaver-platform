export interface ClusterNode {
  name: string;
  status: "Ready" | "NotReady";
  roles: string[];
  version: string;
  ip: string;
  cpu: string;
  memory: string;
  unschedulable: boolean;
  age: string | null;
}

export interface ClusterNodeMetric {
  name: string;
  cpuPct: number;
  memPct: number;
  cpuMillicores: number;
  memKi: number;
}

export interface HorizontalPodAutoscalerSummary {
  name: string;
  namespace: string;
  minReplicas: number;
  maxReplicas: number;
  currentReplicas: number;
  desiredReplicas: number;
  targetCpuPct: number;
}

export interface ClusterNodePodInfo {
  name: string;
  namespace: string;
  node: string;
  cpuMillicores: number;
  memoryMi: number;
  ownerKind: string | null;
  ownerName: string | null;
  status: string;
  canMigrate: boolean;
}

export interface ClusterNodeCapacityInfo {
  name: string;
  allocatableMi: number;
  usedMi: number;
  availableMi: number;
  usedPct: number;
  status: "Ready" | "NotReady";
}

export interface ClusterDataPoint {
  time: string;
  value: number;
}

export interface NamespaceQuota {
  namespace: string;
  name: string;
  hard: Record<string, string>;
  used: Record<string, string>;
}

export interface NamespaceCost {
  namespace: string;
  cpuMillicores: number;
  memoryMiB: number;
  monthlyCostUsd: number;
}

export interface ClusterQuotaResponse {
  quotas: NamespaceQuota[];
}

export interface ClusterCostResponse {
  namespaces: NamespaceCost[];
  totalMonthlyCost: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  namespace: string;
  pod: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}

export interface ScheduledTaskFormValues {
  name: string;
  namespace: string;
  pod: string;
  schedule: string;
  command: string;
}

export interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
}

export interface ConfigDriftEntry {
  namespace: string;
  name: string;
  kind: string;
  replicas: number;
  image: string;
  capturedAt: string;
  currentReplicas: number;
  currentImage: string;
  drifted: boolean;
}

export interface ConfigDriftResponse {
  drift: ConfigDriftEntry[];
  baselineCaptured: boolean;
}
