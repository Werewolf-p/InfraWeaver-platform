"use client";
import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

export function AnimatedNumber({
  value,
  duration = 1000,
  decimals = 0,
  prefix = "",
  suffix = "",
  className = "",
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const startTime = useRef<number | null>(null);
  const startValue = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isInView) return;

    startValue.current = displayValue;
    startTime.current = null;

    const animate = (timestamp: number) => {
      if (!startTime.current) startTime.current = timestamp;
      const elapsed = timestamp - startTime.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = startValue.current + (value - startValue.current) * eased;
      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration, isInView]);

  return (
    <span ref={ref} className={className}>
      {prefix}{displayValue.toFixed(decimals)}{suffix}
    </span>
  );
}
