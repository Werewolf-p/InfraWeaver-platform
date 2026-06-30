"use client";
import React, { useCallback, memo } from "react";
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

interface TabButtonProps {
  tab: Tab;
  active: boolean;
  onTabChange: (value: string) => void;
}

const TabButton = memo(function TabButton({ tab, active, onTabChange }: TabButtonProps) {
  const Icon = tab.icon;
  const handleClick = useCallback(() => {
    onTabChange(tab.value);
  }, [onTabChange, tab.value]);

  return (
    <button
      onClick={handleClick}
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
});

export function SectionTabs({ tabs, activeTab, onTabChange, className }: SectionTabsProps) {
  // The bar is horizontally scrollable; swiping/dragging sideways should scroll to
  // reveal more tabs, never change the selection. (A swipe-to-switch gesture here
  // is the same horizontal gesture as scrolling, so it mis-fired tab changes.)
  return (
    <div
      className={cn("border-b border-gray-200 dark:border-[#2a2a2a] flex overflow-x-auto scrollbar-none flex-shrink-0", className)}
    >
      {tabs.map(tab => (
        <TabButton
          key={tab.value}
          tab={tab}
          active={activeTab === tab.value}
          onTabChange={onTabChange}
        />
      ))}
    </div>
  );
}
