"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Package, ShieldAlert, Shield } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

interface ImageEntry {
  image: string;
  registry: string;
  namespace: string;
  pods: number;
  isTrusted: boolean;
}

export default function ImageVulnerabilitiesPage() {
  const [filter, setFilter] = useState<"all" | "untrusted">("all");

  const { data, isLoading } = useQuery({
    queryKey: ["security", "images"],
    queryFn: async () => {
      const res = await fetch("/api/security/images");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ images: ImageEntry[] }>;
    },
  });

  const images = data?.images ?? [];
  const filtered = filter === "untrusted" ? images.filter(i => !i.isTrusted) : images;
  const untrustedCount = images.filter(i => !i.isTrusted).length;

  const byRegistry = filtered.reduce<Record<string, ImageEntry[]>>((acc, img) => {
    if (!acc[img.registry]) acc[img.registry] = [];
    acc[img.registry].push(img);
    return acc;
  }, {});

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Shield} title="Image Vulnerabilities" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Package className="w-5 h-5 text-slate-400" />Image Vulnerability Summary</h2>
        <p className="text-sm text-slate-400">Container images running in the cluster</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "Total Images", value: images.length, icon: Package, color: "text-white" },
          { label: "Untrusted", value: untrustedCount, icon: ShieldAlert, color: untrustedCount > 0 ? "text-red-400" : "text-green-400" },
          { label: "Trusted", value: images.length - untrustedCount, icon: Shield, color: "text-green-400" },
        ].map(s => (
          <div key={s.label} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 text-center">
            <p className="text-xs text-slate-400">{s.label}</p>
            <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setFilter("all")} className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${filter === "all" ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300" : "bg-white/5 border-white/10 text-slate-400"}`}>All</button>
        <button onClick={() => setFilter("untrusted")} className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${filter === "untrusted" ? "bg-red-500/20 border-red-500/30 text-red-300" : "bg-white/5 border-white/10 text-slate-400"}`}>Untrusted Only</button>
      </div>
      {Object.entries(byRegistry).map(([registry, imgs]) => (
        <div key={registry} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{registry}</span>
            <span className="text-xs text-slate-500">{imgs.length} image{imgs.length > 1 ? "s" : ""}</span>
          </div>
          <table className="w-full">
            <tbody>
              {imgs.map(img => (
                <tr key={img.image} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 text-xs text-slate-300 font-mono max-w-xs truncate">{img.image}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{img.namespace}</td>
                  <td className="px-4 py-3 text-xs text-slate-400">{img.pods} pod{img.pods > 1 ? "s" : ""}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${img.isTrusted ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                      {img.isTrusted ? "Trusted" : "Untrusted"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </motion.div>
  );
}
