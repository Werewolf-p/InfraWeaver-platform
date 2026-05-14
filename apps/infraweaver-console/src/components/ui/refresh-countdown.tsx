"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function RefreshCountdown({
  intervalSeconds,
  resetKey,
  className,
}: {
  intervalSeconds: number;
  resetKey?: string | number;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(intervalSeconds);

  useEffect(() => {
    setRemaining(intervalSeconds);
  }, [intervalSeconds, resetKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining((prev) => (prev <= 1 ? intervalSeconds : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [intervalSeconds]);

  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400", className)}>
      <RefreshCw className="h-3 w-3" />
      Refresh in {remaining}s
    </div>
  );
}
