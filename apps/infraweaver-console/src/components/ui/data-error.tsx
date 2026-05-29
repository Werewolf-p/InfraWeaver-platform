"use client";

import { AlertCircle, RefreshCw, Stethoscope } from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { springs } from "@/lib/spring";

interface DataErrorProps {
  message?: string;
  detail?: string;
  onRetry?: () => void;
  className?: string;
}

export function DataError({ message = "We couldn't load this data", detail, onRetry, className }: DataErrorProps) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={springs.gentle}
      role="alert"
      className={`flex flex-col items-center justify-center gap-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center ${className ?? ""}`}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
        <motion.div
          animate={{ x: [0, -4, 4, -2, 2, 0] }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <AlertCircle className="h-6 w-6 text-red-400" aria-hidden="true" />
        </motion.div>
      </div>
      <div>
        <p className="text-sm font-semibold text-red-300">{message}</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">This is usually temporary — try again in a moment.</p>
        {detail && (
          <button onClick={() => setShowDetail(v => !v)} className="mt-1 text-xs text-slate-500 transition-colors hover:text-slate-700 dark:hover:text-slate-400">
            {showDetail ? "Hide details" : "Show details"}
          </button>
        )}
        {detail && showDetail && (
          <p className="mt-2 rounded-lg bg-black/30 p-3 text-left font-mono text-[10px] text-slate-500 dark:text-slate-400">{detail}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <motion.button
            onClick={onRetry}
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            transition={springs.snappy}
            className="flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 dark:border-[#333] bg-white dark:bg-[#1a1a1a] px-4 py-2 text-sm text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] hover:text-gray-900 dark:hover:text-white touch-manipulation"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Retry
          </motion.button>
        )}
        <Link
          href="/self-test"
          className="flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 dark:border-[#333] bg-white dark:bg-[#1a1a1a] px-4 py-2 text-sm text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] hover:text-gray-900 dark:hover:text-white touch-manipulation"
        >
          <Stethoscope className="h-4 w-4" aria-hidden="true" />
          Run Diagnostics
        </Link>
      </div>
    </motion.div>
  );
}
