"use client";

import { useState } from "react";
import { ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog, RelativeTime } from "@/components/ui";
import { useApiMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import type { PublicMirrorStatus } from "@/lib/secrets/lifecycle-types";

export interface PublicMirrorCardProps {
  status: PublicMirrorStatus;
  canRemediate: boolean;
}

function conclusionClass(conclusion: string | null): string {
  if (conclusion === "success") return "text-green-400 bg-green-500/10 border-green-500/20";
  if (conclusion === "failure") return "text-red-400 bg-red-500/10 border-red-500/20";
  return "text-yellow-400 bg-yellow-500/10 border-yellow-500/20";
}

export function PublicMirrorCard({ status, canRemediate }: PublicMirrorCardProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const trigger = useApiMutation<{ ok: boolean }, void>({
    path: "/api/secrets/lifecycle/trigger-public-sync",
    successMessage: "sync-to-public dispatched",
    invalidateQueryKeys: [queryKeys.secrets.lifecycle()],
    onSuccess: () => setConfirmOpen(false),
  });

  const label = status.conclusion ?? status.status ?? "unknown";

  return (
    <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Public Mirror (sync-to-public)</h3>
        </div>
        {status.available ? (
          <span className={cn("inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold", conclusionClass(status.conclusion))}>
            {label}
          </span>
        ) : null}
      </div>

      {!status.available ? (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          Mirror status unavailable{status.error ? ` — ${status.error}` : ""}.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
            <dt className="text-slate-500">Workflow</dt>
            <dd className="text-right">{status.workflowName ?? "—"}</dd>
            <dt className="text-slate-500">Last run</dt>
            <dd className="text-right"><RelativeTime date={status.updatedAt} /></dd>
          </dl>

          <div className="flex flex-wrap items-center gap-3">
            {canRemediate ? (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={trigger.isPending}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-50"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", trigger.isPending && "animate-spin")} aria-hidden="true" />
                {trigger.isPending ? "Dispatching…" : "Trigger sync"}
              </button>
            ) : null}
            {status.htmlUrl ? (
              <a
                href={status.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400"
              >
                View run <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onConfirm={() => trigger.mutate()}
        onCancel={() => setConfirmOpen(false)}
        title="Trigger public mirror sync?"
        description="Dispatches the sync-to-public GitHub Actions workflow (mirrors the private repo to the public OSS template). No secret data is touched."
        confirmText={trigger.isPending ? "Dispatching…" : "Trigger sync"}
      />
    </div>
  );
}
