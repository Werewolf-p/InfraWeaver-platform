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
}

export interface NasShare {
  name: string;
  desc?: string;
  path: string;
}

export interface NasFolder {
  name: string;
  path: string;
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

export function useNasAddProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NasProviderInput) => {
      const res = await fetch("/api/nas/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; id?: string };
      if (!res.ok) {
        const message = typeof data.error === "string" ? data.error : "Failed to add provider";
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

export function useNasFolders(provider: string | null, share: string | null) {
  return useQuery({
    queryKey: ["nas", "folders", provider, share],
    queryFn: async () => {
      if (!provider || !share) return [];
      const res = await fetch(`/api/nas/folders?provider=${provider}&share=${encodeURIComponent(share)}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("Failed to fetch folders");
      const data = await res.json() as { folders: NasFolder[] };
      return data.folders;
    },
    enabled: !!provider && !!share,
    staleTime: 60000,
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
