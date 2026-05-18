export interface ServicePort {
  name: string | null;
  port: number;
  targetPort?: number | null;
  nodePort: number | null;
  protocol: string;
}

export interface GameEvent {
  type: string;
  reason: string;
  message: string;
  timestamp: string | null;
  count: number;
  involvedKind: string;
  involvedName: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
  permissions: string;
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
}

export interface Volume {
  name: string;
  type: string;
  claimName?: string | null;
  pvcSize?: string | null;
}

export interface SavedCommand {
  id?: string;
  label: string;
  cmd: string;
  color?: string;
  description?: string;
}

export interface PowerSchedule {
  time: string;
  days: string[];
  timezone: string;
}

export interface ProcessEntry {
  user: string;
  pid: string;
  cpu: number;
  mem: number;
  command: string;
}

export interface NetworkEntry {
  iface: string;
  rxBytes: number;
  rxPackets: number;
  txBytes: number;
  txPackets: number;
}

export type ConnectivityStatus = "open" | "closed" | "unverified" | "unknown";

export interface ConnectivityPortStatus {
  name: string | null;
  servicePort: number | null;
  nodePort: number | null;
  protocol: string;
  status: ConnectivityStatus;
  open: boolean | null;
  latencyMs: number | null;
  message?: string | null;
}

export interface ConnectivityDetails {
  status?: ConnectivityStatus;
  message?: string | null;
  internal: {
    ready: boolean;
    clusterIP?: string | null;
    port?: number | null;
    message?: string | null;
  };
  external: {
    status: ConnectivityStatus;
    open: boolean | null;
    host?: string | null;
    port?: number | null;
    protocol?: string | null;
    latencyMs?: number | null;
    message?: string | null;
  };
  ports: ConnectivityPortStatus[];
}

export interface ServerDetail {
  name: string;
  gameType: string;
  dnsHostname?: string;
  status?: string;
  replicas: number;
  readyReplicas: number;
  restartCount?: number;
  podName: string | null;
  podPhase: string | null;
  podStartTime: string | null;
  port: number | null;
  nodePort: number | null;
  nodeIp: string | null;
  allPorts: ServicePort[];
  portReachable?: boolean;
  maintenanceMode?: boolean;
  scheduledRestart?: string | null;
  scheduleStart?: PowerSchedule | null;
  scheduleStop?: PowerSchedule | null;
  alertCpu?: number | null;
  alertMemory?: number | null;
  alertRestarts?: number | null;
  backupSchedule?: string | null;
  backupRetention?: number;
  backupTarget?: string;
  hpa: { enabled: boolean; min: number; max: number; cpuTarget: number | null; currentReplicas: number | null };
  restartPolicy: string;
  memory: string;
  cpu: string;
  notes: string;
  env: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  createdAt: string | null;
  playerHistory?: Array<{ t: number; n: number }>;
  events?: GameEvent[];
  pvc?: { name: string; size: string | null; storageClass: string | null; allowExpansion: boolean } | null;
  permissions?: {
    canRead: boolean;
    canPlayers: boolean;
    canConsole: boolean;
    canOpenConsole: boolean;
    canAdmin: boolean;
    canStart: boolean;
    canStop: boolean;
    canWriteFiles: boolean;
    readOnlyFiles: boolean;
  };
  egg?: {
    mountPath: string;
    stopCommand?: string;
    description?: string;
    connectionHint?: string;
    environment?: Array<{ name: string; description: string; defaultValue: string; required: boolean; fieldType?: "text" | "boolean" | "integer"; userViewable?: boolean; userEditable?: boolean; rules?: string }>;
    quickCommands: Array<{ label: string; cmd?: string; command?: string; description?: string; color?: string }>;
    /** Log line pattern that signals server finished starting (from config.startup.done) */
    startupReadySignal?: string;
    /** Platform feature flags: "eula", "java_version", "pid_limit" etc. */
    features?: string[];
    /** Multiple image choices (PTDL_v2); key = label, value = image */
    dockerImages?: Record<string, string>;
    /** Files the file manager should deny access to */
    fileDenylist?: string[];
    author?: string;
    exportedAt?: string;
  };
  allowedCommands?: string[];
  nasTargets?: { truenas: boolean; synology: boolean };
  description?: string;
  icon?: string;
  tags?: string[];
  groups?: string[];
  image?: string;
  imageVersion?: string;
  imagePinned?: boolean;
  imagePullPolicy?: string;
  deploymentStrategy?: string;
  savedCommands?: SavedCommand[];
  volumeMounts?: VolumeMount[];
  volumes?: Volume[];
  scheduledAction?: string | null;
  scheduledTime?: string | null;
  deploymentYaml?: string;
}

export interface MetricPoint {
  cpu: number;
  cpuLimit: number;
  memory: number;
  memoryLimit: number;
  cpuRaw: number;
  memoryRaw: number;
  timestamp: string;
}

export interface DiskUsage {
  filesystem: {
    total: string;
    used: string;
    available: string;
    percent: number;
    mountPath: string;
    raw?: string;
  };
  topDirs: Array<{ size: string; path: string }>;
}

export interface BackupEntry {
  filename: string;
  path?: string;
  size: string;
  bytes: number;
  createdAt: string;
  checksum?: string;
  status?: "verified" | "warning";
}
export interface AuditEntry { timestamp: string; user: string; action: string; details: string; }
export interface PlayerEntry { name: string; ip: string | null; countryCode: string | null; group: string; }
export interface PlayerStats { recentJoins: Array<{ player: string; time: string }>; recentLeaves: Array<{ player: string; time: string }>; uniqueToday: number; }
export interface PluginsData { plugins: string[]; mods: string[]; }
