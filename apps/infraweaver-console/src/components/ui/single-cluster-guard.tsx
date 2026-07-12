"use client";
import { type ReactNode } from "react";
import { Globe } from "lucide-react";
import { useCluster } from "@/contexts/cluster-context";

interface SingleClusterGuardProps {
  children: ReactNode;
  /** Override the empty-state headline. */
  title?: string;
  /** Override the empty-state hint. */
  hint?: string;
}

/**
 * Gates a page on a specific cluster being selected. When the "All clusters"
 * view is active it renders the shared "select a specific cluster" empty
 * state instead of children — the copy repeated on the secrets, config-maps,
 * cluster, and logs pages.
 */
export function SingleClusterGuard({
  children,
  title = "Select a specific cluster to view this page",
  hint = "Use the cluster selector in the top bar",
}: SingleClusterGuardProps) {
  const { activeId } = useCluster();

  if (activeId === "all") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Globe className="mb-4 h-10 w-10 text-gray-700 dark:text-[#333]" />
        <p className="text-sm font-medium text-gray-400 dark:text-[#666]">{title}</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-[#444]">{hint}</p>
      </div>
    );
  }

  return <>{children}</>;
}
