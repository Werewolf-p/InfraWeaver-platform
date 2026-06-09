import { cn } from "@/lib/utils";
import { STATUS_COPY, STATUS_STYLE, type FeedbackStatus } from "@/components/feedback/feedback-status";

interface StatusPillProps {
  status: FeedbackStatus;
  /** @deprecated No longer used — a `dispatched` entry is already built + deployed. */
  previewUrl?: string;
  className?: string;
}

/**
 * Small status chip using plain-language wording (`STATUS_COPY`) instead of the
 * raw backend status, so a non-expert reviewer can read the board at a glance.
 *
 * A `dispatched` entry has already been built AND deployed to the live console
 * (the dispatch pipeline only advances to `dispatched` after the live rollout),
 * so it reads as "Ready to test" — never a perpetual "Building…" state. Live
 * build/deploy progress is shown separately by the run console while the entry
 * is still `approved`.
 */
export function StatusPill({ status, className }: StatusPillProps) {
  const { label, hint } = STATUS_COPY[status];

  return (
    <span
      title={hint}
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_STYLE[status], className)}
    >
      {label}
    </span>
  );
}

export default StatusPill;
