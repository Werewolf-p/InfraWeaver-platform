import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_COPY, STATUS_STYLE, STATUS_STEPS } from "@/components/feedback/feedback-status";

/**
 * Compact horizontal stepper of the happy-path journey
 * (Awaiting review → Claude is fixing → Ready to test → Staged → Live) so a
 * non-expert can map any entry's status chip onto the overall flow.
 */
export function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 dark:border-[#262626] dark:bg-[#161616]">
      {STATUS_STEPS.map((status, index) => (
        <div key={status} className="flex items-center gap-1">
          <span
            className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_STYLE[status])}
            title={STATUS_COPY[status].hint}
          >
            {STATUS_COPY[status].label}
          </span>
          {index < STATUS_STEPS.length - 1 && (
            <ChevronRight className="h-3 w-3 text-gray-300 dark:text-[#444]" aria-hidden />
          )}
        </div>
      ))}
    </div>
  );
}

export default StatusLegend;
