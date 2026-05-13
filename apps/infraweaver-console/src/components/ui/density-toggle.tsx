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
    <div className={cn("flex items-center gap-1 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-1", className)}>
      {options.map(({ value, Icon, label }) => (
        <button
          key={value}
          onClick={() => updateSetting("density" as keyof typeof settings, value)}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]",
            settings.density === value
              ? "bg-[#1a1a1a] text-[#f2f2f2] shadow"
              : "text-[#888] hover:bg-[#1a1a1a] hover:text-[#f2f2f2]",
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
