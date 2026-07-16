"use client";
import { useState, useRef, useEffect, useId, useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useMotionSafe } from "@/lib/spring";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  position = "top",
  delay = 300,
  className,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable id so aria-describedby always matches the tooltip element.
  const tooltipId = useId();
  const motionSafe = useMotionSafe();

  const show = useCallback(() => {
    showTimer.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    setVisible(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") hide();
    },
    [hide]
  );

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
    },
    []
  );

  const positionClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      // Keyboard users: show on focus-in, hide on blur-out, dismiss with Escape.
      onFocus={show}
      onBlur={hide}
      onKeyDown={handleKeyDown}
    >
      {/*
        Clone the single child element to inject aria-describedby so screen
        readers announce the tooltip content when the trigger is focused.
        We only inject when the tooltip is actually rendered; the attribute is
        harmless when the element is absent because assistive technology will
        simply find no matching id.
      */}
      {visible
        ? (() => {
            const child = children as React.ReactElement<Record<string, unknown>>;
            return typeof child === "object" && child !== null
              ? { ...child, props: { ...child.props, "aria-describedby": tooltipId } }
              : children;
          })()
        : children}
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={motionSafe.transition({ duration: 0.12, ease: "easeOut" })}
            className={cn(
              "absolute z-tooltip pointer-events-none",
              positionClasses[position]
            )}
          >
            <div
              id={tooltipId}
              role="tooltip"
              className={cn(
                "px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap",
                "bg-slate-100 dark:bg-slate-900/95 backdrop-blur-sm border border-gray-200 dark:border-white/10",
                "shadow-xl shadow-black/40",
                className
              )}
            >
              {content}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
