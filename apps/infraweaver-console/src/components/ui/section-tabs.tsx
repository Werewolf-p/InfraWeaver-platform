"use client";
import React, { useRef } from "react";
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
  const touchStartX = useRef(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) < 50) return;
    const currentIndex = tabs.findIndex(t => t.value === activeTab);
    if (delta < 0 && currentIndex < tabs.length - 1) {
      onTabChange(tabs[currentIndex + 1].value);
    } else if (delta > 0 && currentIndex > 0) {
      onTabChange(tabs[currentIndex - 1].value);
    }
  };

  return (
    <div
      className={cn("border-b border-gray-200 dark:border-[#2a2a2a] flex overflow-x-auto scrollbar-none flex-shrink-0", className)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
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
                : "text-gray-500 dark:text-[#9e9e9e] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
            )}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {tab.label}
            {tab.badge !== undefined && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-mono", active ? "bg-[#0078D4]/20 text-[#0078D4]" : "bg-gray-100 dark:bg-[#2a2a2a] text-gray-400 dark:text-[#666]")}>
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
