"use client";

/**
 * `useSignedOp(site)` — the ONE wrapper for invoking a connector SIGNED method
 * through the existing `/api/wordpress/sites/[site]/iwsl/ops` path. Every migrated
 * connector mutation and every new domain signed op goes through this so success
 * / error toasts + query invalidation are uniform.
 *
 * SIGNED-CHANNEL INVARIANT: each `action` maps to a signed method registered in
 * the plugin's command handler (verified server-side). This hook NEVER introduces
 * a new public/unauthenticated endpoint — it only calls the one dual-signed ops
 * route the connector view already uses.
 */

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/notify";
import { siteEntitlementsKey } from "./use-site-entitlements";

/** POST a signed connector op to the site's `/iwsl/ops` route; throws on failure. */
export async function postSignedOp<T>(
  site: string,
  action: string,
  extra?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/wordpress/sites/${encodeURIComponent(site)}/iwsl/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Operation failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface SignedOpOptions {
  /** Toast this message on success (default: no toast). */
  readonly successMessage?: string;
  /** Extra query keys to invalidate beyond the standard manage + link keys. */
  readonly invalidate?: readonly (readonly unknown[])[];
}

export interface SignedOpRunner {
  run<T = unknown>(action: string, extra?: Record<string, unknown>, opts?: SignedOpOptions): Promise<T>;
  readonly pending: boolean;
  readonly error: string | null;
  clearError(): void;
}

/** The query keys every signed op invalidates so the whole cockpit reconciles. */
function standardKeys(site: string): readonly (readonly unknown[])[] {
  return [
    ["wordpress-manage-overview", site],
    ["wordpress-manage-panel", site],
    siteEntitlementsKey(site),
  ];
}

export function useSignedOp(site: string): SignedOpRunner {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ action, extra }: { action: string; extra?: Record<string, unknown> }) =>
      postSignedOp<unknown>(site, action, extra),
  });

  const run = useCallback(
    async <T,>(action: string, extra?: Record<string, unknown>, opts?: SignedOpOptions): Promise<T> => {
      setError(null);
      try {
        const result = (await mutation.mutateAsync({ action, extra })) as T;
        const keys = [...standardKeys(site), ...(opts?.invalidate ?? [])];
        await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })));
        if (opts?.successMessage) toast.success(opts.successMessage);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Operation failed";
        setError(message);
        toast.error(message);
        throw err;
      }
    },
    [mutation, queryClient, site],
  );

  return { run, pending: mutation.isPending, error, clearError: () => setError(null) };
}
