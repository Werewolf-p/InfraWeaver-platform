"use client";

import type { ReactNode } from "react";
import { DataError } from "./data-error";
import { EmptyState } from "./empty-state";
import { SkeletonCard } from "./skeleton";
import { selectAsyncState } from "./async-boundary-state";
import { classifyClientError } from "@/lib/error-taxonomy";

interface AsyncBoundaryProps {
  isLoading: boolean;
  isError: boolean;
  isEmpty?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Loading placeholder. Defaults to three skeleton cards. */
  skeleton?: ReactNode;
  /** Empty-state node. Defaults to a generic EmptyState. */
  emptyState?: ReactNode;
  emptyTitle?: string;
  children: ReactNode;
}

/**
 * Header-agnostic loading/error/empty wrapper for any query result region.
 * Complements PageScaffold (which owns the page header) for inner panels and
 * the many pages that hand-roll these three states inconsistently. Error copy
 * comes from the shared client error taxonomy.
 */
export function AsyncBoundary({ isLoading, isError, isEmpty, error, onRetry, skeleton, emptyState, emptyTitle = "Nothing here yet", children }: AsyncBoundaryProps) {
  const state = selectAsyncState({ isLoading, isError, isEmpty });

  if (state === "error") {
    return <DataError message={classifyClientError(error).title} onRetry={onRetry} />;
  }
  if (state === "loading") {
    return <>{skeleton ?? <div className="space-y-3">{[0, 1, 2].map((i) => <SkeletonCard key={i} />)}</div>}</>;
  }
  if (state === "empty") {
    return <>{emptyState ?? <EmptyState title={emptyTitle} />}</>;
  }
  return <>{children}</>;
}
