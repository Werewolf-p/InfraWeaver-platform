"use client";
import { cn } from "@/lib/utils";
import React from "react";

interface CommandBarAction {
  id?: string;
  label: string;
  icon?: React.ElementType;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}

interface CommandBarProps {
  primary?: React.ReactNode;
  actions?: CommandBarAction[];
  search?: React.ReactNode;
  filter?: React.ReactNode;
  className?: string;
}

export function CommandBar({ primary, actions, search, filter, className }: CommandBarProps) {
  return (
    <div className={cn("bg-white dark:bg-[#1a1a1a] border-b border-gray-200 dark:border-[#2a2a2a] px-4 py-2 flex items-center gap-2 flex-shrink-0 flex-wrap", className)}>
      {primary && (
        <>
          <div className="flex items-center gap-2">{primary}</div>
          {(actions || search || filter) && <div className="w-px h-5 bg-[#333] mx-1 flex-shrink-0" />}
        </>
      )}
      {actions && actions.map((action) => {
        const Icon = action.icon;
        const variantCls = action.variant === "danger"
          ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
          : action.variant === "primary"
            ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20"
            : "border-gray-200 dark:border-[#333] text-gray-900 dark:text-[#f2f2f2] hover:bg-gray-100 dark:hover:bg-[#2a2a2a]";
        return (
          <button
            key={action.id ?? `${action.label}:${action.variant ?? "secondary"}`}
            onClick={action.onClick}
            disabled={action.disabled}
            className={cn(
              "inline-flex items-center gap-1.5 bg-transparent border text-sm px-3 py-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[32px]",
              variantCls
            )}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {action.label}
          </button>
        );
      })}
      {filter && <div className="flex items-center gap-2">{filter}</div>}
      {search && <div className="flex-1 flex justify-end">{search}</div>}
    </div>
  );
}
