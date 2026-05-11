"use client";
import React from "react";
import { cn } from "@/lib/utils";

interface Tab {
  label: string;
  value: string;
  icon?: React.ElementType;
  badge?: string | number;
}

interface SectionTabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (value: string) => void;
  className?: string;
}

export function SectionTabs({ tabs, activeTab, onTabChange, className }: SectionTabsProps) {
  return (
    <div className={cn("border-b border-[#2a2a2a] flex overflow-x-auto scrollbar-none flex-shrink-0", className)}>
      {tabs.map(tab => {
        const Icon = tab.icon;
        const active = activeTab === tab.value;
        return (
          <button
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-4 py-2.5 text-sm whitespace-nowrap transition-colors relative flex-shrink-0 min-h-[44px]",
              active
                ? "text-[#0078D4] border-b-2 border-[#0078D4] font-medium"
                : "text-[#9e9e9e] hover:text-[#f2f2f2]"
            )}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {tab.label}
            {tab.badge !== undefined && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-mono", active ? "bg-[#0078D4]/20 text-[#0078D4]" : "bg-[#2a2a2a] text-[#666]")}>
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
