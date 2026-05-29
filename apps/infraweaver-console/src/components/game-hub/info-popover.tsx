"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface InfoPopoverProps {
  /** Short title shown in bold at the top of the popover. */
  title?: ReactNode;
  /** The explanatory body content. Keep it concise and beginner-friendly. */
  children: ReactNode;
  /** Accessible label for the trigger button. */
  label?: string;
  /** Extra classes for the trigger button. */
  className?: string;
  /** Preferred horizontal alignment of the panel relative to the trigger. */
  align?: "start" | "center" | "end";
}

/**
 * A small, reusable click-to-open "?" popover for inline explanations in the
 * Game Hub wizard. Unlike a hover tooltip it stays open until dismissed, so it
 * can hold a sentence or two of friendly guidance without feeling cramped.
 * Renders the panel in a portal so it is never clipped by overflow containers.
 */
export function InfoPopover({ title, children, label = "More information", className, align = "center" }: InfoPopoverProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const reposition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const offsetX = align === "start" ? 0 : align === "end" ? rect.width : rect.width / 2;
    setCoords({ top: rect.bottom + 8, left: rect.left + offsetX });
  };

  useEffect(() => {
    if (!open) return undefined;
    reposition();
    const handlePointer = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return;
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align]);

  const translate = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={cn(
          "inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#3b82f6] dark:text-[#666] dark:hover:text-[#aaa]",
          open && "text-[#0078D4] dark:text-[#7cc4ff]",
          className,
        )}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              style={{ position: "fixed", top: coords.top, left: coords.left, transform: `translateX(${translate})` }}
              className="z-[1000] w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-600 shadow-xl dark:border-[#2a2a2a] dark:bg-[#161616] dark:text-[#bbb]"
            >
              {title ? <p className="mb-1.5 text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">{title}</p> : null}
              <div className="space-y-1.5">{children}</div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
