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
        <div className="flex-1 min-w-0">
          {label && <p className={cn("text-sm font-medium", disabled ? "text-slate-500" : "text-white")}>{label}</p>}
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
          s.track,
          checked ? "bg-indigo-500" : "bg-slate-700",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "inline-block transform rounded-full bg-white shadow-sm transition-transform duration-200",
            s.thumb,
            checked ? s.translate : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
