"use client";
import { BarChart2 } from "lucide-react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/page-header";

interface Quota {
  namespace: string;
  name: string;
  hard: Record<string, string>;
  used: Record<string, string>;
}

function parseValue(val: string): number {
  if (!val) return 0;
  if (val.endsWith("m")) return parseFloat(val) / 1000;
  if (val.endsWith("Ki")) return parseFloat(val) / (1024 * 1024);
  if (val.endsWith("Mi")) return parseFloat(val) / 1024;
  if (val.endsWith("Gi")) return parseFloat(val);
  return parseFloat(val);
}

function pct(used: string, hard: string): number {
  const u = parseValue(used);
  const h = parseValue(hard);
  if (h === 0) return 0;
  return Math.min(100, Math.round((u / h) * 100));
}

function barColor(p: number) {
  if (p >= 90) return "bg-red-500";
  if (p >= 70) return "bg-yellow-500";
  return "bg-indigo-500";
}

export default function QuotaPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["cluster", "quota"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/quota");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ quotas: Quota[] }>;
    },
  });
  const quotas = data?.quotas ?? [];

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-32 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={BarChart2} title="Resource Quotas" />
      <div>
        <h2 className="text-xl font-bold text-white">Resource Quotas</h2>
        <p className="text-sm text-slate-400">Namespace resource usage vs limits</p>
      </div>
      {quotas.map(q => (
        <div key={`${q.namespace}/${q.name}`} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <span className="text-white font-semibold">{q.namespace}</span>
              <span className="text-slate-500 text-xs ml-2">{q.name}</span>
            </div>
          </div>
          <div className="space-y-3">
            {Object.keys(q.hard).map(key => {
              const p = pct(q.used[key] ?? "0", q.hard[key]);
              return (
                <div key={key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-400">{key}</span>
                    <span className="text-slate-300">{q.used[key] ?? "0"} / {q.hard[key]}</span>
                  </div>
                  <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${barColor(p)}`} style={{ width: `${p}%` }} />
                  </div>
                  <div className="text-right text-[10px] text-slate-500 mt-0.5">{p}%</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {quotas.length === 0 && (
        <div className="text-center py-16 text-slate-500 text-sm">No resource quotas found</div>
      )}
    </motion.div>
  );
}
