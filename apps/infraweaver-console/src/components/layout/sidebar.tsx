"use client";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, Box, Settings, Users, HardDrive,
  Network, Activity, ChevronLeft, ChevronRight, Terminal, History, Cog
} from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";

const navItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Applications" },
  { href: "/events", icon: History, label: "Activity Log" },
  { href: "/config", icon: Cog, label: "Config Editor" },
  { href: "/users", icon: Users, label: "Users" },
  { href: "/storage", icon: HardDrive, label: "Storage" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { role } = useRBAC();
  const { data: session } = useSession();

  const roleColors: Record<string, string> = {
    admin: "text-red-400 bg-red-500/10 border-red-500/20",
    operator: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
    viewer: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    unknown: "text-slate-400 bg-slate-500/10 border-slate-500/20",
  };

  return (
    <motion.aside
      animate={{ width: collapsed ? 72 : 240 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className="relative flex flex-col h-full bg-slate-900/80 backdrop-blur-sm border-r border-white/5 overflow-hidden"
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/5">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0">
          <Terminal className="w-4 h-4 text-indigo-400" />
        </div>
        <AnimatePresence>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              className="font-bold text-white text-sm whitespace-nowrap"
            >
              InfraWeaver
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <motion.div
                whileHover={{ x: 2 }}
                className={cn(
                  "relative flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer group",
                  isActive
                    ? "bg-indigo-500/20 text-indigo-300"
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
                    <motion.span
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="text-sm font-medium whitespace-nowrap"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.div>
            </Link>
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
