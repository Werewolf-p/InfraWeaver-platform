"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/lib/notify";

/** A grant staged in the cart, not written until "Apply". */
export interface StagedGrant {
  key: number;
  principalType: "user" | "group";
  principal: string;
  principalLabel: string;
  roleId: string;
  scope: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
}

/** An existing assignment staged for removal, keyed in the map by its id. */
export interface StagedRevoke {
  principalType: "user" | "group";
  principal: string;
}

/** Minimal handle the cart needs to stage a revoke of an existing assignment. */
export interface RevokableAssignment {
  id: string;
  principalType: "user" | "group";
  principal: string;
}

/** Outcome of applying one principal's batch. */
export interface ApplyResult {
  principal: string;
  ok: boolean;
  error?: string;
}

interface GrantDraft {
  roleId: string;
  scope: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
}

interface Batch {
  principalType: "user" | "group";
  principal: string;
  grants: GrantDraft[];
  revokes: string[];
}

export interface RbacCart {
  pendingGrants: StagedGrant[];
  pendingRevokes: Map<string, StagedRevoke>;
  results: ApplyResult[];
  dirtyCount: number;
  isApplying: boolean;
  stageGrant: (grant: Omit<StagedGrant, "key">) => void;
  unstageGrant: (key: number) => void;
  toggleRevoke: (assignment: RevokableAssignment) => void;
  isRevoked: (id: string) => boolean;
  discardAll: () => void;
  apply: () => void;
}

const APPLY_ENDPOINT = "/api/rbac/assignments/apply";

function batchKey(principalType: "user" | "group", principal: string): string {
  return `${principalType}:${principal}`;
}

/**
 * Builds one batch per principal from the staged grants + revokes. Every write
 * therefore goes out as a single `PUT /api/rbac/assignments/apply` per person —
 * the canonical path that enforces the privilege ceiling, persists users.yaml,
 * audits, and sends the RBAC-change email. A role swap on one person is one
 * commit and one email.
 */
function buildBatches(pendingGrants: StagedGrant[], pendingRevokes: Map<string, StagedRevoke>): Batch[] {
  const batches = new Map<string, Batch>();
  const ensure = (principalType: "user" | "group", principal: string): Batch => {
    const key = batchKey(principalType, principal);
    const existing = batches.get(key);
    if (existing) return existing;
    const created: Batch = { principalType, principal, grants: [], revokes: [] };
    batches.set(key, created);
    return created;
  };

  for (const grant of pendingGrants) {
    const batch = ensure(grant.principalType, grant.principal);
    batch.grants = [
      ...batch.grants,
      { roleId: grant.roleId, scope: grant.scope, expiresAt: grant.expiresAt, effect: grant.effect },
    ];
  }
  for (const [id, meta] of pendingRevokes) {
    const batch = ensure(meta.principalType, meta.principal);
    batch.revokes = [...batch.revokes, id];
  }
  return [...batches.values()];
}

async function applyBatch(batch: Batch): Promise<ApplyResult> {
  const body =
    batch.principalType === "group"
      ? { principalType: "group" as const, group: batch.principal, grants: batch.grants, revokes: batch.revokes }
      : { principalType: "user" as const, username: batch.principal, grants: batch.grants, revokes: batch.revokes };
  try {
    const res = await fetch(APPLY_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload: unknown = await res.json().catch(() => ({}));
      const error =
        typeof payload === "object" && payload !== null && "error" in payload && typeof (payload as { error: unknown }).error === "string"
          ? (payload as { error: string }).error
          : "Failed to apply";
      return { principal: batch.principal, ok: false, error };
    }
    return { principal: batch.principal, ok: true };
  } catch (error: unknown) {
    return { principal: batch.principal, ok: false, error: error instanceof Error ? error.message : "Network error" };
  }
}

/**
 * Client-side staging cart for RBAC edits. Grants and revokes accumulate
 * unwritten; Apply groups them by principal and issues one canonical PUT each,
 * capturing a per-principal result. Succeeded principals drop out of staging so
 * a retry only re-sends the failures.
 */
export function useRbacCart(onApplied?: () => void): RbacCart {
  const [pendingGrants, setPendingGrants] = useState<StagedGrant[]>([]);
  const [pendingRevokes, setPendingRevokes] = useState<Map<string, StagedRevoke>>(new Map());
  const [grantSeq, setGrantSeq] = useState(0);
  const [results, setResults] = useState<ApplyResult[]>([]);

  const stageGrant = useCallback((grant: Omit<StagedGrant, "key">) => {
    setPendingGrants((prev) => [...prev, { ...grant, key: grantSeq }]);
    setGrantSeq((n) => n + 1);
  }, [grantSeq]);

  const unstageGrant = useCallback((key: number) => {
    setPendingGrants((prev) => prev.filter((grant) => grant.key !== key));
  }, []);

  const toggleRevoke = useCallback((assignment: RevokableAssignment) => {
    setPendingRevokes((prev) => {
      const next = new Map(prev);
      if (next.has(assignment.id)) next.delete(assignment.id);
      else next.set(assignment.id, { principalType: assignment.principalType, principal: assignment.principal });
      return next;
    });
  }, []);

  const isRevoked = useCallback((id: string) => pendingRevokes.has(id), [pendingRevokes]);

  const discardAll = useCallback(() => {
    setPendingGrants([]);
    setPendingRevokes(new Map());
    setResults([]);
  }, []);

  const mutation = useMutation<ApplyResult[], Error, void>({
    mutationFn: async () => {
      const batches = buildBatches(pendingGrants, pendingRevokes);
      return Promise.all(batches.map(applyBatch));
    },
    onSuccess: (batchResults) => {
      setResults(batchResults);
      const failed = new Set(batchResults.filter((result) => !result.ok).map((result) => result.principal));
      // Drop everything belonging to a principal that succeeded; keep failures staged.
      setPendingGrants((prev) => prev.filter((grant) => failed.has(grant.principal)));
      setPendingRevokes((prev) => {
        const next = new Map<string, StagedRevoke>();
        for (const [id, meta] of prev) if (failed.has(meta.principal)) next.set(id, meta);
        return next;
      });
      if (failed.size === 0) {
        toast.success("Changes applied");
        onApplied?.();
      } else {
        toast.error(`${failed.size} principal${failed.size === 1 ? "" : "s"} failed — see details below`);
        onApplied?.();
      }
    },
    onError: (error) => toast.error(error.message),
  });

  return useMemo<RbacCart>(
    () => ({
      pendingGrants,
      pendingRevokes,
      results,
      dirtyCount: pendingGrants.length + pendingRevokes.size,
      isApplying: mutation.isPending,
      stageGrant,
      unstageGrant,
      toggleRevoke,
      isRevoked,
      discardAll,
      apply: () => mutation.mutate(),
    }),
    [pendingGrants, pendingRevokes, results, stageGrant, unstageGrant, toggleRevoke, isRevoked, discardAll, mutation],
  );
}
