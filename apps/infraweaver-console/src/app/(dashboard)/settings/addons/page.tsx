"use client";
import { useState } from "react";
import { motion } from "framer-motion";
import { Puzzle, Gamepad2, Network, ExternalLink } from "lucide-react";
import { useAddons } from "@/hooks/use-addons";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { StatusBadge } from "@/components/ui/status-badge";
import { SkeletonCard } from "@/components/ui/skeleton";
import Link from "next/link";
import { toast } from "@/lib/notify";

const ICON_MAP: Record<string, React.ElementType> = {
  Gamepad2, Network, Puzzle,
};

const CATEGORY_COLORS: Record<string, string> = {
  gaming: "bg-violet-500/15 text-violet-300 border border-violet-500/20",
  networking: "bg-blue-500/15 text-blue-300 border border-blue-500/20",
  infrastructure: "bg-amber-500/15 text-amber-300 border border-amber-500/20",
  monitoring: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/20",
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
        <PageHeader title="Addons" subtitle="Enable and disable platform features" icon={Puzzle} breadcrumb={[{ label: "Home", href: "/" }, { label: "Settings", href: "/settings" }, { label: "Addons" }]} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, index) => <SkeletonCard key={index} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Addons"
        subtitle="Enable and disable platform features and integrations"
        icon={Puzzle}
        breadcrumb={[{ label: "Home", href: "/" }, { label: "Settings", href: "/settings" }, { label: "Addons" }]}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {addons.map((addon, index) => {
          const Icon = ICON_MAP[addon.icon] ?? Puzzle;
          const isUpdating = updatingId === addon.id;
          const actionHref = addon.enabled
            ? addon.requiresSetup
              ? addon.setupPath
              : addon.navItems?.[0]?.href
            : undefined;

          return (
            <motion.div
              key={addon.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                "flex flex-col gap-4 rounded-xl border bg-white dark:bg-[#111] p-5 transition-colors",
                addon.enabled ? "border-[#3b82f6]/30" : "border-gray-200 dark:border-[#2a2a2a]",
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full", addon.enabled ? "bg-[#3b82f6]/15 text-[#60a5fa]" : "bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888]")}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-medium text-gray-900 dark:text-[#f2f2f2]">{addon.name}</h3>
                    <StatusBadge status={isUpdating ? "processing" : addon.enabled ? "healthy" : "offline"} label={isUpdating ? "Updating" : addon.enabled ? "Enabled" : "Disabled"} size="sm" showIcon />
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-gray-700 dark:text-[#d4d4d4]">{addon.description}</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", CATEGORY_COLORS[addon.category] ?? "border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-gray-500 dark:text-[#888]")}>
                  {addon.category}
                </span>
                {addon.requiresSetup ? <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">Setup required</span> : null}
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 text-sm">
                <div>
                  <p className="text-xs uppercase tracking-wider text-gray-500 dark:text-[#888]">Status</p>
                  <p className="mt-1 font-medium text-gray-900 dark:text-[#f2f2f2]">{addon.enabled ? "Available" : "Disabled"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-gray-500 dark:text-[#888]">Route</p>
                  <p className="mt-1 truncate font-mono text-xs text-gray-700 dark:text-[#d4d4d4]">{addon.navItems?.[0]?.href ?? addon.setupPath ?? "—"}</p>
                </div>
              </div>

              <div className="mt-auto space-y-3 border-t border-gray-200 dark:border-[#2a2a2a] pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">Toggle addon</p>
                    <p className="truncate text-xs text-gray-500 dark:text-[#888]">AWS-style quick action with the most common state change inline.</p>
                  </div>
                  <ToggleSwitch checked={addon.enabled} onChange={() => void handleToggle(addon)} disabled={isUpdating} className="shrink-0" />
                </div>
                {actionHref ? (
                  <Link href={actionHref} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-3 text-sm text-[#60a5fa] transition-colors hover:bg-gray-100 dark:hover:bg-[#1a1a1a] hover:text-[#93c5fd]">
                    {addon.requiresSetup ? "Open setup" : "Open addon"}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                ) : null}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
