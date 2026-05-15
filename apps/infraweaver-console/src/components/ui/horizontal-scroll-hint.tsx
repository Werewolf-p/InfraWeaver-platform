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
  hint = "Swipe for more",
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
      {showLeftFade ? <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[#111] via-[#111]/90 to-transparent" /> : null}
      {showRightFade ? <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#111] via-[#111]/90 to-transparent" /> : null}
      {showRightFade ? (
        <div className="pointer-events-none absolute bottom-0 right-2 rounded-full border border-[#2a2a2a] bg-[#111]/95 px-2 py-1 text-xs text-[#b3b3b3] shadow-sm sm:hidden">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
