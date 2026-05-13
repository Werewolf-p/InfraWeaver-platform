"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { Puzzle, Gamepad2, Network, ExternalLink, CheckCircle2, XCircle } from "lucide-react";
import { useAddons } from "@/hooks/use-addons";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import Link from "next/link";
import { toast } from "sonner";

const ICON_MAP: Record<string, React.ElementType> = {
  Gamepad2, Network, Puzzle,
};

const CATEGORY_COLORS: Record<string, string> = {
  gaming: "bg-purple-500/20 text-purple-300 border border-purple-500/30",
  networking: "bg-blue-500/20 text-blue-300 border border-blue-500/30",
  infrastructure: "bg-orange-500/20 text-orange-300 border border-orange-500/30",
  monitoring: "bg-green-500/20 text-green-300 border border-green-500/30",
};

export default function AddonsPage() {
  const { addons, enableAddon, disableAddon, mounted } = useAddons();
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const handleToggle = async (addon: (typeof addons)[number]) => {
    setUpdatingId(addon.id);
    try {
      if (addon.enabled) {
        await disableAddon(addon.id);
        toast.success(`${addon.name} disabled`);
      } else {
        await enableAddon(addon.id);
        toast.success(`${addon.name} enabled${addon.requiresSetup ? " — setup required" : ""}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to update ${addon.name}`);
    } finally {
      setUpdatingId(null);
    }
  };

  if (!mounted) {
    return (
      <div className="space-y-4">
        <PageHeader title="Addons" subtitle="Enable and disable platform features" icon={Puzzle} />
        {[...Array(2)].map((_, i) => (
          <div key={i} className="h-32 rounded-xl bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Addons" subtitle="Enable and disable platform features and integrations" icon={Puzzle} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {addons.map((addon, i) => {
          const Icon = ICON_MAP[addon.icon] ?? Puzzle;
          return (
            <motion.div
              key={addon.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className={cn(
                "rounded-xl border p-5 flex flex-col gap-4 transition-colors",
                addon.enabled
                  ? "bg-[rgba(0,120,212,0.05)] border-[rgba(0,120,212,0.2)]"
                  : "bg-[#1a1a1a] border-[#2a2a2a]"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
                    addon.enabled ? "bg-[rgba(0,120,212,0.15)]" : "bg-[#252525]"
                  )}>
                    <Icon className={cn("w-5 h-5", addon.enabled ? "text-[#0078D4]" : "text-[#666]")} />
                  </div>
                  <div>
                    <h3 className="font-medium text-sm text-[#f2f2f2]">{addon.name}</h3>
                    <span className={cn("text-[10px] font-medium rounded-full px-2 py-0.5 capitalize", CATEGORY_COLORS[addon.category])}>
                      {addon.category}
                    </span>
                  </div>
                </div>
                {/* Toggle */}
                <button
                  onClick={() => void handleToggle(addon)}
                  disabled={updatingId === addon.id}
                  className={cn(
                    "relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:cursor-wait disabled:opacity-60",
                    addon.enabled ? "bg-[#0078D4]" : "bg-[#333]"
                  )}
                  aria-label={addon.enabled ? `Disable ${addon.name}` : `Enable ${addon.name}`}
                >
                  <span className={cn(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    addon.enabled ? "translate-x-6" : "translate-x-1"
                  )} />
                </button>
              </div>

              <p className="text-xs text-[#9e9e9e] leading-relaxed">{addon.description}</p>

              <div className="flex items-center gap-2 mt-auto">
                <div className={cn(
                  "flex items-center gap-1.5 text-xs",
                  addon.enabled ? "text-green-400" : "text-[#666]"
                )}>
                  {addon.enabled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                  {addon.enabled ? "Enabled" : "Disabled"}
                </div>
                {addon.enabled && addon.requiresSetup && addon.setupPath && (
                  <Link href={addon.setupPath} className="ml-auto text-xs text-[#0078D4] hover:underline flex items-center gap-1">
                    Setup <ExternalLink className="w-3 h-3" />
                  </Link>
                )}
                {addon.enabled && !addon.requiresSetup && addon.navItems?.[0] && (
                  <Link href={addon.navItems[0].href} className="ml-auto text-xs text-[#0078D4] hover:underline flex items-center gap-1">
                    Open <ExternalLink className="w-3 h-3" />
                  </Link>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
