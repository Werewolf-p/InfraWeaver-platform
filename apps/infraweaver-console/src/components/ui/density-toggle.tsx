"use client";
import { AlignJustify, LayoutList, LayoutGrid } from "lucide-react";
import { useSettingsContext, type Density } from "@/contexts/settings-context";
import { cn } from "@/lib/utils";

const options: { value: Density; Icon: React.ElementType; label: string }[] = [
  { value: "compact", Icon: AlignJustify, label: "Compact" },
  { value: "comfortable", Icon: LayoutList, label: "Comfortable" },
  { value: "spacious", Icon: LayoutGrid, label: "Spacious" },
];

interface DensityToggleProps {
  className?: string;
}

export function DensityToggle({ className }: DensityToggleProps) {
  const { settings, updateSetting } = useSettingsContext();

  return (
    <div className={cn("flex items-center gap-1 p-1 rounded-lg bg-white/5 border border-white/10", className)}>
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          onClick={() => updateSetting("density" as keyof typeof settings, value)}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
            settings.density === value
              ? "bg-white/15 text-white shadow"
              : "text-white/50 hover:text-white/80"
          )}
          aria-label={label}
          title={label}
        >
          <Icon className="w-3.5 h-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
