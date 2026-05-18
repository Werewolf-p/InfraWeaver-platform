"use client";
import { cn } from "@/lib/utils";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: { track: "h-4 w-8", thumb: "h-3 w-3", translate: "translate-x-4" },
  md: { track: "h-5 w-10", thumb: "h-4 w-4", translate: "translate-x-5" },
  lg: { track: "h-6 w-11", thumb: "h-5 w-5", translate: "translate-x-5" },
};

export function ToggleSwitch({ checked, onChange, label, description, disabled, size = "md", className }: ToggleSwitchProps) {
  const s = sizes[size];

  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      {(label || description) && (
        <div className="min-w-0 flex-1">
          {label ? (
            <p className={cn("block truncate text-sm font-medium", disabled ? "text-gray-400 dark:text-[#666]" : "text-gray-900 dark:text-[#f2f2f2]")}>{label}</p>
          ) : null}
          {description ? (
            <p className={cn("mt-0.5 truncate text-xs", disabled ? "text-gray-400 dark:text-[#666]" : "text-gray-500 dark:text-[#888]")}>{description}</p>
          ) : null}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111] disabled:cursor-not-allowed disabled:opacity-50",
          s.track,
          checked ? "bg-[#3b82f6]" : "bg-gray-100 dark:bg-[#2a2a2a]",
        )}
      >
        <span
          className={cn(
            "inline-block transform rounded-full bg-white shadow-sm transition-transform duration-200",
            s.thumb,
            checked ? s.translate : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}
