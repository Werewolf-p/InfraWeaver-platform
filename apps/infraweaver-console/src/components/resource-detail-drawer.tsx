"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

export interface ResourceDrawerField {
  label: string;
  value: string | null | undefined;
  copyable?: boolean;
  mono?: boolean;
}

export interface ResourceDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  kind?: string;
  namespace?: string;
  status?: string;
  createdAt?: string | null;
  fullPageHref?: string;
  fields?: ResourceDrawerField[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  children?: ReactNode;
}

function FieldRow({ label, value, copyable, mono }: ResourceDrawerField) {
  if (value == null || value === "") return null;

  return (
    <div className="flex items-start gap-3 border-b border-gray-200 dark:border-[#1e1e1e] py-2 last:border-b-0">
      <dt className="w-28 shrink-0 pt-0.5 text-xs text-gray-400 dark:text-[#666]">{label}</dt>
      <dd className={cn("flex flex-1 items-center gap-2 break-all text-sm text-gray-700 dark:text-[#d4d4d4]", mono && "font-mono text-xs")}>
        <span className="flex-1">{value}</span>
        {copyable ? <CopyButton text={value} /> : null}
      </dd>
    </div>
  );
}

export function ResourceDetailDrawer({
  open,
  onClose,
  title,
  kind,
  namespace,
  status,
  createdAt,
  fullPageHref,
  fields = [],
  labels = {},
  annotations = {},
  children,
}: ResourceDetailDrawerProps) {
  const labelEntries = Object.entries(labels);
  const annotationEntries = Object.entries(annotations);

  return (
    <>
      {open ? <button type="button" aria-label="Close details panel" className="fixed inset-0 z-40 bg-black/40" onClick={onClose} /> : null}
      <div
        role="dialog"
        aria-label={`Details for ${title}`}
        aria-modal="true"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] shadow-2xl transition-transform duration-300",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-[#2a2a2a] px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-gray-400 dark:text-[#555]">{kind}</p>
            <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{title}</h2>
            {namespace ? <p className="text-xs text-gray-400 dark:text-[#666]">{namespace}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status ? <StatusBadge status={status} label={status} size="sm" /> : null}
            {fullPageHref ? (
              <Link
                href={fullPageHref}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-[#666] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
                title="Open full page"
                aria-label="Open full page"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close details panel"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 dark:text-[#666] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {createdAt ? (
            <div className="flex items-start gap-3 border-b border-gray-200 dark:border-[#1e1e1e] py-2">
              <dt className="w-28 shrink-0 pt-0.5 text-xs text-gray-400 dark:text-[#666]">Created</dt>
              <dd className="flex-1 text-sm text-gray-700 dark:text-[#d4d4d4]">
                <RelativeTime date={createdAt} />
              </dd>
            </div>
          ) : null}
          <dl>
            {fields.map((field) => (
              <FieldRow key={field.label} {...field} />
            ))}
          </dl>

          {labelEntries.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-[#555]">Labels</h3>
              <div className="flex flex-wrap gap-1.5">
                {labelEntries.map(([key, value]) => (
                  <span key={key} className="rounded-md border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-0.5 text-xs font-mono text-gray-500 dark:text-[#888]">
                    {key}={value}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {annotationEntries.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-[#555]">Annotations</h3>
              <div className="space-y-1">
                {annotationEntries.slice(0, 10).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2 text-xs">
                    <span className="max-w-[160px] shrink-0 truncate font-mono text-gray-400 dark:text-[#666]">{key}</span>
                    <span className="flex-1 break-all font-mono text-gray-500 dark:text-[#888]">{value}</span>
                  </div>
                ))}
                {annotationEntries.length > 10 ? <p className="text-xs text-gray-400 dark:text-[#555]">+{annotationEntries.length - 10} more</p> : null}
              </div>
            </div>
          ) : null}

          {children}
        </div>
      </div>
    </>
  );
}
