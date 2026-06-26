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
        aria-label="More information"
        className={cn(
          // Visible footprint stays 16px; padding expands the pointer/touch hit
          // area to the 44×44px minimum without shifting surrounding layout.
          "inline-flex h-4 w-4 cursor-help items-center justify-center p-[14px]",
          "text-gray-400 dark:text-[#555] hover:text-gray-700 dark:hover:text-[#888]",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-[#3b82f6]",
          className
        )}
      >
        {/* aria-hidden keeps the icon out of the accessibility tree; the
            button's aria-label is the sole accessible name. */}
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
