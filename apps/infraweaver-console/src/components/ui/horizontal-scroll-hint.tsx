"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface HorizontalScrollHintProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  hint?: string;
}

export function HorizontalScrollHint({
  children,
  className,
  contentClassName,
  hint = "Scroll for more",
}: HorizontalScrollHintProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateFades = () => {
      setShowLeftFade(element.scrollLeft > 4);
      setShowRightFade(element.scrollLeft + element.clientWidth < element.scrollWidth - 4);
    };

    updateFades();
    element.addEventListener("scroll", updateFades, { passive: true });
    window.addEventListener("resize", updateFades);

    return () => {
      element.removeEventListener("scroll", updateFades);
      window.removeEventListener("resize", updateFades);
    };
  }, []);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={containerRef}
        className={cn("overflow-x-auto scrollbar-none [-webkit-overflow-scrolling:touch]", contentClassName)}
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {children}
      </div>
      {showLeftFade ? <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white via-white/95 to-transparent dark:from-[#111] dark:via-[#111]/90" /> : null}
      {showRightFade ? <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-white via-white/95 to-transparent dark:from-[#111] dark:via-[#111]/90" /> : null}
      {showRightFade ? (
        <div className="pointer-events-none absolute bottom-2 right-2 rounded-full border border-slate-200 bg-white/95 px-2 py-1 text-[11px] text-slate-500 shadow-sm dark:border-[#2a2a2a] dark:bg-[#111]/95 dark:text-[#b3b3b3]">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
