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
    <div className={cn("flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#2a2a2a] bg-[#111] px-4 py-16 text-center", className)}>
      {Icon ? (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#2a2a2a] bg-[#0d0d0d] text-[#888]">
          <Icon className="h-7 w-7" />
        </div>
      ) : null}
      <h3 className="text-base font-medium text-[#f2f2f2]">{title}</h3>
      {description ? <p className="mt-2 max-w-sm text-sm leading-relaxed text-[#888]">{description}</p> : null}
      {action ? (
        <button
          onClick={action.onClick}
          className="mt-5 inline-flex h-9 cursor-pointer items-center rounded-lg bg-[#3b82f6] px-4 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6] focus-visible:ring-offset-1 focus-visible:ring-offset-[#111]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
