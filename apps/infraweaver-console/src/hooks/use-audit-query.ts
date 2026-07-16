"use client";

import { queryRefetchIntervals, queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import type { AuditPage, AuditRecord } from "@/lib/audit/types";
import { useApiQuery } from "./use-api-query";

export type { AuditPage, AuditRecord } from "@/lib/audit/types";

export interface AuditQueryParams {
  user?: string;
  action?: string;
  category?: string;
  severity?: string;
  result?: string;
  resource?: string;
  target?: string;
  from?: string;
  to?: string;
  q?: string;
  cursor?: number;
  limit?: number;
}

/** Drop empty/undefined params so the query key and URL stay stable and minimal. */
function cleanParams(params: AuditQueryParams): Record<string, string | number> {
  const cleaned: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === "all") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function buildAuditQueryString(params: AuditQueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(cleanParams(params))) {
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function useAuditQuery(params: AuditQueryParams) {
  const cleaned = cleanParams(params);
  return useApiQuery<AuditPage>({
    queryKey: queryKeys.audit.query(cleaned),
    path: `/api/audit${buildAuditQueryString(params)}`,
    staleTime: queryStaleTimes.short,
    refetchInterval: queryRefetchIntervals.standard,
    placeholderData: (previous) => previous,
  });
}

export type { AuditRecord as AuditQueryRecord };
