"use client";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { FloatingActionButton } from "@/components/floating-action-button";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { useSession, signOut } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { LayoutDashboard, Box, Activity, Network, Cog, X, ShieldCheck, Server, Users, Home, AlertTriangle, Gamepad2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsProvider } from "@/components/keyboard-shortcuts-modal";
import { SimpleModeProvider } from "@/contexts/simple-mode-context";
import { TrendingUp } from "lucide-react";

const mobileNavItems = [
  { href: "/home", icon: Home, label: "Home" },
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Apps" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/config", icon: Cog, label: "Config" },
];

const drawerNavItems = [
  { href: "/home", icon: Home, label: "Home Portal" },
  { href: "/", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/apps", icon: Box, label: "Applications" },
  { href: "/health", icon: Activity, label: "Health" },
  { href: "/network", icon: Network, label: "Network" },
  { href: "/config", icon: Cog, label: "Config Editor" },
  { href: "/security", icon: ShieldCheck, label: "Security" },
  { href: "/cluster", icon: Server, label: "Cluster" },
  { href: "/users", icon: Users, label: "User Management" },
  { href: "/gameservers", icon: Gamepad2, label: "Port Routing" },
  { href: "/uptime", icon: TrendingUp, label: "Uptime History" },
  { href: "/certificates", icon: ShieldCheck, label: "Certificates" },
];

function StatusBar() {
  const [time, setTime] = useState(new Date());

  const { data: pods } = useQuery({
    queryKey: ["pods", "status-bar"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      return res.json() as Promise<Array<{ status: string }>>;
    },
    refetchInterval: 60000,
    staleTime: 50000,
  });

  const { data: cluster } = useQuery({
    queryKey: ["health", "cluster"],
    queryFn: async () => {
      const res = await fetch("/api/health/cluster");
      return res.json() as Promise<{ status: string }>;
    },
    refetchInterval: 60000,
    staleTime: 50000,
  });

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const runningPods = (pods ?? []).filter(p => p.status === "Running").length;
  const totalPods = (pods ?? []).length;
  const isHealthy = !cluster || cluster.status === "healthy";
  const utcTime = time.toUTCString().split(" ")[4];

  return (
    <div className="flex items-center justify-between px-4 py-1.5 border-t border-white/5 bg-slate-950/60 text-xs text-slate-500 flex-shrink-0">
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-1.5 h-1.5 rounded-full",
          isHealthy ? "bg-green-500 live-dot" : "bg-red-500"
        )} />
        <span>{isHealthy ? "All systems operational" : "Degraded"}</span>
      </div>
      <div className="flex items-center gap-4">
        {totalPods > 0 && <span>{runningPods}/{totalPods} pods</span>}
        <span>{utcTime} UTC</span>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sessionWarning, setSessionWarning] = useState(false);
  const [countdown, setCountdown] = useState(300);

  // Session timeout warning
  useEffect(() => {
    const check = () => {
      if (!session?.expires) return;
      const expiresAt = new Date(session.expires).getTime();
      const remaining = Math.floor((expiresAt - Date.now()) / 1000);
      if (remaining <= 300 && remaining > 0) {
        setCountdown(remaining);
        setSessionWarning(true);
      }
    };
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, [session]);

  useEffect(() => {
    if (!sessionWarning) return;
    const tick = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(tick);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [sessionWarning]);

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
    <SimpleModeProvider>
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
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.1}
              onDragEnd={(_, info) => {
                if (info.offset.x < -40) setMobileOpen(false);
              }}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden cursor-default"
              onClick={() => setMobileOpen(false)}
            />
            <motion.div
              initial={{ x: -280, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -280, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              drag="x"
              dragConstraints={{ left: -280, right: 0 }}
              dragElastic={0.05}
              onDragEnd={(_, info) => {
                if (info.offset.x < -60 || info.velocity.x < -300) setMobileOpen(false);
              }}
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
                        "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors min-h-[44px] touch-manipulation",
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

              {/* Version — mobile drawer footer */}
              <div className="px-5 py-4 border-t border-white/5 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/70 flex-shrink-0" />
                <span className="text-[11px] font-mono text-slate-600">
                  v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                </span>
                <span className="text-[11px] text-slate-700">· InfraWeaver Console</span>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col overflow-hidden overflow-x-hidden relative z-10">
        <TopBar onMenuClick={() => setMobileOpen(true)} />
        <Breadcrumb />
        <main
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6 pb-24 md:pb-6"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px) + 80px, 88px)" }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={pathname}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
        <div className="hidden md:block">
          <StatusBar />
        </div>
      </div>

      {/* Floating Action Button (mobile) */}
      <FloatingActionButton />

      {/* Bottom mobile nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-black/80 backdrop-blur-xl border-t border-white/10 flex landscape-hide" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {mobileNavItems.map(item => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] text-[11px] transition-colors active:scale-95 touch-manipulation",
                isActive ? "text-indigo-400" : "text-slate-500 hover:text-slate-300"
              )}
            >
              <item.icon className="w-6 h-6" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Command palette */}
      <CommandPalette />

      {/* Keyboard shortcuts */}
      <KeyboardShortcutsProvider />

      {/* Session timeout warning modal */}
      <AnimatePresence>
        {sessionWarning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="relative w-full max-w-sm bg-slate-900 border border-white/10 rounded-xl shadow-2xl p-6 text-center"
            >
              <div className="w-12 h-12 rounded-full bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-6 h-6 text-yellow-400" />
              </div>
              <h2 className="text-lg font-semibold text-white mb-1">Session expiring soon</h2>
              <p className="text-sm text-slate-400 mb-4">
                Your session will expire in{" "}
                <span className="font-mono text-yellow-400">
                  {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
                </span>
              </p>
              {/* Countdown ring */}
              <div className="flex justify-center mb-6">
                <div className="relative w-16 h-16">
                  <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                    <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="4" fill="none" className="text-slate-800" />
                    <circle
                      cx="32" cy="32" r="28"
                      stroke="currentColor" strokeWidth="4" fill="none"
                      strokeDasharray={`${2 * Math.PI * 28}`}
                      strokeDashoffset={`${2 * Math.PI * 28 * (1 - countdown / 300)}`}
                      className="text-yellow-400 transition-all duration-1000"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-sm font-mono text-yellow-400">
                    {countdown}s
                  </span>
                </div>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={async () => {
                    await fetch("/api/auth/session");
                    setSessionWarning(false);
                  }}
                  className="flex-1 py-2 px-4 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors"
                >
                  Extend Session
                </button>
                <button
                  onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                  className="flex-1 py-2 px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-white/10"
                >
                  Sign Out
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </SimpleModeProvider>
  );
}
