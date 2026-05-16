"use client";

import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface HelpTooltipProps {
  children: ReactNode;
  className?: string;
}

export function HelpTooltip({ children, className }: HelpTooltipProps) {
  return (
    <Tooltip content={<span className="max-w-[240px] whitespace-normal text-xs leading-relaxed">{children}</span>} position="top">
      <button
        type="button"
        tabIndex={0}
        aria-label="Help"
        className={cn("inline-flex h-4 w-4 cursor-help items-center justify-center text-[#555] hover:text-[#888] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#3b82f6]", className)}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}
