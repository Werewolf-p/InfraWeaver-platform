"use client";

// Hooks for the storage access panel: read the grants that bear on a folder,
// grant a storage role on it, revoke one, and force-reconcile the share's
// Authentik groups. Backed by /api/nas/access, which is a storage-shaped facade
// over the ordinary RBAC assignment machinery.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** The two roles a storage grant may confer. Mirrors the server's allow-list. */
export type StorageRoleId = "storage-viewer" | "storage-contributor";

export interface StorageGrant {
  assignmentId: string;
  roleId: string;
  scope: string;
  principalType: "user" | "group";
  principalId: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
  /** Made on an ancestor scope, so it must be revoked there, not here. */
  inherited: boolean;
}

export interface StorageAccessCandidates {
  users: Array<{ username: string; name: string; email: string }>;
  groups: string[];
}

export interface StorageAccessResponse {
  scope: string;
  label: string;
  grants: StorageGrant[];
  canManage: boolean;
  candidates: StorageAccessCandidates;
  /** Authentik groups driven by this scope's grants; what a Nextcloud mount binds. */
  accessGroups: { readonly: string; readwrite: string };
}

export interface StorageLocation {
  provider: string;
  share: string;
  path?: string;
}

function locationKey(location: StorageLocation | null) {
  return ["nas", "access", location?.provider ?? "", location?.share ?? "", location?.path ?? ""];
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === "string" ? data.error : fallback;
}

/** Who can reach this folder, and via which grant. `null` disables the query. */
export function useStorageAccess(location: StorageLocation | null) {
  return useQuery<StorageAccessResponse>({
    queryKey: locationKey(location),
    queryFn: async () => {
      const params = new URLSearchParams({
        provider: location!.provider,
        share: location!.share,
        ...(location!.path ? { path: location!.path } : {}),
      });
      const res = await fetch(`/api/nas/access?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(await readError(res, "Failed to load storage access"));
      return await res.json() as StorageAccessResponse;
    },
    enabled: Boolean(location?.provider && location?.share),
    staleTime: 15_000,
  });
}

export interface GrantStorageAccessInput extends StorageLocation {
  roleId: StorageRoleId;
  principalType: "user" | "group";
  principal: string;
  /** ISO timestamp; the grant stops conferring access after it. */
  expiresAt?: string;
}

export function useGrantStorageAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: GrantStorageAccessInput) => {
      const res = await fetch("/api/nas/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to grant access"));
      return await res.json() as { ok: true; scope: string };
    },
    onSuccess: () => {
      // The grant changes who may see which folders, so the listings are stale too.
      qc.invalidateQueries({ queryKey: ["nas", "access"] });
      qc.invalidateQueries({ queryKey: ["nas", "folders"] });
      qc.invalidateQueries({ queryKey: ["nas", "shares"] });
    },
  });
}

export function useRevokeStorageAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { assignmentId: string; principalType: "user" | "group"; principal: string }) => {
      const res = await fetch("/api/nas/access", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to revoke access"));
      return await res.json() as { ok: true };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nas", "access"] });
      qc.invalidateQueries({ queryKey: ["nas", "folders"] });
      qc.invalidateQueries({ queryKey: ["nas", "shares"] });
    },
  });
}

export interface ShareAccessSyncResult {
  readonly: { applied: string[]; unknown: string[] };
  readwrite: { applied: string[]; unknown: string[] };
  groups: { readonly: string; readwrite: string };
}

/**
 * Force the share's Authentik groups back in line with RBAC. The grant path does
 * this automatically; this is the escape hatch for a failed fan-out or a broad
 * `/nas` grant, which is not fanned out per share.
 */
export function useSyncShareAccess() {
  return useMutation({
    mutationFn: async (location: StorageLocation) => {
      const res = await fetch("/api/nas/access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(location),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to sync access groups"));
      return await res.json() as { ok: true } & ShareAccessSyncResult;
    },
  });
}
