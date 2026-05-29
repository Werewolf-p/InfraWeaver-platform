import type { ElementType, ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { DataError } from "@/components/ui/data-error";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshingIndicator } from "@/components/ui/refreshing-indicator";
import { cn } from "@/lib/utils";

interface PageScaffoldEmptyState {
  icon?: ElementType;
  title: string;
  description?: string;
  action?: ReactNode | { label: string; onClick: () => void };
}

interface PageScaffoldProps {
  icon?: ElementType;
  title: string;
  subtitle?: string;
  description?: string;
  actions?: ReactNode;
  badge?: string;
  breadcrumb?: Array<{ label: string; href?: string }>;
  loading?: boolean;
  loadingFallback?: ReactNode;
  /**
   * True while a background refetch is in flight (react-query isFetching) but
   * previous data is still on screen. Surfaces a subtle "Refreshing" pill in
   * the header instead of dropping back to a skeleton.
   */
  isFetching?: boolean;
  isEmpty?: boolean;
  emptyState?: PageScaffoldEmptyState | ReactNode;
  isError?: boolean;
  errorMessage?: string;
  errorDetail?: string;
  onRetry?: () => void;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

function DefaultLoadingState() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="h-24 animate-pulse rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5"
          style={{ opacity: 1 - index * 0.12 }}
        />
      ))}
    </div>
  );
}

export function PageScaffold({
  icon,
  title,
  subtitle,
  description,
  actions,
  badge,
  breadcrumb,
  loading = false,
  loadingFallback,
  isFetching = false,
  isEmpty = false,
  emptyState,
  isError = false,
  errorMessage,
  errorDetail,
  onRetry,
  className,
  bodyClassName,
  children,
}: PageScaffoldProps) {
  const renderedEmptyState = emptyState == null
    ? null
    : (typeof emptyState === "object" && "title" in (emptyState as object))
      ? <EmptyState {...(emptyState as PageScaffoldEmptyState)} />
      : emptyState as React.ReactNode;

  // Show the refreshing pill only when previous data is still on screen (i.e. not
  // the very first load and not an error/empty placeholder).
  const showRefreshing = isFetching && !loading && !isError;
  const headerActions = (actions || showRefreshing) ? (
    <>
      {actions}
      <RefreshingIndicator active={showRefreshing} />
    </>
  ) : undefined;

  return (
    <section className={cn("space-y-6", className)}>
      <PageHeader
        icon={icon}
        title={title}
        subtitle={subtitle}
        description={description}
        actions={headerActions}
        badge={badge}
        breadcrumb={breadcrumb}
      />
      {loading
        ? (
          <div aria-busy="true" aria-live="polite">
            {loadingFallback ?? <DefaultLoadingState />}
          </div>
        )
        : isError
          ? <DataError message={errorMessage} detail={errorDetail} onRetry={onRetry} />
          : isEmpty && renderedEmptyState
            ? renderedEmptyState
            : <div className={bodyClassName}>{children}</div>
      }
    </section>
  );
}
