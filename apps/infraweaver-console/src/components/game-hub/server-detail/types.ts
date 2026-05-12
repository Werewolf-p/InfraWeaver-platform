export interface ServicePort { name: string | null; port: number; nodePort: number | null; protocol: string; }
export interface GameEvent { type: string; reason: string; message: string; timestamp: string | null; count: number; involvedKind: string; involvedName: string; }
export interface FileEntry { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number; modifiedAt: string; permissions: string; }
export interface ServerDetail {
  name: string; gameType: string; status?: string; replicas: number; readyReplicas: number; restartCount?: number;
  podName: string | null; podPhase: string | null; podStartTime: string | null; port: number | null; nodePort: number | null; nodeIp: string | null;
  allPorts: ServicePort[]; portReachable?: boolean; maintenanceMode?: boolean; scheduledRestart?: string | null; backupSchedule?: string | null; backupRetention?: number; backupTarget?: string;
  hpa: { enabled: boolean; min: number; max: number; cpuTarget: number | null; currentReplicas: number | null };
  restartPolicy: string; memory: string; cpu: string; notes: string; env: Array<{ name: string; value?: string; valueFrom?: unknown }>; createdAt: string | null;
  playerHistory?: Array<{ t: number; n: number }>; pvc?: { name: string; size: string | null; storageClass: string | null; allowExpansion: boolean } | null;
  permissions?: { canConsole: boolean; canAdmin: boolean; canStart: boolean; canStop: boolean; canWriteFiles: boolean; readOnlyFiles: boolean };
  egg?: { mountPath: string; quickCommands: Array<{ label: string; command: string; description: string }> };
  allowedCommands?: string[]; nasTargets?: { truenas: boolean; synology: boolean };
}
export interface MetricPoint { cpu: number; cpuLimit: number; memory: number; memoryLimit: number; timestamp: string; }
export interface DiskUsage { used: string; available: string; percent: number; mountPath: string; }
export interface BackupEntry { filename: string; size: string; bytes: number; createdAt: string; }
export interface AuditEntry { timestamp: string; user: string; action: string; details: string; }
export interface PlayerEntry { name: string; ip: string | null; countryCode: string | null; group: string; }
export interface PlayerStats { recentJoins: Array<{ player: string; time: string }>; recentLeaves: Array<{ player: string; time: string }>; uniqueToday: number; }
export interface ChatMessage { player: string; message: string; timestamp: string; }
export interface WhitelistData { enabled: boolean; players: string[]; gameType: string; }
export interface BansData { bans: Array<{ name?: string; reason?: string; created?: string; source?: string }> }
export interface PluginsData { plugins: string[]; mods: string[]; }
