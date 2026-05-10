"use client";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Box, Settings, Users, HardDrive,
  Network, Activity, ChevronLeft, ChevronRight, Terminal, History, Cog,
  Package, FileText, Bell, ShieldCheck, Server, PlusCircle, ChevronDown,
  Sparkles, Home,
} from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { useArgoApps } from "@/hooks/use-argocd";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";

interface NavItem {
  href: string;
  icon: React.ElementType;
  label: string;
  shortcut: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: "Core",
    items: [
      { href: "/home", icon: Home, label: "Home Portal", shortcut: "G O" },
      { href: "/", icon: LayoutDashboard, label: "Dashboard", shortcut: "G D" },
      { href: "/apps", icon: Box, label: "Applications", shortcut: "G A" },
      { href: "/catalog-install", icon: PlusCircle, label: "App Installer", shortcut: "G I" },
      { href: "/events", icon: History, label: "Activity Log", shortcut: "G E" },
    ],
  },
  {
    label: "Platform",
    items: [
      { href: "/config", icon: Cog, label: "Config Editor", shortcut: "G C" },
      { href: "/users", icon: Users, label: "Users", shortcut: "G U" },
      { href: "/registry", icon: Package, label: "Registry", shortcut: "G R" },
      { href: "/logs", icon: FileText, label: "Pod Logs", shortcut: "G L" },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { href: "/storage", icon: HardDrive, label: "Storage", shortcut: "G S" },
      { href: "/network", icon: Network, label: "Network", shortcut: "G N" },
      { href: "/health", icon: Activity, label: "Health", shortcut: "G H" },
      { href: "/security", icon: ShieldCheck, label: "Security", shortcut: "G Y" },
      { href: "/cluster", icon: Server, label: "Cluster", shortcut: "G K" },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/settings", icon: Settings, label: "Settings", shortcut: "" },
      { href: "/changelog", icon: Sparkles, label: "What's New", shortcut: "" },
    ],
  },
];

function ClusterHealthDot() {
  const { data } = useQuery({
    queryKey: ["health", "cluster"],
    queryFn: async () => {
      const res = await fetch("/api/health/cluster");
      if (!res.ok) throw new Error("Health check failed");
      return res.json() as Promise<{ status: string }>;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const colors: Record<string, string> = {
    healthy: "bg-green-500",
    degraded: "bg-red-500",
    progressing: "bg-yellow-500 animate-pulse",
    unknown: "bg-slate-500",
  };

  return (
    <span className={cn("absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-slate-900", colors[data?.status ?? "unknown"])} />
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { role } = useRBAC();
  const { data: session } = useSession();
  const { data: apps } = useArgoApps();

  const alertCount = (apps ?? []).filter(
    a => a.status.health.status === "Degraded" || a.status.sync.status === "OutOfSync"
  ).length;

  const roleColors: Record<string, string> = {
    admin: "text-red-400 bg-red-500/10 border-red-500/20",
    operator: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
    viewer: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    unknown: "text-slate-400 bg-slate-500/10 border-slate-500/20",
  };

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem("sidebar-collapsed-groups") ?? "{}");
    } catch { return {}; }
  });

  const toggleGroup = (label: string) => {
    setCollapsedGroups(prev => {
      const next = { ...prev, [label]: !prev[label] };
      localStorage.setItem("sidebar-collapsed-groups", JSON.stringify(next));
      return next;
    });
  };

  return (
    <motion.aside
      animate={{ width: collapsed ? 72 : 240 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className="relative hidden md:flex flex-col h-full bg-slate-900/80 backdrop-blur-sm border-r border-white/5 overflow-hidden flex-shrink-0"
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/5">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0 relative">
          <Terminal className="w-4 h-4 text-indigo-400" />
          <ClusterHealthDot />
        </div>
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="flex-1 flex items-center justify-between min-w-0"
            >
              <span className="font-bold text-white text-sm whitespace-nowrap">InfraWeaver</span>
              {alertCount > 0 && (
                <div className="relative">
                  <Bell className="w-4 h-4 text-slate-400" />
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center"
                  >
                    {alertCount > 9 ? "9+" : alertCount}
                  </motion.span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Nav with collapsible groups */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto custom-scrollbar">
        {navGroups.map(group => {
          const isGroupCollapsed = collapsedGroups[group.label] ?? false;
          const hasActiveItem = group.items.some(item =>
            item.href === pathname || (item.href !== "/" && pathname.startsWith(item.href))
          );

          return (
            <div key={group.label} className="mb-1">
              {/* Group header */}
              <AnimatePresence>
                {!collapsed && (
                  <motion.button
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => toggleGroup(group.label)}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-1.5 rounded-md text-[10px] font-semibold uppercase tracking-wider transition-colors",
                      hasActiveItem ? "text-indigo-400" : "text-slate-600 hover:text-slate-400"
                    )}
                  >
                    <span>{group.label}</span>
                    <ChevronDown className={cn(
                      "w-3 h-3 transition-transform duration-200",
                      isGroupCollapsed ? "-rotate-90" : ""
                    )} />
                  </motion.button>
                )}
              </AnimatePresence>

              {/* Group items */}
              <AnimatePresence initial={false}>
                {(!isGroupCollapsed || collapsed) && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                    className="overflow-hidden space-y-0.5"
                  >
                    {group.items.map(item => {
                      const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                      return (
                        <Link key={item.href} href={item.href}>
                          <motion.div
                            whileHover={{ x: collapsed ? 0 : 2 }}
                            className={cn(
                              "relative flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer group",
                              collapsed ? "justify-center" : "",
                              isActive
                                ? "bg-indigo-500/20 text-indigo-300 shadow-[inset_0_0_12px_rgba(99,102,241,0.15)]"
                                : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                            )}
                          >
                            {isActive && (
                              <motion.div
                                layoutId="active-indicator"
                                className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-indigo-400 rounded-full"
                              />
                            )}
                            <item.icon className="w-4 h-4 flex-shrink-0" />
                            <AnimatePresence>
                              {!collapsed && (
                                <>
                                  <motion.span
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="text-sm font-medium whitespace-nowrap"
                                  >
                                    {item.label}
                                  </motion.span>
                                  {item.shortcut && (
                                    <motion.span
                                      initial={{ opacity: 0 }}
                                      animate={{ opacity: 1 }}
                                      exit={{ opacity: 0 }}
                                      className="ml-auto text-[10px] text-slate-600 font-mono opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                      {item.shortcut}
                                    </motion.span>
                                  )}
                                </>
                              )}
                            </AnimatePresence>
                          </motion.div>
                        </Link>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>

      {/* User info + role */}
      <div className="px-3 py-4 border-t border-white/5">
        <div className={cn("flex items-center gap-2", collapsed && "justify-center")}>
          <div className="w-7 h-7 rounded-full bg-indigo-500/30 flex items-center justify-center flex-shrink-0 text-xs font-bold text-indigo-300">
            {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 min-w-0"
              >
                <p className="text-xs font-medium text-slate-200 truncate">{session?.user?.name ?? "Unknown"}</p>
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", roleColors[role])}>
                  {role}
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Version badge */}
        <AnimatePresence>
          {!collapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mt-3 flex items-center gap-1.5"
            >
              <span className="text-[10px] text-slate-600 font-mono">
                v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
              </span>
              <span className="w-1 h-1 rounded-full bg-emerald-500/60" />
              <span className="text-[10px] text-slate-700">InfraWeaver</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Collapse button */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-8 w-6 h-6 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-colors z-10"
      >
        {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>
    </motion.aside>
  );
}
