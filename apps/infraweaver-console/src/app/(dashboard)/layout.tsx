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
import { X, AlertTriangle, MoreHorizontal, Search, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcutsProvider } from "@/components/keyboard-shortcuts-modal";
import { SimpleModeProvider } from "@/contexts/simple-mode-context";
import { MOBILE_BOTTOM_NAV, NAV_GROUPS, type NavGroup } from "@/lib/nav-config";
import { SpotlightSearch } from "@/components/ui/spotlight-search";
import { OfflineIndicator } from "@/components/ui/offline-indicator";
import { useRecentPages } from "@/hooks/use-recent-pages";

const mobileNavItems = MOBILE_BOTTOM_NAV;

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
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () => Object.fromEntries(NAV_GROUPS.map(g => [g.id, g.defaultOpen ?? false]))
  );
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
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
              drag="x"
              dragConstraints={{ left: -300, right: 0 }}
              dragElastic={0.05}
              onDragEnd={(_, info) => {
                if (info.offset.x < -60 || info.velocity.x < -300) { setMobileOpen(false); setDrawerSearch(""); }
              }}
              className="fixed left-0 top-0 bottom-0 z-50 w-[280px] bg-[#111] border-r border-[#222] md:hidden flex flex-col"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+14px)] pb-3 border-b border-[#222]">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-[#0078D4] flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-[10px] font-bold">IW</span>
                  </div>
                  <span className="font-semibold text-white text-sm">InfraWeaver</span>
                </div>
                <button
                  onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#666] hover:text-white hover:bg-[#2a2a2a] transition-colors touch-manipulation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Search */}
              <div className="px-3 py-2.5 border-b border-[#1e1e1e]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
                  <input
                    value={drawerSearch}
                    onChange={e => setDrawerSearch(e.target.value)}
                    placeholder="Search…"
                    className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg pl-8 pr-3 py-2 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50"
                  />
                </div>
              </div>

              {/* Nav groups */}
              <div className="flex-1 overflow-y-auto py-2">
                {NAV_GROUPS.map(group => {
                  const filteredItems = drawerSearch
                    ? group.items.filter(i => i.label.toLowerCase().includes(drawerSearch.toLowerCase()))
                    : group.items;
                  if (drawerSearch && filteredItems.length === 0) return null;
                  const isOpen = drawerSearch ? true : (openGroups[group.id] ?? false);
                  const hasActiveItem = group.items.some(i =>
                    pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href))
                  );
                  return (
                    <div key={group.id} className="mb-0.5">
                      {/* Group header */}
                      {!drawerSearch && (
                        <button
                          onClick={() => setOpenGroups(prev => ({ ...prev, [group.id]: !prev[group.id] }))}
                          className={cn(
                            "w-full flex items-center justify-between px-4 py-2.5 touch-manipulation transition-colors",
                            hasActiveItem ? "text-[#0078D4]" : "text-[#666] hover:text-[#999]"
                          )}
                        >
                          <div className="flex items-center gap-2.5">
                            <group.icon className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="text-[11px] font-semibold uppercase tracking-wider">{group.label}</span>
                          </div>
                          {isOpen
                            ? <ChevronDown className="w-3.5 h-3.5" />
                            : <ChevronRight className="w-3.5 h-3.5" />
                          }
                        </button>
                      )}
                      {/* Group items */}
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="overflow-hidden"
                          >
                            <div className="px-2 pb-1 space-y-0.5">
                              {filteredItems.map(item => {
                                const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                                return (
                                  <Link
                                    key={item.href}
                                    href={item.href}
                                    onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}
                                  >
                                    <div className={cn(
                                      "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors min-h-[44px] touch-manipulation",
                                      isActive
                                        ? "bg-[rgba(0,120,212,0.15)] text-[#0078D4]"
                                        : "text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#1e1e1e]"
                                    )}>
                                      <item.icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-[#0078D4]" : "text-[#666]")} />
                                      <div className="min-w-0">
                                        <div className="text-sm font-medium truncate">{item.label}</div>
                                        {item.description && (
                                          <div className="text-[10px] text-[#555] truncate">{item.description}</div>
                                        )}
                                      </div>
                                      {isActive && (
                                        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-[#0078D4] flex-shrink-0" />
                                      )}
                                    </div>
                                  </Link>
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

              {/* Footer */}
              <div className="px-4 py-3 border-t border-[#1e1e1e] flex items-center gap-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom,0px) + 12px)" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/70 flex-shrink-0" />
                <span className="text-[11px] font-mono text-[#444]">v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}</span>
                <span className="text-[11px] text-[#333]">· InfraWeaver</span>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col overflow-hidden overflow-x-hidden relative z-10">
        <TopBar onMenuClick={() => setMobileOpen(true)} onSearchClick={() => setSearchOpen(true)} />
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

      {/* More bottom sheet — grouped by category */}
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
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
              drag="y"
              dragConstraints={{ top: 0 }}
              dragElastic={0.1}
              onDragEnd={(_, info) => {
                if (info.offset.y > 80 || info.velocity.y > 500) { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }
              }}
              className="fixed bottom-0 left-0 right-0 z-[201] bg-[#111] border-t border-[#222] rounded-t-2xl md:hidden max-h-[88dvh] flex flex-col shadow-2xl"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              {/* Drag handle */}
              <div className="flex-shrink-0 flex justify-center pt-3 pb-1.5">
                <div className="w-9 h-1 rounded-full bg-[#333]" />
              </div>

              {/* Header + search row */}
              <div className="flex-shrink-0 px-4 pb-3 flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
                  <input
                    value={moreSearch}
                    onChange={e => { setMoreSearch(e.target.value); setMoreCategory("all"); }}
                    placeholder="Search all features…"
                    className="w-full bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl pl-9 pr-3 py-2.5 text-sm text-[#f2f2f2] placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50"
                  />
                </div>
                <button
                  onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}
                  className="w-9 h-9 flex items-center justify-center rounded-xl text-[#666] hover:text-white hover:bg-[#2a2a2a] transition-colors touch-manipulation flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Category pill tabs (hidden during search) */}
              {!moreSearch && (
                <div className="flex-shrink-0 overflow-x-auto px-4 pb-3 scrollbar-hide">
                  <div className="flex gap-1.5 w-max">
                    <button
                      onClick={() => setMoreCategory("all")}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-xs font-medium transition-colors touch-manipulation whitespace-nowrap",
                        moreCategory === "all"
                          ? "bg-[#0078D4] text-white"
                          : "bg-[#1e1e1e] text-[#888] hover:text-white hover:bg-[#2a2a2a]"
                      )}
                    >All</button>
                    {NAV_GROUPS.map(group => (
                      <button
                        key={group.id}
                        onClick={() => setMoreCategory(group.id)}
                        className={cn(
                          "px-3 py-1.5 rounded-full text-xs font-medium transition-colors touch-manipulation whitespace-nowrap flex items-center gap-1.5",
                          moreCategory === group.id
                            ? "bg-[#0078D4] text-white"
                            : "bg-[#1e1e1e] text-[#888] hover:text-white hover:bg-[#2a2a2a]"
                        )}
                      >
                        <group.icon className="w-3 h-3" />
                        {group.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Content */}
              <div className="flex-1 overflow-y-auto px-3 pb-4">
                {/* Recent pages (when not searching or filtering) */}
                {recentPages.length > 0 && !moreSearch && moreCategory === "all" && (
                  <div className="mb-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[#444] px-2 mb-1.5">Recent</p>
                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                      {recentPages.slice(0, 5).map((page: { href: string; title: string }) => (
                        <Link key={page.href} href={page.href} onClick={() => { setMoreOpen(false); setMoreCategory("all"); }}>
                          <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a1a1a] text-[#888] hover:text-white hover:bg-[#2a2a2a] transition-colors whitespace-nowrap touch-manipulation">
                            <Clock className="w-3 h-3 flex-shrink-0" />
                            <span className="text-xs">{page.title}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}

                {/* Grouped nav items */}
                {NAV_GROUPS.filter(g => moreCategory === "all" || g.id === moreCategory).map(group => {
                  const items = group.items.filter(i =>
                    !moreSearch || i.label.toLowerCase().includes(moreSearch.toLowerCase()) ||
                    (i.description ?? "").toLowerCase().includes(moreSearch.toLowerCase())
                  );
                  if (items.length === 0) return null;
                  return (
                    <div key={group.id} className="mb-4">
                      {(moreCategory === "all" && !moreSearch) && (
                        <div className="flex items-center gap-2 px-2 mb-2">
                          <group.icon className="w-3.5 h-3.5 text-[#555]" />
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#444]">{group.label}</p>
                        </div>
                      )}
                      <div className="space-y-0.5">
                        {items.map(item => {
                          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}
                            >
                              <div className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-xl transition-colors min-h-[52px] touch-manipulation",
                                isActive
                                  ? "bg-[rgba(0,120,212,0.15)] text-[#0078D4]"
                                  : "text-[#9e9e9e] hover:text-white hover:bg-[#1e1e1e] active:bg-[#252525]"
                              )}>
                                <div className={cn(
                                  "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0",
                                  isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#1a1a1a]"
                                )}>
                                  <item.icon className={cn("w-4.5 h-4.5", isActive ? "text-[#0078D4]" : "text-[#777]")} style={{ width: "18px", height: "18px" }} />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-medium truncate">{item.label}</div>
                                  {item.description && (
                                    <div className="text-[11px] text-[#555] truncate">{item.description}</div>
                                  )}
                                </div>
                                {isActive && (
                                  <div className="w-1.5 h-1.5 rounded-full bg-[#0078D4] flex-shrink-0" />
                                )}
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Empty state */}
                {moreSearch && NAV_GROUPS.every(g => g.items.every(i =>
                  !i.label.toLowerCase().includes(moreSearch.toLowerCase()) &&
                  !(i.description ?? "").toLowerCase().includes(moreSearch.toLowerCase())
                )) && (
                  <div className="text-center py-10 text-[#444] text-sm">
                    No results for &ldquo;{moreSearch}&rdquo;
                  </div>
                )}
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
