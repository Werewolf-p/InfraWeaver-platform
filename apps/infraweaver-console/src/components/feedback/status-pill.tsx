import { cn } from "@/lib/utils";
import { STATUS_COPY, STATUS_STYLE, type FeedbackStatus } from "@/components/feedback/feedback-status";

interface StatusPillProps {
  status: FeedbackStatus;
  /** Live preview URL, present once the staging build for a `dispatched` entry is up. */
  previewUrl?: string;
  className?: string;
}

/**
 * Small status chip using plain-language wording (`STATUS_COPY`) instead of the
 * raw backend status, so a non-expert reviewer can read the board at a glance.
 *
 * A `dispatched` entry only becomes testable once its staging build lands and a
 * `previewUrl` exists; until then the pill says "Building on staging…" so it
 * never contradicts the "Updating staging deployment…" detail line below.
 */
export function StatusPill({ status, previewUrl, className }: StatusPillProps) {
  const isBuilding = status === "dispatched" && !previewUrl;
  const label = isBuilding ? "Building on staging…" : STATUS_COPY[status].label;
  const hint = isBuilding ? "Staging build in progress — testable once it lands." : STATUS_COPY[status].hint;

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
