"use client";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

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

  const show = () => {
    showTimer.current = setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    setVisible(false);
  };

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
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className={cn(
              "absolute z-50 pointer-events-none",
              positionClasses[position]
            )}
          >
            <div
              className={cn(
                "px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-200 whitespace-nowrap",
                "bg-slate-900/95 backdrop-blur-sm border border-white/10",
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
