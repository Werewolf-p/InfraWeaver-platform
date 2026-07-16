"use client";

import { X } from "lucide-react";
import { SettingsCard } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { queryStaleTimes } from "@/lib/query-defaults";
import { describeRequest, requestTypeLabel } from "@/lib/self-service/describe";
import { isPendingStatus, type SelfServiceRequest, type SelfServiceStatus } from "@/lib/self-service/types";

const STATUS_STYLES: Record<SelfServiceStatus, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/30",
  "auto-applied": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  approved: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
  denied: "bg-red-500/10 text-red-600 dark:text-red-300 border-red-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-300 border-red-500/30",
  cancelled: "bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/30",
};

const STATUS_LABELS: Record<SelfServiceStatus, string> = {
  pending: "Pending",
  "auto-applied": "Applied",
  approved: "Approved",
  denied: "Denied",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function MyRequests() {
  const query = useApiQuery<{ requests: SelfServiceRequest[] }>({
    queryKey: queryKeys.selfService.mine(),
    path: "/api/self-service/requests",
    staleTime: queryStaleTimes.short,
  });
  const requests = query.data?.requests ?? [];

  const cancel = useApiMutation<{ request: SelfServiceRequest }, { id: string }>({
    path: (variables) => `/api/self-service/requests/${variables.id}`,
    method: "DELETE",
    invalidateQueryKeys: [queryKeys.selfService.mine()],
    successMessage: "Request cancelled",
    errorMessage: "Failed to cancel request",
  });

  return (
    <SettingsCard title="My requests" description="Your submitted self-service requests and their outcomes.">
      {query.isLoading ? (
        <p className="py-4 text-sm text-slate-500">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="py-4 text-sm text-slate-500">You have not submitted any requests yet.</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((request) => (
            <li key={request.id} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{requestTypeLabel(request.type)}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLES[request.status]}`}>{STATUS_LABELS[request.status]}</span>
                </div>
                <p className="truncate text-sm text-slate-800 dark:text-slate-200">{describeRequest(request)}</p>
                {request.appliedSummary ? <p className="truncate text-xs text-slate-500">{request.appliedSummary}</p> : null}
                {request.decisionNote ? <p className="truncate text-xs text-slate-500">Note: {request.decisionNote}</p> : null}
                <p className="text-xs text-slate-400">{new Date(request.createdAt).toLocaleString()}</p>
              </div>
              {isPendingStatus(request.status) ? (
                <button
                  type="button"
                  onClick={() => cancel.mutate({ id: request.id })}
                  disabled={cancel.isPending}
                  className="touch-target inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-white/10 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 transition-colors hover:bg-slate-100 dark:hover:bg-white/10 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
