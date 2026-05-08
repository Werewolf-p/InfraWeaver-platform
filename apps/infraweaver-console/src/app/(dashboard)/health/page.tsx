"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function HealthPage() {
  const { data: health, isLoading } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("Failed to fetch health");
      return res.json();
    },
    refetchInterval: 30000,
  });

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Platform Health</h2>
        <p className="text-sm text-slate-400">Gatus endpoint monitoring status</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(8)].map((_, i) => <div key={i} className="h-24 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {health?.endpoints?.map((endpoint: { name: string; results?: { success: boolean; duration: number; timestamp?: string }[] }) => (
            <motion.div
              key={endpoint.name}
              whileHover={{ scale: 1.01 }}
              className={cn(
                "bg-white/5 border rounded-xl p-4",
                endpoint.results?.[0]?.success ? "border-green-500/20" : "border-red-500/20"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-white">{endpoint.name}</span>
                {endpoint.results?.[0]?.success ? (
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400" />
                )}
              </div>
              <div className="flex gap-1 mt-2">
                {endpoint.results?.slice(0, 20).map((r, i) => (
                  <div
                    key={i}
                    className={cn("w-2 h-6 rounded-sm flex-shrink-0", r.success ? "bg-green-500/60" : "bg-red-500/60")}
                    title={r.timestamp}
                  />
                ))}
              </div>
              {endpoint.results?.[0] && (
                <div className="flex items-center justify-between mt-2">
                  <span className={cn("text-xs", endpoint.results[0].success ? "text-green-400" : "text-red-400")}>
                    {endpoint.results[0].success ? "UP" : "DOWN"}
                  </span>
                  <span className="text-xs text-slate-400">
                    {endpoint.results[0].duration}ms
                  </span>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
