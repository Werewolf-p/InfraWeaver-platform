"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Visual size of the control. Defaults to "md". */
  selectSize?: "sm" | "md";
}

const sizeClasses: Record<NonNullable<SelectProps["selectSize"]>, string> = {
  sm: "h-9 pl-3 pr-9 text-sm",
  md: "h-11 pl-3.5 pr-10 text-sm",
};

/**
 * Themed native <select>. Honors the app's light/dark design tokens for
 * background, text, border, and focus — no hardcoded colors. The native
 * option list follows the theme via the `color-scheme` set on <html> in
 * globals.css. Use this instead of a raw <select> so dropdowns stay
 * consistent across both themes.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, selectSize = "md", children, ...props },
  ref,
) {
  return (
    <div className="relative flex w-full">
      <select
        ref={ref}
        className={cn(
          "w-full appearance-none rounded-xl border bg-[rgb(var(--color-surface-base))] text-[rgb(var(--color-text-primary))]",
          "border-[rgb(var(--color-border))] outline-none transition-colors",
          "hover:border-[rgb(var(--color-border-strong))]",
          "focus:border-[rgb(var(--az-primary))]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          sizeClasses[selectSize],
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--color-text-tertiary))]"
      />
    </div>
  );
});
