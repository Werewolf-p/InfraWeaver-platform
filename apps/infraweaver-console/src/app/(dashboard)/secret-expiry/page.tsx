"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Lock} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface Secret {
  namespace: string;
  name: string;
  expiresAt: string;
  daysLeft: number;
  expired: boolean;
}

function dayColor(daysLeft: number, expired: boolean) {
  if (expired) return "text-red-400 bg-red-500/10 border-red-500/20";
  if (daysLeft <= 14) return "text-orange-400 bg-orange-500/10 border-orange-500/20";
  if (daysLeft <= 30) return "text-yellow-400 bg-yellow-500/10 border-yellow-500/20";
  return "text-green-400 bg-green-500/10 border-green-500/20";
}

export default function SecretExpiryPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["security", "secrets"],
    queryFn: async () => {
      const res = await fetch("/api/security/secrets");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ secrets: Secret[] }>;
    },
  });

  const secrets = [...(data?.secrets ?? [])].sort((a, b) => a.daysLeft - b.daysLeft);
  const expired = secrets.filter(s => s.expired).length;
  const expiringSoon = secrets.filter(s => !s.expired && s.daysLeft <= 30).length;

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Lock} title="Secret Expiry" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-slate-400" />Secret Expiry Tracker</h2>
        <p className="text-sm text-slate-400">TLS certificate and secret expiration monitoring</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total TLS Secrets", value: secrets.length, color: "text-white" },
          { label: "Expired", value: expired, color: expired > 0 ? "text-red-400" : "text-green-400" },
          { label: "Expiring ≤30 days", value: expiringSoon, color: expiringSoon > 0 ? "text-yellow-400" : "text-green-400" },
        ].map(s => (
          <div key={s.label} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 text-center">
            <p className="text-xs text-slate-400">{s.label}</p>
            <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Secret</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Expires</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Days Left</th>
          </tr></thead>
          <tbody>
            {secrets.map(s => (
              <tr key={`${s.namespace}/${s.name}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium">{s.name}</td>
                <td className="px-4 py-3 text-sm text-slate-400">{s.namespace}</td>
                <td className="px-4 py-3 text-sm text-slate-300">{new Date(s.expiresAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-center">
                  <span className={cn("text-xs px-2 py-0.5 rounded-full border font-semibold", dayColor(s.daysLeft, s.expired))}>
                    {s.expired ? "EXPIRED" : `${s.daysLeft}d`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {secrets.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No TLS secrets found</div>}
      </div>
    </motion.div>
  );
}
