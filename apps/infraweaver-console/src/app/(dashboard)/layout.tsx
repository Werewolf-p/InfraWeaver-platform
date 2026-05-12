"use client";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { FloatingActionButton } from "@/components/floating-action-button";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { useSession, signOut } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import {
  X, AlertTriangle, MoreHorizontal, Search, Clock,
  ChevronDown, ChevronRight, Settings, LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsProvider } from "@/components/keyboard-shortcuts-modal";
import { SimpleModeProvider } from "@/contexts/simple-mode-context";
import { MOBILE_BOTTOM_NAV, NAV_GROUPS } from "@/lib/nav-config";
import { SpotlightSearch } from "@/components/ui/spotlight-search";
import { OfflineIndicator } from "@/components/ui/offline-indicator";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useAddons } from "@/hooks/use-addons";

const mobileNavItems = MOBILE_BOTTOM_NAV;

// ── Section accent colors (Iter 3: colored group identifiers) ─────────────────
const GROUP_ACCENT: Record<string, string> = {
  core:           "bg-blue-500",
  platform:       "bg-violet-500",
  infrastructure: "bg-emerald-500",
  tools:          "bg-amber-500",
  services:       "bg-cyan-500",
  settings:       "bg-[#555]",
};

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
    <div className="flex items-center justify-between px-4 py-1.5 border-t border-[#2a2a2a] bg-[#0f0f0f] text-xs text-[#666] flex-shrink-0">
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreSearch, setMoreSearch] = useState("");
  const [moreCategory, setMoreCategory] = useState<string>("all");
  const [drawerSearch, setDrawerSearch] = useState("");
  const { addons, mounted: addonsMounted } = useAddons();

  // Build filtered nav groups based on enabled addons
  const filteredNavGroups = useMemo(() => {
    if (!addonsMounted) return NAV_GROUPS;
    return NAV_GROUPS.filter(group => {
      if (group.id === "gaming") {
        return addons.find(a => a.id === "game-hub")?.enabled === true;
      }
      return true;
    });
  }, [addons, addonsMounted]);

  // Auto-expand the group that contains the current page; others default to their defaultOpen
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const activeGroupId = NAV_GROUPS.find(g =>
      g.items.some(i => pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href)))
    )?.id;
    return Object.fromEntries(
      NAV_GROUPS.map(g => [g.id, g.id === activeGroupId ? true : (g.defaultOpen ?? false)])
    );
  });

  // When pathname changes, ensure the active group is open
  useEffect(() => {
    const activeGroupId = filteredNavGroups.find(g =>
      g.items.some(i => pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href)))
    )?.id;
    if (activeGroupId) {
      setOpenGroups(prev => ({ ...prev, [activeGroupId]: true }));
    }
  }, [pathname, filteredNavGroups]);
  const [sessionWarning, setSessionWarning] = useState(false);
  const [countdown, setCountdown] = useState(300);
  const [searchOpen, setSearchOpen] = useState(false);
  const { recentPages } = useRecentPages();

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
    setMoreOpen(false);
  }, [pathname]);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f0f0f]">
        <div className="w-8 h-8 border-2 border-[#0078D4] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <SimpleModeProvider>
    <div className="flex h-screen overflow-hidden overflow-x-hidden">
      <OfflineIndicator />
      {/* Desktop Sidebar */}
      <Sidebar />

      {/* Mobile Hamburger Drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/70 md:hidden"
              onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}
            />
            {/* Drawer panel */}
            <motion.div
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: "spring", damping: 50, stiffness: 700, restDelta: 0.5 }}
              drag="x"
              dragConstraints={{ left: -300, right: 0 }}
              dragElastic={0}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                if (info.offset.x < -60 || info.velocity.x < -300) { setMobileOpen(false); setDrawerSearch(""); }
              }}
              className="fixed left-0 top-0 bottom-0 z-50 w-[300px] bg-[#111] border-r border-[#222] md:hidden flex flex-col"
            >
              {/* ── ITER 1: Header with branding + cluster health dot ── */}
              <div className="flex-shrink-0 flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+14px)] pb-3 border-b border-[#222]">
                <div className="flex items-center gap-2.5">
                  <div className="relative w-7 h-7 rounded-lg bg-[#0078D4] flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-[10px] font-bold">IW</span>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#111]" />
                  </div>
                  <div>
                    <div className="font-semibold text-white text-[13px] leading-tight">InfraWeaver</div>
                    <div className="text-[9px] text-[#555] leading-tight">Management Console</div>
                  </div>
                </div>
                <button
                  onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#666] hover:text-white hover:bg-[#2a2a2a] transition-colors touch-manipulation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* ── ITER 1: Search ── */}
              <div className="flex-shrink-0 px-3 py-2.5 border-b border-[#1e1e1e]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
                  <input
                    value={drawerSearch}
                    onChange={e => setDrawerSearch(e.target.value)}
                    placeholder="Search pages…"
                    className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl pl-9 pr-3 py-2 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50"
                  />
                  {drawerSearch && (
                    <button onClick={() => setDrawerSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 touch-manipulation">
                      <X className="w-3.5 h-3.5 text-[#555] hover:text-white" />
                    </button>
                  )}
                </div>
              </div>

              {/* ── ITER 2: Recent pages quick-chips ── */}
              {!drawerSearch && recentPages.length > 0 && (
                <div
                  className="flex-shrink-0 px-3 pt-2.5 pb-1"
                  onPointerDown={e => e.stopPropagation()}
                >
                  <p className="text-[9px] font-semibold uppercase tracking-widest text-[#444] mb-1.5 px-1">Recent</p>
                  <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" style={{ touchAction: "pan-x" }}>
                    {recentPages.slice(0, 4).map((page: { href: string; title: string }) => (
                      <Link key={page.href} href={page.href} onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}>
                        <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#1a1a1a] border border-[#252525] text-[#888] hover:text-white hover:border-[#333] transition-colors whitespace-nowrap touch-manipulation">
                          <Clock className="w-2.5 h-2.5 flex-shrink-0" />
                          <span className="text-[10px] font-medium">{page.title}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* ── ITER 3+4: Nav groups — scrollable ── */}
              <div className="flex-1 overflow-y-auto pt-2 pb-2" style={{ touchAction: "pan-y" }}>
                {drawerSearch && (
                  /* Flat search results */
                  <div className="px-2">
                    {filteredNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(drawerSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(drawerSearch.toLowerCase())
                    ).map(item => {
                      const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                      return (
                        <Link key={item.href} href={item.href} onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}>
                          <div className={cn(
                            "flex items-center gap-3 px-3 py-3 rounded-xl transition-all min-h-[52px] touch-manipulation mb-0.5",
                            isActive ? "bg-[rgba(0,120,212,0.15)]" : "hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                          )}>
                            <div className={cn(
                              "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0",
                              isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#1a1a1a]"
                            )}>
                              <item.icon className={cn("w-[18px] h-[18px]", isActive ? "text-[#0078D4]" : "text-[#777]")} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={cn("text-sm font-medium truncate", isActive ? "text-[#0078D4]" : "text-[#ccc]")}>{item.label}</div>
                              {item.description && <div className="text-[10px] text-[#555] truncate">{item.description}</div>}
                            </div>
                            {isActive && <div className="w-1.5 h-1.5 rounded-full bg-[#0078D4] flex-shrink-0" />}
                          </div>
                        </Link>
                      );
                    })}
                    {filteredNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(drawerSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(drawerSearch.toLowerCase())
                    ).length === 0 && (
                      <div className="py-8 text-center text-[#444] text-sm">No results for &ldquo;{drawerSearch}&rdquo;</div>
                    )}
                  </div>
                )}

                {!drawerSearch && filteredNavGroups.map((group, gi) => {
                  const isOpen = openGroups[group.id] ?? false;
                  const hasActiveItem = group.items.some(i =>
                    pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href))
                  );
                  const accent = GROUP_ACCENT[group.id] ?? "bg-[#555]";
                  return (
                    <div key={group.id} className={cn("mb-0.5", gi > 0 && "")}>
                      {/* ── ITER 3: Group header with accent + count badge ── */}
                      <button
                        onClick={() => { setOpenGroups(prev => ({ ...prev, [group.id]: !prev[group.id] })); if (typeof navigator !== "undefined") navigator.vibrate?.(5); }}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-3 touch-manipulation transition-colors rounded-lg mx-1",
                          hasActiveItem ? "text-white" : "text-[#777] hover:text-[#bbb] hover:bg-[#161616]"
                        )}
                        style={{ width: "calc(100% - 8px)" }}
                      >
                        {/* Colored accent dot */}
                        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", accent)} />
                        <group.icon className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className={cn("text-[11px] font-semibold uppercase tracking-wider flex-1 text-left", hasActiveItem && "text-white")}>
                          {group.label}
                        </span>
                        {/* Item count badge */}
                        <span className="text-[9px] font-mono bg-[#1e1e1e] border border-[#2a2a2a] px-1.5 py-0.5 rounded-full text-[#555]">
                          {group.items.length}
                        </span>
                        {isOpen
                          ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
                          : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
                        }
                      </button>

                      {/* ── ITER 4: Group items — rich rows ── */}
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.15, ease: "easeInOut" }}
                            className="overflow-hidden"
                          >
                            {/* Left accent line under expanded group */}
                            <div className="ml-4 pl-4 border-l border-[#1e1e1e] space-y-0.5 pb-1.5 pr-2">
                              {group.items.map((item, idx) => {
                                const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                                return (
                                  <motion.div
                                    key={item.href}
                                    initial={{ opacity: 0, x: -8 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ delay: idx * 0.03, duration: 0.15 }}
                                  >
                                    <Link
                                      href={item.href}
                                      onClick={() => { setMobileOpen(false); setDrawerSearch(""); if (typeof navigator !== "undefined") navigator.vibrate?.(8); }}
                                    >
                                      <div className={cn(
                                        "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all min-h-[48px] touch-manipulation",
                                        isActive
                                          ? "bg-[rgba(0,120,212,0.12)] border border-[rgba(0,120,212,0.2)]"
                                          : "hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                                      )}>
                                        <div className={cn(
                                          "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors",
                                          isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#181818]"
                                        )}>
                                          <item.icon className={cn("w-4 h-4", isActive ? "text-[#0078D4]" : "text-[#666]")} />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <div className={cn(
                                            "text-sm font-medium truncate",
                                            isActive ? "text-[#4db3ff]" : "text-[#c8c8c8]"
                                          )}>{item.label}</div>
                                          {item.description && (
                                            <div className="text-[10px] text-[#484848] truncate mt-0.5">{item.description}</div>
                                          )}
                                        </div>
                                        {isActive && (
                                          <ChevronRight className="w-3.5 h-3.5 text-[#0078D4] flex-shrink-0 opacity-60" />
                                        )}
                                      </div>
                                    </Link>
                                  </motion.div>
                                );
                              })}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>

              {/* ── ITER 5: Footer — user profile + quick actions ── */}
              <div className="flex-shrink-0 border-t border-[#1e1e1e]" style={{ paddingBottom: "calc(env(safe-area-inset-bottom,0px) + 6px)" }}>
                {/* User row */}
                <Link href="/profile" onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}>
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-[#181818] transition-colors touch-manipulation">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#0078D4]/30 to-[#0078D4]/10 border border-[#0078D4]/25 flex items-center justify-center flex-shrink-0">
                      <span className="text-[#0078D4] text-sm font-bold">
                        {(session?.user?.name ?? session?.user?.email ?? "U").slice(0, 1).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-[#d4d4d4] truncate leading-tight">
                        {session?.user?.name ?? "User"}
                      </div>
                      <div className="text-[10px] text-[#444] truncate leading-tight mt-0.5">
                        {session?.user?.email ?? ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
                      <span className="text-[9px] text-emerald-500/70">Online</span>
                    </div>
                  </div>
                </Link>
                {/* Version badge */}
                <div className="flex items-center justify-between px-4 py-1">
                  <span className="text-[9px] font-mono text-[#2e2e2e]">
                    v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                  </span>
                  <span className="text-[9px] text-[#2e2e2e]">InfraWeaver Console</span>
                </div>
                {/* Quick action row */}
                <div className="flex items-center gap-1 px-3 pb-1">
                  <Link href="/settings" onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[#555] hover:text-[#999] hover:bg-[#181818] transition-colors touch-manipulation text-[11px]"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span>Settings</span>
                  </Link>
                  <button
                    onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[#555] hover:text-red-400 hover:bg-[#1a1010] transition-colors touch-manipulation text-[11px]"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sign out</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col overflow-hidden overflow-x-hidden relative z-10">
        <TopBar onMenuClick={() => setMobileOpen(true)} onSearchClick={() => setSearchOpen(true)} />
        <Breadcrumb />
        <main
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6 md:pb-6"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px) + 72px, 80px)" }}
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

      {/* Bottom mobile nav — 3 items + More */}
      <nav className="fixed bottom-0 left-0 right-0 z-20 md:hidden bg-[#141414] border-t border-[#2a2a2a] flex landscape-hide" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {mobileNavItems.map(item => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => { if (typeof navigator !== "undefined") navigator.vibrate?.(10); }}
              className={cn(
                "flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] text-[11px] transition-colors active:scale-95 touch-manipulation",
                isActive ? "text-[#0078D4]" : "text-[#666] hover:text-[#9e9e9e]"
              )}
            >
              <item.icon className="w-6 h-6" />
              <span>{item.label}</span>
            </Link>
          );
        })}
        {/* More button */}
        <button
          onClick={() => { if (typeof navigator !== "undefined") navigator.vibrate?.(10); setMoreOpen(true); }}
          className={cn(
            "flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] text-[11px] transition-colors active:scale-95 touch-manipulation",
            moreOpen ? "text-[#0078D4]" : "text-[#666] hover:text-[#9e9e9e]"
          )}
        >
          <MoreHorizontal className="w-6 h-6" />
          <span>More</span>
        </button>
      </nav>

      {/* ── More bottom sheet — ITER 4+5: redesigned as category grid hub ── */}
      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[200] bg-black/70 md:hidden"
              onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 50, stiffness: 700, restDelta: 0.5 }}
              drag="y"
              dragConstraints={{ top: 0 }}
              dragElastic={0}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                if (info.offset.y > 80 || info.velocity.y > 500) { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }
              }}
              className="fixed bottom-0 left-0 right-0 z-[201] bg-[#111] border-t border-[#222] rounded-t-2xl md:hidden max-h-[92dvh] flex flex-col shadow-2xl"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              {/* Drag handle */}
              <div className="flex-shrink-0 flex justify-center pt-2.5 pb-1">
                <div className="w-10 h-1 rounded-full bg-[#2a2a2a]" />
              </div>

              {/* Header row */}
              <div className="flex-shrink-0 flex items-center justify-between px-4 pt-1 pb-2.5">
                <div>
                  <h2 className="text-base font-semibold text-white leading-tight">All Features</h2>
                  <p className="text-[10px] text-[#555] mt-0.5">{filteredNavGroups.reduce((n, g) => n + g.items.length, 0)} pages available</p>
                </div>
                <button
                  onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}
                  className="w-8 h-8 flex items-center justify-center rounded-xl bg-[#1e1e1e] text-[#666] hover:text-white hover:bg-[#2a2a2a] transition-colors touch-manipulation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Search */}
              <div className="flex-shrink-0 px-4 pb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
                  <input
                    value={moreSearch}
                    onChange={e => { setMoreSearch(e.target.value); setMoreCategory("all"); }}
                    placeholder="Search all pages…"
                    className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl pl-9 pr-3 py-2.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50"
                  />
                  {moreSearch && (
                    <button onClick={() => setMoreSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 touch-manipulation">
                      <X className="w-3.5 h-3.5 text-[#555] hover:text-white" />
                    </button>
                  )}
                </div>
              </div>

              {/* Category pills */}
              {!moreSearch && (
                <div
                  className="flex-shrink-0 overflow-x-auto px-4 pb-3 scrollbar-none"
                  onPointerDown={e => e.stopPropagation()}
                  style={{ touchAction: "pan-x" }}
                >
                  <div className="flex gap-1.5 w-max">
                    <button
                      onClick={() => setMoreCategory("all")}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-xs font-medium transition-colors touch-manipulation whitespace-nowrap",
                        moreCategory === "all" ? "bg-[#0078D4] text-white" : "bg-[#1e1e1e] text-[#777] hover:text-white hover:bg-[#2a2a2a]"
                      )}
                    >All</button>
                    {filteredNavGroups.map(group => {
                      const accent = GROUP_ACCENT[group.id] ?? "bg-[#555]";
                      return (
                        <button
                          key={group.id}
                          onClick={() => setMoreCategory(group.id)}
                          className={cn(
                            "px-3 py-1.5 rounded-full text-xs font-medium transition-colors touch-manipulation whitespace-nowrap flex items-center gap-1.5",
                            moreCategory === group.id ? "bg-[#0078D4] text-white" : "bg-[#1e1e1e] text-[#777] hover:text-white hover:bg-[#2a2a2a]"
                          )}
                        >
                          <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", moreCategory === group.id ? "bg-white" : accent)} />
                          {group.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Content — grid when category selected, list when searching */}
              <div className="flex-1 overflow-y-auto px-3 pb-4" style={{ touchAction: "pan-y" }}>

                {/* Recent pages (all + no search) */}
                {recentPages.length > 0 && !moreSearch && moreCategory === "all" && (
                  <div className="mb-4">
                    <p className="text-[9px] font-semibold uppercase tracking-widest text-[#444] px-2 mb-2">Recently visited</p>
                    <div
                      className="flex gap-2 overflow-x-auto pb-1 scrollbar-none"
                      onPointerDown={e => e.stopPropagation()}
                      style={{ touchAction: "pan-x" }}
                    >
                      {recentPages.slice(0, 5).map((page: { href: string; title: string }) => (
                        <Link key={page.href} href={page.href} onClick={() => { setMoreOpen(false); setMoreCategory("all"); }}>
                          <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a1a1a] border border-[#232323] text-[#888] hover:text-white hover:border-[#333] transition-colors whitespace-nowrap touch-manipulation min-h-[36px]">
                            <Clock className="w-3 h-3 flex-shrink-0" />
                            <span className="text-[11px] font-medium">{page.title}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* In search mode: flat list */}
                {moreSearch && (
                  <div className="space-y-0.5">
                    {filteredNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(moreSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(moreSearch.toLowerCase())
                    ).map(item => {
                      const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                      return (
                        <Link key={item.href} href={item.href} onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}>
                          <div className={cn(
                            "flex items-center gap-3 px-3 py-3 rounded-xl transition-colors min-h-[52px] touch-manipulation",
                            isActive ? "bg-[rgba(0,120,212,0.15)]" : "hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                          )}>
                            <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0", isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#1a1a1a]")}>
                              <item.icon className={cn("w-[18px] h-[18px]", isActive ? "text-[#0078D4]" : "text-[#777]")} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={cn("text-sm font-medium truncate", isActive ? "text-[#4db3ff]" : "text-[#ccc]")}>{item.label}</div>
                              {item.description && <div className="text-[11px] text-[#555] truncate">{item.description}</div>}
                            </div>
                            {isActive && <div className="w-1.5 h-1.5 rounded-full bg-[#0078D4] flex-shrink-0" />}
                          </div>
                        </Link>
                      );
                    })}
                    {filteredNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(moreSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(moreSearch.toLowerCase())
                    ).length === 0 && (
                      <div className="text-center py-10 text-[#444] text-sm">No results for &ldquo;{moreSearch}&rdquo;</div>
                    )}
                  </div>
                )}

                {/* Category/All mode: section groups with 2-col grid */}
                {!moreSearch && filteredNavGroups.filter(g => moreCategory === "all" || g.id === moreCategory).map(group => {
                  const accent = GROUP_ACCENT[group.id] ?? "bg-[#555]";
                  return (
                    <div key={group.id} className="mb-5">
                      {/* Section header */}
                      <div className="flex items-center gap-2 px-1 mb-2.5">
                        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", accent)} />
                        <group.icon className="w-3.5 h-3.5 text-[#555]" />
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#555]">{group.label}</p>
                        <span className="text-[9px] font-mono text-[#444] bg-[#1a1a1a] px-1.5 py-0.5 rounded-full">{group.items.length}</span>
                      </div>
                      {/* 2-column item grid */}
                      <div className="grid grid-cols-2 gap-1.5">
                        {group.items.map(item => {
                          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                          return (
                            <Link key={item.href} href={item.href} onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}>
                              <div className={cn(
                                "flex flex-col gap-2 p-3 rounded-xl transition-all min-h-[72px] touch-manipulation",
                                isActive
                                  ? "bg-[rgba(0,120,212,0.12)] border border-[rgba(0,120,212,0.25)]"
                                  : "bg-[#161616] border border-[#1e1e1e] hover:border-[#2a2a2a] hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                              )}>
                                <div className={cn(
                                  "w-8 h-8 rounded-lg flex items-center justify-center",
                                  isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#202020]"
                                )}>
                                  <item.icon className={cn("w-4 h-4", isActive ? "text-[#4db3ff]" : "text-[#666]")} />
                                </div>
                                <div className="min-w-0">
                                  <div className={cn("text-[12px] font-medium leading-tight truncate", isActive ? "text-[#4db3ff]" : "text-[#ccc]")}>{item.label}</div>
                                  {item.description && (
                                    <div className="text-[9px] text-[#444] leading-tight mt-0.5 line-clamp-2">{item.description}</div>
                                  )}
                                </div>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

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
              className="relative w-full max-w-sm bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl p-6 text-center"
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
                  className="flex-1 py-2 px-4 rounded-lg bg-[#0078D4] hover:bg-[#1a86d9] text-white text-sm font-medium transition-colors"
                >
                  Extend Session
                </button>
                <button
                  onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                  className="flex-1 py-2 px-4 rounded-lg bg-[#2a2a2a] hover:bg-[#333] text-[#9e9e9e] text-sm font-medium transition-colors border border-[#333]"
                >
                  Sign Out
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <SpotlightSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
    </SimpleModeProvider>
  );
}
