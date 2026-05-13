"use client";
import { useState, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, RefreshCw, Bell, X, UserPlus, Globe, Layers,
  Server, FileText, Shield,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useRBAC } from "@/hooks/useRBAC";

interface FABAction {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  color?: string;
}

export function FloatingActionButton() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useRBAC();

  const actions = useMemo<FABAction[] | null>(() => {
    // Game server detail page: MiniOverviewDrawer handles its own button — no global FAB
    if (pathname.startsWith("/game-hub/") && pathname !== "/game-hub/new") return null;

    // Game Hub list
    if (pathname === "/game-hub") {
      const items: FABAction[] = [];
      if (can("game-hub:write")) {
        items.push({
          icon: Plus,
          label: "New Server",
          color: "bg-[#0078D4]/20 border-[#0078D4]/30 text-[#4db3ff]",
          onClick: () => { setOpen(false); router.push("/game-hub/new"); },
        });
      }
      return items.length ? items : null;
    }

    // DNS page
    if (pathname === "/dns") {
      if (!can("config:write")) return null;
      return [{
        icon: Globe,
        label: "Add DNS Record",
        color: "bg-teal-500/20 border-teal-500/30 text-teal-300",
        onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:dns:add")); },
      }];
    }

    // Users / RBAC
    if (pathname.startsWith("/users") || pathname === "/settings/rbac") {
      if (!can("users:invite")) return null;
      return [{
        icon: UserPlus,
        label: "Invite User",
        color: "bg-purple-500/20 border-purple-500/30 text-purple-300",
        onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:users:invite")); },
      }];
    }

    // Apps / Community apps / Catalog
    if (pathname === "/apps" || pathname === "/community-apps" || pathname === "/catalog-install") {
      if (!can("catalog:write")) return null;
      return [{
        icon: Layers,
        label: "Install App",
        color: "bg-green-500/20 border-green-500/30 text-green-300",
        onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:apps:install")); },
      }];
    }

    // Logs / Log analytics
    if (pathname === "/logs" || pathname === "/log-analytics") {
      if (!can("cluster:read")) return null;
      return [{
        icon: FileText,
        label: "Export Logs",
        color: "bg-amber-500/20 border-amber-500/30 text-amber-300",
        onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:logs:export")); },
      }];
    }

    // Security
    if (pathname.startsWith("/security") || pathname === "/image-vulnerabilities") {
      if (!can("security:read")) return null;
      return [{
        icon: Shield,
        label: "Run Scan",
        color: "bg-red-500/20 border-red-500/30 text-red-300",
        onClick: () => { setOpen(false); window.dispatchEvent(new CustomEvent("fab:security:scan")); },
      }];
    }

    // Home / Cluster / Health — sync + events
    if (["/home", "/cluster", "/health", "/status"].includes(pathname)) {
      const items: FABAction[] = [];
      if (can("apps:sync")) {
        items.push({
          icon: RefreshCw,
          label: "Sync All",
          color: "bg-indigo-500/20 border-indigo-500/30 text-indigo-300",
          onClick: async () => {
            setOpen(false);
            try {
              const res = await fetch("/api/argocd/sync-all", { method: "POST" });
              if (res.ok) {
                toast.success("Sync triggered for all apps");
                qc.invalidateQueries({ queryKey: ["argocd", "apps"] });
              } else {
                toast.error("Sync all failed");
              }
            } catch {
              toast.error("Sync all failed");
            }
          },
        });
      }
      items.push({
        icon: Bell,
        label: "View Events",
        color: "bg-amber-500/20 border-amber-500/30 text-amber-300",
        onClick: () => { setOpen(false); router.push("/events"); },
      });
      return items;
    }

    // ArgoCD / Apps pages
    if (pathname === "/apps" || pathname.startsWith("/gitops")) {
      if (!can("apps:sync")) return null;
      return [{
        icon: RefreshCw,
        label: "Sync All",
        color: "bg-indigo-500/20 border-indigo-500/30 text-indigo-300",
        onClick: async () => {
          setOpen(false);
          try {
            const res = await fetch("/api/argocd/sync-all", { method: "POST" });
            if (res.ok) {
              toast.success("Sync triggered");
              qc.invalidateQueries({ queryKey: ["argocd", "apps"] });
            } else {
              toast.error("Sync failed");
            }
          } catch {
            toast.error("Sync failed");
          }
        },
      }];
    }

    // No FAB for other pages (wiki, settings, profile, etc.)
    return null;
  }, [pathname, can, qc, router]);

  // Don't render anything if no actions for this page
  if (!actions) return null;

  const primaryAction = actions[0];
  const secondaryActions = actions.slice(1);
  const hasMenu = secondaryActions.length > 0;

  // Single action: direct button (no expand menu needed)
  if (!hasMenu) {
    return (
      <div className="fixed bottom-24 right-4 z-40 sm:hidden">
        <motion.button
          onClick={primaryAction.onClick}
          whileTap={{ scale: 0.9 }}
          className={cn(
            "flex items-center gap-2 px-4 h-14 rounded-full border text-sm font-semibold shadow-xl backdrop-blur-sm",
            primaryAction.color ?? "bg-[#0078D4]/20 border-[#0078D4]/30 text-[#4db3ff]",
          )}
        >
          <primaryAction.icon className="w-5 h-5" />
          {primaryAction.label}
        </motion.button>
      </div>
    );
  }

  // Multiple actions: expandable FAB
  return (
    <div className="fixed bottom-24 right-4 z-40 sm:hidden flex flex-col items-end gap-3">
      <AnimatePresence>
        {open && (
          <>
            {actions.map((action, i) => (
              <motion.button
                key={action.label}
                initial={{ opacity: 0, scale: 0.8, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: 10 }}
                transition={{ delay: i * 0.05, type: "spring", stiffness: 400, damping: 25 }}
                onClick={action.onClick}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 rounded-full border text-sm font-medium shadow-lg backdrop-blur-sm",
                  action.color,
                )}
              >
                <action.icon className="w-4 h-4" />
                {action.label}
              </motion.button>
            ))}
          </>
        )}
      </AnimatePresence>

      <motion.button
        onClick={() => setOpen(o => !o)}
        whileTap={{ scale: 0.9 }}
        animate={{ rotate: open ? 45 : 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="w-14 h-14 rounded-full bg-indigo-500 shadow-lg shadow-indigo-500/30 flex items-center justify-center text-white border border-indigo-400/50"
      >
        {open ? <X className="w-6 h-6" /> : <Plus className="w-6 h-6" />}
      </motion.button>
    </div>
  );
}
