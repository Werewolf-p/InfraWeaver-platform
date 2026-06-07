import { cn } from "@/lib/utils";
import { STATUS_COPY, STATUS_STYLE, type FeedbackStatus } from "@/components/feedback/feedback-status";

interface StatusPillProps {
  status: FeedbackStatus;
  className?: string;
}

/**
 * Small status chip using plain-language wording (`STATUS_COPY`) instead of the
 * raw backend status, so a non-expert reviewer can read the board at a glance.
 */
export function StatusPill({ status, className }: StatusPillProps) {
  return (
    <span
      title={STATUS_COPY[status].hint}
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_STYLE[status], className)}
    >
      {STATUS_COPY[status].label}
    </span>
  );
}

export default StatusPill;
