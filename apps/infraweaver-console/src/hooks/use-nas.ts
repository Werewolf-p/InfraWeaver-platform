"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type NasProviderKind = "synology" | "truenas" | "generic-smb" | "generic-nfs";

export interface NasProvider {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: string;
  kind?: NasProviderKind;
  backends?: Array<"smb" | "nfs">;
  /** "env" = built-in from environment (read-only); "openbao" = added via UI. */
  source?: "env" | "openbao";
  enabled: boolean;
  hasCredentials?: boolean;
  reachable: boolean;
}

export interface NasProviderInput {
  /** Set to update an existing provider; omit to create a new one. */
  id?: string;
  name: string;
  host: string;
  kind: NasProviderKind;
  port?: number;
  protocol?: "http" | "https";
  credentials: {
    username?: string;
    password?: string;
    apiKey?: string;
  };
  /** When true, `credentials` are a one-time admin credential: the server mints
   *  a least-privilege service account on the NAS and stores only that scoped
   *  credential (the admin credential is never persisted). Synology/TrueNAS only. */
  provisionScoped?: boolean;
  /** SHA-256 fingerprint of the appliance's TLS certificate, once the operator
   *  has confirmed it. NAS appliances use self-signed certs, so the first save
   *  is answered with a certificate challenge instead of a silent trust. */
  tlsFingerprint256?: string;
  /** TrueNAS only: the TrueNAS user the minted scoped API key is bound to.
   *  The key inherits that user's privileges. */
  scopedUsername?: string;
}

export interface NasShare {
  name: string;
  desc?: string;
  path: string;
}

export interface NasFolder {
  /** Base name, e.g. `movies`. */
  name: string;
  /** Share-relative path, e.g. `media/movies` — what the mount flow consumes. */
  subfolder: string;
}

export interface NasAssignment {
  provider: string;
  share: string;
  subfolder?: string;
  access: "readonly" | "readwrite";
  pvc_namespace?: string;
  pvc_name?: string;
  created_at?: string;
}

export interface UserAssignments {
  username: string;
  name: string;
  nas_shares: NasAssignment[];
}

export interface NasMount {
  pvcName: string;
  pvcNamespace: string;
  storageClass: string;
  provider: string;
  user: string;
  access: "ro" | "rw";
  source: string | null;
  subDir: string | null;
  pod: string | null;
  podPhase: string | null;
  mountPath: string | null;
  mountReadOnly: boolean | null;
  phase: string | null;
}

export function useNasMounts() {
  return useQuery({
    queryKey: ["nas", "mounts"],
    queryFn: async () => {
      const res = await fetch("/api/nas/mounts", { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error("Failed to fetch NAS mounts");
      const data = await res.json() as { mounts: NasMount[] };
      return data.mounts;
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });
}

export function useNasProviders() {
  return useQuery({
    queryKey: ["nas", "providers"],
    queryFn: async () => {
      const res = await fetch("/api/nas/providers", { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("Failed to fetch NAS providers");
      const data = await res.json() as { providers: NasProvider[] };
      return data.providers;
    },
    staleTime: 30000,
  });
}

/** The appliance's certificate, as shown to the operator for confirmation. */
export interface NasCertificate {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  fingerprintDisplay: string;
  selfSigned: boolean;
}

/**
 * Thrown when the server refuses to send credentials to an appliance whose TLS
 * certificate has not been trusted (or no longer matches the stored pin). The
 * caller shows `certificate` and re-submits with `tlsFingerprint256` to accept.
 */
export class NasCertificateChallenge extends Error {
  constructor(
    message: string,
    readonly certificate: NasCertificate,
    readonly state: "untrusted" | "mismatch",
  ) {
    super(message);
    this.name = "NasCertificateChallenge";
  }
}

export function useNasAddProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NasProviderInput) => {
      const res = await fetch("/api/nas/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: unknown;
        id?: string;
        needsCertificateTrust?: boolean;
        certificateState?: "untrusted" | "mismatch";
        certificate?: NasCertificate;
      };
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : "Failed to add provider";
        if (res.status === 409 && data.needsCertificateTrust && data.certificate) {
          throw new NasCertificateChallenge(message, data.certificate, data.certificateState ?? "untrusted");
        }
        throw new Error(message);
      }
      return data as {
        ok: boolean;
        id: string;
        reachable: boolean;
        provisioned?: { scopedName?: string; warning?: string };
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "providers"] });
    },
  });
}

export function useNasDeleteProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch("/api/nas/providers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to delete provider");
      }
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "providers"] });
    },
  });
}

