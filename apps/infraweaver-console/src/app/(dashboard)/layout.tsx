"use client";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { useSession } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { LayoutDashboard, Box, Activity, Network, Cog, X } from "lucide-react";
import { cn } from "@/lib/utils";

const mobileNavItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Apps" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/config", icon: Cog, label: "Config" },
];

const drawerNavItems = [
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Applications" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/config", icon: Cog, label: "Config Editor" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/auth/signin");
    }
  }, [status, router]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden overflow-x-hidden">
      {/* Aurora background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-40 -left-40 w-80 h-80 rounded-full bg-indigo-600/10 blur-3xl aurora-blob" />
        <div className="absolute top-1/3 -right-32 w-96 h-96 rounded-full bg-violet-600/8 blur-3xl aurora-blob-delay-2" />
        <div className="absolute -bottom-32 left-1/3 w-80 h-80 rounded-full bg-cyan-600/8 blur-3xl aurora-blob-delay-4" />
      </div>

      {/* Desktop Sidebar */}
      <Sidebar />

      {/* Mobile Drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.div
              initial={{ x: -280, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -280, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed left-0 top-0 bottom-0 z-50 w-64 bg-slate-900/95 backdrop-blur-sm border-r border-white/5 md:hidden overflow-y-auto"
            >
              <div className="flex items-center justify-between px-4 py-5 border-b border-white/5">
                <span className="font-bold text-white text-sm">InfraWeaver</span>
                <button onClick={() => setMobileOpen(false)} className="text-slate-400 hover:text-white transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="px-2 py-4 space-y-1">
                {drawerNavItems.map(item => {
                  const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                  return (
                    <Link key={item.href} href={item.href}>
                      <div className={cn(
                        "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors",
                        isActive
                          ? "bg-indigo-500/20 text-indigo-300"
                          : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                      )}>
                        <item.icon className="w-4 h-4 flex-shrink-0" />
                        <span className="text-sm font-medium">{item.label}</span>
                      </div>
                    </Link>
                  );
                })}
              </nav>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col overflow-hidden relative z-10">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <main
          className="flex-1 overflow-y-auto p-4 md:p-6"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px) + 72px, 80px)" }}
        >
          {children}
        </main>
      </div>

      {/* Bottom mobile nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 md:hidden bg-slate-900/95 backdrop-blur-sm border-t border-white/5 flex safe-bottom">
        {mobileNavItems.map(item => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex-1 flex flex-col items-center gap-1 py-3 text-xs transition-colors",
                isActive ? "text-indigo-400" : "text-slate-500 hover:text-slate-300"
              )}
            >
              <item.icon className="w-5 h-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
