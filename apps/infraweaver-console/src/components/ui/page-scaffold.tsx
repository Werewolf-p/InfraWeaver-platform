import type { ElementType, ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
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
  isEmpty?: boolean;
  emptyState?: PageScaffoldEmptyState | ReactNode;
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
  isEmpty = false,
  emptyState,
  className,
  bodyClassName,
  children,
}: PageScaffoldProps) {
  const renderedEmptyState = !emptyState
    ? null
    : typeof emptyState === "object" && emptyState !== null && "title" in emptyState
      ? <EmptyState {...emptyState} />
      : emptyState;

  return (
    <section className={cn("space-y-6", className)}>
      <PageHeader
        icon={icon}
        title={title}
        subtitle={subtitle}
        description={description}
        actions={actions}
        badge={badge}
        breadcrumb={breadcrumb}
      />
      {loading
        ? (loadingFallback ?? <DefaultLoadingState />)
        : isEmpty && renderedEmptyState
          ? renderedEmptyState
          : <div className={bodyClassName}>{children}</div>}
    </section>
  );
}
