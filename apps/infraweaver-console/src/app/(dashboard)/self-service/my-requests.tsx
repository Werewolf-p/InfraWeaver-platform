"use client";

import { Inbox, X } from "lucide-react";
import { SettingsCard } from "@/components/ui";
import { EmptyState } from "@/components/ui/empty-state";
import { RelativeTime } from "@/components/ui/relative-time";
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

// Poll while the tab is open so an admin's approve/deny lands here without a manual
// reload — the requester's only feedback channel after they submit.
const POLL_MS = 20_000;

function LoadingRows() {
  return (
    <ul className="space-y-2" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <li key={index} className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-4 py-3">
          <div className="space-y-2">
            <div className="h-3 w-40 rounded shimmer-bg bg-gray-100 dark:bg-[#1e1e1e]" />
            <div className="h-3 w-56 rounded shimmer-bg bg-gray-100 dark:bg-[#1e1e1e]" />
            <div className="h-2.5 w-20 rounded shimmer-bg bg-gray-100 dark:bg-[#1e1e1e]" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MyRequests() {
  const query = useApiQuery<{ requests: SelfServiceRequest[] }>({
    queryKey: queryKeys.selfService.mine(),
    path: "/api/self-service/requests",
    staleTime: queryStaleTimes.short,
    refetchInterval: POLL_MS,
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
    <SettingsCard title="My requests" description="Your submitted self-service requests and their outcomes. Updates on its own as admins decide.">
      {query.isLoading ? (
        <LoadingRows />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No requests yet"
          description="Access, storage, and profile requests you submit will appear here with their live status."
          className="border-0 bg-transparent py-10 dark:bg-transparent"
        />
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
                <p className="text-xs text-slate-400">submitted <RelativeTime date={request.createdAt} /></p>
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
