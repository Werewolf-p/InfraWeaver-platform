"use client";
import { useEffect, useRef, useState } from "react";

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  className?: string;
  suffix?: string;
  prefix?: string;
}

export function AnimatedCounter({
  value,
  duration = 800,
  className,
  suffix = "",
  prefix = "",
}: AnimatedCounterProps) {
  const [display, setDisplay] = useState(0);
  const frameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const startValRef = useRef<number>(0);
  const ref = useRef<HTMLSpanElement>(null);
  const hasStarted = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStarted.current) {
          hasStarted.current = true;
          startValRef.current = display;
          startTimeRef.current = performance.now();

          const tick = (now: number) => {
            const elapsed = now - startTimeRef.current;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
            const current = Math.round(startValRef.current + (value - startValRef.current) * eased);
            setDisplay(current);
            if (progress < 1) {
              frameRef.current = requestAnimationFrame(tick);
            }
          };

          frameRef.current = requestAnimationFrame(tick);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
    };
  }, [value, duration, display]);

  // Also animate on value change after initial
  useEffect(() => {
    if (!hasStarted.current) return;
    cancelAnimationFrame(frameRef.current);
    const start = display;
    startTimeRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (value - start) * eased);
      setDisplay(current);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span ref={ref} className={className}>
      {prefix}{display}{suffix}
    </span>
  );
}