export function useNasShares(provider: string | null) {
  return useQuery({
    queryKey: ["nas", "shares", provider],
    queryFn: async () => {
      if (!provider) return [];
      const res = await fetch(`/api/nas/shares?provider=${provider}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("Failed to fetch shares");
      const data = await res.json() as { shares: NasShare[] };
      return data.shares;
    },
    enabled: !!provider,
    staleTime: 60000,
  });
}

/** Directories directly beneath `share/path`. `path` of "" browses the share root. */
export function useNasFolders(provider: string | null, share: string | null, path: string) {
  return useQuery({
    queryKey: ["nas", "folders", provider, share, path],
    queryFn: async () => {
      if (!provider || !share) return [];
      const params = new URLSearchParams({ provider, share, path });
      const res = await fetch(`/api/nas/folders?${params}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to fetch folders");
      }
      const data = await res.json() as { folders: NasFolder[] };
      return data.folders;
    },
    enabled: Boolean(provider && share),
    staleTime: 30000,
  });
}

/**
 * Create a folder on the NAS. The server also mints the provider's scoped SMB
 * service accounts and grants them the folder ACLs, so a freshly created folder
 * is immediately mountable at either access mode.
 */
export function useNasCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { provider: string; share: string; path: string }) => {
      const res = await fetch("/api/nas/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; path?: string; created?: string[] };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create folder");
      }
      return data as { ok: boolean; path: string; created: string[]; accountsGranted: boolean };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "folders"] });
    },
  });
}

/** A workload in the GitOps catalog that a NAS folder can be mounted into. */
export interface NasMountTarget {
  app: string;
  kind: "Deployment" | "StatefulSet";
  name: string;
  namespace: string;
  containers: string[];
  manifestPath: string;
}

export function useNasMountTargets() {
  return useQuery({
    queryKey: ["nas", "mount-targets"],
    queryFn: async () => {
      const res = await fetch("/api/nas/mount-targets", { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error("Failed to fetch mount targets");
      const data = await res.json() as { targets: NasMountTarget[] };
      return data.targets;
    },
    staleTime: 120000,
  });
}

export interface NasMountRequestTarget {
  namespace: string;
  workload: string;
  kind: "Deployment" | "StatefulSet";
  container?: string;
  mount_path: string;
  access: "readonly" | "readwrite";
  manifest_path: string;
}

/** Mount one folder into N workloads in a single GitOps commit. */
export function useNasMountWorkload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      provider: string;
      share: string;
      subfolder?: string;
      backend?: "smb" | "nfs";
      size?: string;
      targets: NasMountRequestTarget[];
    }) => {
      const res = await fetch("/api/nas/mount-workload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; files?: string[] };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Failed to mount folder");
      }
      return data as { ok: boolean; subfolder: string; files: string[] };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "mounts"] });
    },
  });
}

/** Remove one workload's mount. Never deletes data on the NAS. */
export function useNasUnmountWorkload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      provider: string;
      share: string;
      subfolder?: string;
      namespace: string;
      workload: string;
      kind: "Deployment" | "StatefulSet";
      access: "readonly" | "readwrite";
      manifest_path: string;
    }) => {
      const res = await fetch("/api/nas/mount-workload", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to unmount folder");
      return data as { ok: boolean; removed: boolean };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "mounts"] });
    },
  });
}

export function useNasAssignments() {
  return useQuery({
    queryKey: ["nas", "assignments"],
    queryFn: async () => {
      const res = await fetch("/api/nas/assignments", { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("Failed to fetch assignments");
      const data = await res.json() as { assignments: UserAssignments[] };
      return data.assignments;
    },
    staleTime: 30000,
  });
}

export function useNasAssign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      username: string;
      /** Any registered provider id (built-in or dynamically added). */
      provider: string;
      share: string;
      subfolder?: string;
      access: "readonly" | "readwrite";
      pvc_namespace?: string;
      pvc_name?: string;
    }) => {
      const res = await fetch("/api/nas/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to assign share");
      }
      return res.json() as Promise<{ ok: boolean; pvc_name: string; pvc_namespace: string; manifest_path: string; yaml: string }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "assignments"] });
      qc.invalidateQueries({ queryKey: ["config", "users"] });
    },
  });
}

export function useNasUnassign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      username: string;
      provider: string;
      share: string;
      subfolder?: string;
    }) => {
      const res = await fetch("/api/nas/assign", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to remove assignment");
      }
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "assignments"] });
      qc.invalidateQueries({ queryKey: ["config", "users"] });
    },
  });
}
