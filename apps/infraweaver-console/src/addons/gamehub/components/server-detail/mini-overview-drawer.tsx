"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { LayoutDashboard, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson } from "./utils";

type OverviewServer = {
  name: string;
  status: string;
  cpuUsage?: number | null;
  cpuLimit?: number | null;
  memoryUsage?: number | null;
  memoryLimit?: number | null;
};

function metricPercent(usage?: number | null, limit?: number | null) {
  if (!usage || !limit || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (usage / limit) * 100));
}

export function MiniOverviewDrawer({ currentServerName }: { currentServerName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: accessData, isError: accessDenied } = useQuery({
    queryKey: ["game-hub", "overview-access"],
    queryFn: () => fetchJson<{ servers: Record<string, boolean> }>("/api/game-hub/servers/iac-status"),
    retry: false,
  });
  const { data, isFetching } = useQuery({
    queryKey: ["game-hub", "servers", "mini-overview"],
    queryFn: () => fetchJson<{ servers: OverviewServer[] }>("/api/game-hub/servers"),
    enabled: open && Boolean(accessData),
    refetchInterval: open ? 30000 : false,
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (accessDenied || !accessData) return null;

  const servers = data?.servers ?? [];

  return (
    <>
      <button
        onClick={() => setOpen((value) => !value)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-4 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] shadow-[0_10px_30px_rgba(0,0,0,0.45)] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a]"
      >
        <LayoutDashboard className="h-4 w-4 text-[#4db3ff]" />
        Overview
      </button>
      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/45"
              aria-label="Close overview"
            />
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 24, opacity: 0 }}
              className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-4xl rounded-t-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 shadow-2xl"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Server overview</p>
                  <p className="text-xs text-gray-500 dark:text-[#888]">All accessible game servers</p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-2 text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
                {servers.length === 0 ? (
                  <p className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3 text-sm text-gray-500 dark:text-[#888]">
                    {isFetching ? "Loading servers…" : "No servers available."}
                  </p>
                ) : (
                  servers.map((server) => {
                    const cpu = metricPercent(server.cpuUsage, server.cpuLimit);
                    const memory = metricPercent(server.memoryUsage, server.memoryLimit);
                    return (
                      <button
                        key={server.name}
                        onClick={() => {
                          setOpen(false);
                          router.push(`/game-hub/${server.name}`);
                        }}
                        className={cn(
                          "w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-4 py-3 text-left transition-colors hover:bg-[#151515]",
                          server.name === currentServerName && "border-[#0078D4]/40 bg-[#0078D4]/10",
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "h-2.5 w-2.5 rounded-full",
                                  server.status === "running"
                                    ? "bg-emerald-400"
                                    : server.status === "starting"
                                      ? "bg-yellow-400"
                                      : "bg-[#555]",
                                )}
                              />
                              <span className="truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{server.name}</span>
                            </div>
                            <p className="mt-1 text-[11px] uppercase tracking-wide text-gray-400 dark:text-[#666]">{server.status}</p>
                          </div>
                          <div className="w-full max-w-[220px] space-y-2">
                            <div>
                              <div className="mb-1 flex items-center justify-between text-[10px] text-gray-500 dark:text-[#888]">
                                <span>CPU</span>
                                <span>{Math.round(cpu)}%</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
                                <div className="h-full rounded-full bg-sky-500" style={{ width: `${cpu}%` }} />
                              </div>
                            </div>
                            <div>
                              <div className="mb-1 flex items-center justify-between text-[10px] text-gray-500 dark:text-[#888]">
                                <span>Memory</span>
                                <span>{Math.round(memory)}%</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
                                <div className="h-full rounded-full bg-violet-500" style={{ width: `${memory}%` }} />
                              </div>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
