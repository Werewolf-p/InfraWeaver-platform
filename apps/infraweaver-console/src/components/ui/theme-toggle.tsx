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
    const current = options.find((option) => option.value === theme) ?? options[2];
    const Icon = current.Icon;
    const next = options[(options.indexOf(current) + 1) % options.length];
    return (
      <button
        onClick={() => setTheme(next.value)}
        className={cn("flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]", className)}
        aria-label={`Switch to ${next.label} mode`}
        title={`Switch to ${next.label} mode`}
      >
        <Icon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className={cn("flex items-center gap-1 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-1", className)}>
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]",
            theme === value
              ? "bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-[#f2f2f2] shadow"
              : "text-gray-500 dark:text-[#888] hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-gray-900 dark:hover:text-[#f2f2f2]",
          )}
          aria-label={label}
          title={label}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
