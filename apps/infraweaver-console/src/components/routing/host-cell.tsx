"use client";

import { ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

interface HostCellProps {
  host: string;
  /** When true, renders an "open in new tab" link to https://<host>. */
  openable?: boolean;
  /** Chip styling (border/background/text) so callers keep their existing palette. */
  chipClassName?: string;
}

/**
 * A hostname chip with an inline copy control and, for reachable hosts, an
 * "open" link. Shared by the Routes table and Ingress cards so connection
 * details are copyable and verifiable in one place.
 */
export function HostCell({ host, openable = false, chipClassName }: HostCellProps) {
  const href = `https://${host.replace(/\.+$/, "")}`;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
        chipClassName,
      )}
    >
      <span className="truncate font-mono">{host}</span>
      {openable ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Open https://${host} in a new tab`}
          title={`Open https://${host}`}
          className="inline-flex h-5 w-5 items-center justify-center rounded-md text-current opacity-70 transition hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-current"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ) : null}
      <CopyButton
        text={host}
        className="h-5 gap-0 border-0 bg-transparent px-1 text-current opacity-70 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
      />
    </span>
  );
}
