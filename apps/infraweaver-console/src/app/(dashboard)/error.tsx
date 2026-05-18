"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";

interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  const requestId = error.digest ?? `err_${Date.now().toString(36)}`;

  useEffect(() => {
    if (error.name === "ChunkLoadError" || error.message?.includes("Loading chunk")) {
      window.location.reload();
      return;
    }

    fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        url: typeof window !== "undefined" ? window.location.href : "",
        requestId,
      }),
    }).catch(() => {});
  }, [error, requestId]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white dark:bg-[#0f0f0f] p-8 text-center">
      <AlertTriangle className="h-16 w-16 text-red-400" />
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Something went wrong</h1>
        <p className="mt-2 text-gray-500 dark:text-white/60">{error.message}</p>
        <p className="mt-1 font-mono text-xs text-gray-400 dark:text-white/40">Request ID: {requestId}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-xl bg-[#0078D4] px-6 py-3 font-medium text-white transition-colors hover:bg-[#1a86d9]"
        >
          <RefreshCw className="h-4 w-4" />
          Try again
        </button>
        <Link
          href="/home"
          className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 px-6 py-3 font-medium text-gray-900 dark:text-white transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
        >
          <Home className="h-4 w-4" />
          Go home
        </Link>
      </div>
    </div>
  );
}
