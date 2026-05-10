"use client";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const options = [
  { value: "light" as const, Icon: Sun, label: "Light" },
  { value: "dark" as const, Icon: Moon, label: "Dark" },
  { value: "system" as const, Icon: Monitor, label: "System" },
];

interface ThemeToggleProps {
  className?: string;
  compact?: boolean;
}

export function ThemeToggle({ className, compact = false }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  if (compact) {
    const current = options.find(o => o.value === theme) ?? options[2];
    const Icon = current.Icon;
    const next = options[(options.indexOf(current) + 1) % options.length];
    return (
      <button
        onClick={() => setTheme(next.value)}
        className={cn("flex items-center justify-center w-9 h-9 rounded-lg hover:bg-white/10 transition-colors", className)}
        aria-label={`Switch to ${next.label} mode`}
        title={`Switch to ${next.label} mode`}
      >
        <Icon className="w-4 h-4 text-white/70" />
      </button>
    );
  }

  return (
    <div className={cn("flex items-center gap-1 p-1 rounded-lg bg-white/5 border border-white/10", className)}>
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
            theme === value
              ? "bg-white/15 text-white shadow"
              : "text-white/50 hover:text-white/80"
          )}
          aria-label={label}
        >
          <Icon className="w-3.5 h-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
