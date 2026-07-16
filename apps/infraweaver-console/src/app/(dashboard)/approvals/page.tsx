"use client";

import { useMemo } from "react";
import { Inbox } from "lucide-react";
import { PageScaffold } from "@/components/ui";
import { useApiQuery } from "@/hooks";
import { queryKeys } from "@/lib/query-keys";
import { queryStaleTimes } from "@/lib/query-defaults";
import { requestTypeLabel } from "@/lib/self-service/describe";
import type { SelfServiceRequest, SelfServiceRequestType } from "@/lib/self-service/types";
import { RequestCard } from "./request-card";

/**
 * Admin approval queue — RBAC-gated in navigation-rbac (users:write / rbac:admin
 * / cluster:admin). Lists every pending self-service request grouped by type,
 * each card previewing the exact effect before the admin approves or denies.
 */
export default function ApprovalsPage() {
  const query = useApiQuery<{ requests: SelfServiceRequest[] }>({
    queryKey: queryKeys.selfService.pending(),
    path: "/api/self-service/requests?all=1",
    staleTime: queryStaleTimes.short,
  });
  const grouped = useMemo(() => {
    const map = new Map<SelfServiceRequestType, SelfServiceRequest[]>();
    for (const request of query.data?.requests ?? []) {
      const list = map.get(request.type) ?? [];
      list.push(request);
      map.set(request.type, list);
    }
    return [...map.entries()];
  }, [query.data?.requests]);
  const requestCount = query.data?.requests?.length ?? 0;

  return (
    <PageScaffold
      icon={Inbox}
      title="Approvals"
      description="Review and decide self-service requests. Approving applies the change under your own RBAC ceiling."
      badge={requestCount > 0 ? String(requestCount) : undefined}
      loading={query.isLoading && !query.data}
      isEmpty={!query.isLoading && requestCount === 0}
      emptyState={{ icon: Inbox, title: "No pending requests", description: "Self-service requests that need an admin decision will appear here." }}
      className="max-w-3xl"
    >
      <div className="space-y-6">
        {grouped.map(([type, list]) => (
          <section key={type} className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              {requestTypeLabel(type)} <span className="text-slate-400">({list.length})</span>
            </h2>
            <ul className="space-y-3">
              {list.map((request) => (
                <RequestCard key={request.id} request={request} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PageScaffold>
  );
}
