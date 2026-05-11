"use client";
import React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: React.ElementType;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16 px-4 text-center", className)}>
      {Icon && <Icon className="w-12 h-12 text-[#555] mb-4" />}
      <h3 className="text-base font-semibold text-[#f2f2f2] mb-1">{title}</h3>
      {description && <p className="text-sm text-[#9e9e9e] max-w-sm">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-4 py-2 bg-[#0078D4] hover:bg-[#1a86d9] text-white text-sm rounded transition-colors min-h-[36px]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
