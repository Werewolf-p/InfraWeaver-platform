"use client";

// Hooks for Jellyfin access: who is granted, grant, revoke, force-reconcile, and
// reveal a provisioned password. Backed by /api/jellyfin/access and
// /api/jellyfin/credential.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoleAssignment } from "@/lib/rbac";

export type JellyfinRoleId = "jellyfin-user" | "jellyfin-admin";

export interface JellyfinGrant extends RoleAssignment {
  principalType: "user" | "group";
  principalId: string;
}

export interface JellyfinAccessResponse {
  scope: string;
  launchUrl: string;
  canManage: boolean;
  grants: JellyfinGrant[];
  candidates: {
    users: Array<{ username: string; name: string; email: string }>;
    groups: string[];
  };
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof data.error === "string" ? data.error : fallback;
}

export function useJellyfinAccess(enabled = true) {
  return useQuery<JellyfinAccessResponse>({
    queryKey: ["jellyfin", "access"],
    queryFn: async () => {
      const res = await fetch("/api/jellyfin/access", { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(await readError(res, "Failed to load Jellyfin access"));
      return await res.json() as JellyfinAccessResponse;
    },
    enabled,
    staleTime: 15_000,
  });
}

export function useGrantJellyfinAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { roleId: JellyfinRoleId; principalType: "user" | "group"; principal: string; expiresAt?: string }) => {
      const res = await fetch("/api/jellyfin/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to grant Jellyfin access"));
      return await res.json() as { ok: true };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jellyfin", "access"] }),
  });
}

export function useRevokeJellyfinAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { assignmentId: string; principalType: "user" | "group"; principal: string }) => {
      const res = await fetch("/api/jellyfin/access", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to revoke Jellyfin access"));
      return await res.json() as { ok: true };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jellyfin", "access"] }),
  });
}

export interface JellyfinSyncSummary {
  created: string[];
  roleChanged: string[];
  enabled: string[];
  disabled: string[];
  skippedNoEmail: string[];
  /** Provisioned accounts whose credential was never handed off — reveal it to them. */
  pendingHandoff: string[];
  /** Orphans re-adopted into management; their password is unknown until an admin resets it. */
  adopted: string[];
}

export function useSyncJellyfinUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/jellyfin/access", { method: "PUT" });
      if (!res.ok) throw new Error(await readError(res, "Failed to reconcile Jellyfin accounts"));
      return await res.json() as { ok: true } & JellyfinSyncSummary;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jellyfin", "access"] }),
  });
}

export interface JellyfinCredential {
  username: string;
  password: string;
  launchUrl: string;
}

/**
 * Reveal a provisioned Jellyfin password. Deliberately a mutation, not a query:
 * it must never be prefetched, cached, or refetched in the background — it is
 * fetched exactly when a human clicks "reveal", and it is audited server-side.
 */
export function useRevealJellyfinCredential() {
  return useMutation({
    mutationFn: async (username?: string) => {
      const query = username ? `?username=${encodeURIComponent(username)}` : "";
      const res = await fetch(`/api/jellyfin/credential${query}`);
      if (!res.ok) throw new Error(await readError(res, "Failed to reveal credential"));
      return await res.json() as JellyfinCredential;
    },
  });
}

/**
 * Reset a managed account's password and get the new one back. The admin-only
 * recovery for an adopted account (whose old password was lost) or a forgotten one.
 * A mutation for the same reason reveal is: it mutates server state and must be
 * driven by an explicit click, never prefetched or cached.
 */
export function useResetJellyfinCredential() {
  return useMutation({
    mutationFn: async (username: string) => {
      const res = await fetch("/api/jellyfin/credential", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to reset credential"));
      return await res.json() as JellyfinCredential;
    },
  });
}
