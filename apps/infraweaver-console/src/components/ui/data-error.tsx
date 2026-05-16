"use client";

import { AlertCircle, RefreshCw, Stethoscope } from "lucide-react";
import { useState } from "react";
import Link from "next/link";

interface DataErrorProps {
  message?: string;
  detail?: string;
  onRetry?: () => void;
  className?: string;
}

export function DataError({ message = "Service unavailable", detail, onRetry, className }: DataErrorProps) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className={`flex flex-col items-center justify-center gap-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center ${className ?? ""}`}>
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
        <AlertCircle className="h-6 w-6 text-red-400" />
      </div>
      <div>
        <p className="text-sm font-semibold text-red-300">{message}</p>
        {detail && (
          <button onClick={() => setShowDetail(v => !v)} className="mt-1 text-xs text-slate-500 transition-colors hover:text-slate-400">
            {showDetail ? "Hide detail" : "Show detail"}
          </button>
        )}
        {detail && showDetail && (
          <p className="mt-2 rounded-lg bg-black/30 p-3 text-left font-mono text-[10px] text-slate-400">{detail}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex min-h-[44px] items-center gap-2 rounded-xl border border-[#333] bg-[#1a1a1a] px-4 py-2 text-sm text-[#9e9e9e] transition-colors hover:bg-[#2a2a2a] hover:text-white touch-manipulation"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        )}
        <Link
          href="/self-test"
          className="flex min-h-[44px] items-center gap-2 rounded-xl border border-[#333] bg-[#1a1a1a] px-4 py-2 text-sm text-[#9e9e9e] transition-colors hover:bg-[#2a2a2a] hover:text-white touch-manipulation"
        >
          <Stethoscope className="h-4 w-4" />
          Run Diagnostics
        </Link>
      </div>
    </div>
  );
}
