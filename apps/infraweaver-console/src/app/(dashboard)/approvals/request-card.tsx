"use client";

import { useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { useApiMutation } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { describeCeilingEffect, describeRequest, requestTypeLabel } from "@/lib/self-service/describe";
import type { SelfServiceRequest } from "@/lib/self-service/types";

interface RequestCardProps {
  request: SelfServiceRequest;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40";

/**
 * A single pending request with a CEILING PREVIEW — the exact effect approval
 * commits ("Grants role X at scope Y" / "Expands PVC to Z") — shown before the
 * admin decides. Approve applies under the approver's ceiling (server-enforced);
 * deny requires a note.
 */
export function RequestCard({ request }: RequestCardProps) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");

  const invalidate = [queryKeys.selfService.pending()];

  const approve = useApiMutation<{ request: SelfServiceRequest; recoveryLink?: string }, void>({
    path: `/api/self-service/requests/${request.id}/approve`,
    method: "POST",
    invalidateQueryKeys: invalidate,
    successMessage: "Request approved and applied",
    errorMessage: (error) => error.message || "Approval failed",
  });

  const deny = useApiMutation<{ request: SelfServiceRequest }, { note: string }>({
    path: `/api/self-service/requests/${request.id}/deny`,
    method: "POST",
    invalidateQueryKeys: invalidate,
    successMessage: "Request denied",
    errorMessage: "Failed to deny request",
    onSuccess: async () => setDenying(false),
  });

  const busy = approve.isPending || deny.isPending;

  return (
    <li className="space-y-3 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-slate-300 dark:border-white/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          {requestTypeLabel(request.type)}
        </span>
        <span className="text-sm text-slate-700 dark:text-slate-300">{request.requestedBy}</span>
        <span className="text-xs text-slate-400">{new Date(request.createdAt).toLocaleString()}</span>
      </div>

      <p className="text-sm text-slate-800 dark:text-slate-200">{describeRequest(request)}</p>
      {request.reason ? <p className="text-xs text-slate-500">Reason: {request.reason}</p> : null}

      <div className="flex items-start gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-500" />
        <p className="text-xs text-indigo-700 dark:text-indigo-300">On approve: {describeCeilingEffect(request)}</p>
      </div>

      {denying ? (
        <div className="space-y-2">
          <textarea className={`${INPUT_CLASS} min-h-[56px]`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason for denial (required)" maxLength={500} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!note.trim() || busy}
              onClick={() => deny.mutate({ note: note.trim() })}
              className="touch-target inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              <X className="h-4 w-4" /> Confirm deny
            </button>
            <button type="button" onClick={() => setDenying(false)} className="touch-target rounded-lg border border-slate-300 dark:border-white/10 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => approve.mutate()}
            className="touch-target inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDenying(true)}
            className="touch-target inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-white/10 px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-50"
          >
            <X className="h-4 w-4" /> Deny
          </button>
        </div>
      )}
    </li>
  );
}
