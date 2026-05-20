"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export interface NasProvider {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: string;
  enabled: boolean;
  reachable: boolean;
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
  provider: "synology" | "truenas";
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

export function useNasProviders() {
  return useQuery({
    queryKey: ["nas", "providers"],
    queryFn: async () => {
      const res = await fetch("/api/nas/providers");
      if (!res.ok) throw new Error("Failed to fetch NAS providers");
      const data = await res.json() as { providers: NasProvider[] };
      return data.providers;
    },
    staleTime: 30000,
  });
}

export function useNasShares(provider: string | null) {
  return useQuery({
    queryKey: ["nas", "shares", provider],
    queryFn: async () => {
      if (!provider) return [];
      const res = await fetch(`/api/nas/shares?provider=${provider}`);
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
      const res = await fetch(`/api/nas/folders?provider=${provider}&share=${encodeURIComponent(share)}`);
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
      const res = await fetch("/api/nas/assignments");
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
      provider: "synology" | "truenas";
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
