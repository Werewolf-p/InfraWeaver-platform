"use client";
import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { GripVertical, X } from "lucide-react";

interface WidgetCardProps {
  title: string;
  icon?: React.ElementType;
  children: React.ReactNode;
  onRemove?: () => void;
  draggable?: boolean;
  loading?: boolean;
  className?: string;
  actions?: React.ReactNode;
}

export function WidgetCard({ title, icon: Icon, children, onRemove, draggable, loading, className, actions }: WidgetCardProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className={cn("bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] rounded-lg flex flex-col overflow-hidden", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#2a2a2a] flex-shrink-0">
        {draggable && (
          <GripVertical className={cn("w-4 h-4 text-gray-400 dark:text-[#555] cursor-grab transition-opacity", hovered ? "opacity-100" : "opacity-0")} />
        )}
        {Icon && <Icon className="w-4 h-4 text-[#0078D4] flex-shrink-0" />}
        <span className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2] flex-1">{title}</span>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
        {onRemove && (
          <button
            onClick={onRemove}
            className={cn("p-1 rounded text-gray-400 dark:text-[#555] hover:text-gray-900 dark:hover:text-[#f2f2f2] hover:bg-gray-100 dark:hover:bg-[#2a2a2a] transition-all", hovered ? "opacity-100" : "opacity-0")}
            title="Remove widget"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 relative">
        {loading && <div className="absolute inset-0 bg-[#1a1a1a]/80 flex items-center justify-center z-10"><div className="w-5 h-5 border-2 border-[#0078D4] border-t-transparent rounded-full animate-spin" /></div>}
        {children}
      </div>
    </div>
  );
}
