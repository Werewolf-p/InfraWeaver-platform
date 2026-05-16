"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ActionItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
}

interface ActionsMenuProps {
  actions: ActionItem[];
  label?: string;
  className?: string;
}

export function ActionsMenu({ actions, label = "Actions", className }: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div ref={menuRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] text-[#888] transition-colors hover:bg-[#1a1a1a] hover:text-[#f2f2f2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open ? (
        <div role="menu" className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-xl border border-[#2a2a2a] bg-[#111] py-1 shadow-2xl">
          {actions.map((action, index) => {
            if (action.href) {
              return (
                <a
                  key={`${action.label}-${index}`}
                  href={action.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-[#1a1a1a]",
                    action.variant === "destructive" ? "text-red-400 hover:bg-red-500/10" : "text-[#d4d4d4]",
                    action.disabled && "pointer-events-none cursor-not-allowed opacity-40",
                  )}
                >
                  {action.icon ? <span className="h-4 w-4">{action.icon}</span> : null}
                  {action.label}
                </a>
              );
            }

            return (
              <button
                key={`${action.label}-${index}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  action.onClick?.();
                }}
                disabled={action.disabled}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-[#1a1a1a]",
                  action.variant === "destructive" ? "text-red-400 hover:bg-red-500/10" : "text-[#d4d4d4]",
                  action.disabled && "cursor-not-allowed opacity-40",
                )}
              >
                {action.icon ? <span className="h-4 w-4">{action.icon}</span> : null}
                {action.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
