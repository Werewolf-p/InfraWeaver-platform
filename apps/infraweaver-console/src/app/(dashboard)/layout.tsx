"use client";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { FloatingActionButton } from "@/components/floating-action-button";
import { Breadcrumb, titleForPathname } from "@/components/ui/breadcrumb";
import { useSession, signOut } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import {
  X, AlertTriangle, MoreHorizontal, Search, Clock,
  ChevronDown, ChevronRight, Settings, LogOut, ArrowUp, ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { KeyboardShortcutsProvider } from "@/components/keyboard-shortcuts-modal";
import { SimpleModeProvider } from "@/contexts/simple-mode-context";
import { NAV_GROUPS } from "@/lib/nav-config";
import {
  ALL_NAV_ITEMS as NAV_FAVORITE_ITEMS,
  MAX_NAV_FAVORITES,
  loadFavorites,
  saveFavorites,
} from "@/components/layout/nav-favorites-config";
import { OfflineIndicator } from "@/components/ui/offline-indicator";
import { GlobalSearch } from "@/components/search/global-search";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useAddons } from "@/hooks/use-addons";
import { useRBAC } from "@/hooks/use-rbac";
import { filterNavGroupsByAddons } from "@/lib/addons";
import { filterNavGroupsByPermissions, filterNavItemsByPermissions } from "@/lib/navigation-rbac";

// ── Section accent colors (Iter 3: colored group identifiers) ─────────────────
const GROUP_ACCENT: Record<string, string> = {
  overview: "bg-blue-500",
  apps: "bg-violet-500",
  compute: "bg-emerald-500",
  infrastructure: "bg-cyan-500",
  operations: "bg-amber-500",
  monitoring: "bg-rose-500",
  gaming: "bg-fuchsia-500",
  services: "bg-sky-500",
  tools: "bg-yellow-500",
  settings: "bg-[#555]",
};

function StatusBar() {
  const [time, setTime] = useState(new Date());

  const { data: pods } = useQuery({
    queryKey: ["pods", "status-bar"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) return [] as Array<{ status: string }>;
      return res.json() as Promise<Array<{ status: string }>>;
    },
    refetchInterval: 60000,
    staleTime: 50000,
  });

  const { data: cluster } = useQuery({
    queryKey: ["health", "cluster"],
    queryFn: async () => {
      const res = await fetch("/api/health/cluster");
      if (!res.ok) return { status: "unknown" };
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
  const issueCount = Math.max(0, totalPods - runningPods) + (isHealthy ? 0 : 1);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-[#0f172a]/70 px-4 py-2 text-xs text-slate-400 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div className={cn(
          "h-2 w-2 rounded-full",
          issueCount === 0 ? "bg-emerald-400 live-dot" : "bg-amber-400"
        )} />
        <span className={cn("font-medium", issueCount === 0 ? "text-emerald-300" : "text-amber-200")}>
          {issueCount === 0 ? "All systems operational" : `⚠ ${issueCount} issue${issueCount === 1 ? "" : "s"} detected`}
        </span>
        {totalPods > 0 ? <span className="text-slate-500">{runningPods}/{totalPods} pods running</span> : null}
      </div>
      <div className="flex items-center gap-4 text-slate-500">
        <span>Cluster {isHealthy ? "healthy" : "degraded"}</span>
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
  const { addons } = useAddons();
  const { permissions, assignments } = useRBAC();

  const accessibleNavGroups = useMemo(
    () => filterNavGroupsByPermissions(NAV_GROUPS, permissions, assignments),
    [assignments, permissions],
  );
  const filteredNavGroups = useMemo(
    () => filterNavGroupsByAddons(accessibleNavGroups, addons),
    [accessibleNavGroups, addons],
  );
  const favoriteNavItems = useMemo(
    () => filterNavItemsByPermissions(NAV_FAVORITE_ITEMS, permissions, assignments),
    [assignments, permissions],
  );

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenGroups(prev => ({ ...prev, [activeGroupId]: true }));
    }
  }, [pathname, filteredNavGroups]);
  const [sessionWarning, setSessionWarning] = useState(false);
  const [countdown, setCountdown] = useState(300);
  const [searchOpen, setSearchOpen] = useState(false);
  const { recentPages } = useRecentPages();
  const [mobileFavorites, setMobileFavorites] = useState<string[]>(() => loadFavorites());

  const sanitizeMobileFavorites = (ids: string[]) =>
    ids
      .filter((href, index, values) => values.indexOf(href) === index)
      .filter((href) => favoriteNavItems.some((item) => item.href === href))
      .slice(0, MAX_NAV_FAVORITES);

  const updateMobileFavorites = (
    updater: string[] | ((previous: string[]) => string[]),
  ) => {
    setMobileFavorites((previous) => {
      const next = sanitizeMobileFavorites(
        typeof updater === "function" ? updater(previous) : updater,
      );
      saveFavorites(next);
      return next;
    });
  };

  const mobileNavItems = useMemo(
    () =>
      mobileFavorites
        .map((href) => favoriteNavItems.find((item) => item.href === href))
        .filter((item): item is (typeof favoriteNavItems)[number] => Boolean(item)),
    [favoriteNavItems, mobileFavorites],
  );

  const toggleMobileFavorite = (href: string) => {
    updateMobileFavorites((previous) =>
      previous.includes(href)
        ? previous.filter((entry) => entry !== href)
        : previous.length < MAX_NAV_FAVORITES
          ? [...previous, href]
          : previous,
    );
  };

  const moveMobileFavorite = (href: string, direction: -1 | 1) => {
    updateMobileFavorites((previous) => {
      const index = previous.indexOf(href);
      if (index === -1) return previous;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileOpen(false);
    setMoreOpen(false);
    setSearchOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = `${titleForPathname(pathname)} • InfraWeaver`;
  }, [pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (status === "loading") {
    return (
      <div className="flex h-screen bg-[#0f0f0f]">
        <div className="hidden w-[220px] flex-shrink-0 border-r border-[#2a2a2a] bg-[#141414] md:block" />
        <div className="flex-1 space-y-4 p-6">
          <div className="h-12 rounded-xl bg-white/5 animate-pulse" />
          <div className="h-9 rounded-xl bg-white/5 animate-pulse" />
          <div className="grid gap-4 md:grid-cols-3">
            <div className="h-32 rounded-2xl bg-white/5 animate-pulse" />
            <div className="h-32 rounded-2xl bg-white/5 animate-pulse" />
            <div className="h-32 rounded-2xl bg-white/5 animate-pulse" />
          </div>
          <div className="h-[320px] rounded-2xl bg-white/5 animate-pulse" />
        </div>
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
              className="fixed inset-0 z-40 bg-black/70 hidden sm:block md:hidden"
              style={{ touchAction: "pan-y" }}
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
              className="fixed left-0 top-0 bottom-0 z-50 hidden sm:flex md:hidden w-[300px] bg-[#111] border-r border-[#222] flex-col flex-shrink-0 overflow-hidden"
              style={{ touchAction: "pan-y" }}
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
              <div
                className="flex-1 overflow-y-auto overflow-x-hidden pt-2 pb-2 [-webkit-overflow-scrolling:touch]"
                onPointerDown={(e) => e.stopPropagation()}
                style={{ touchAction: "pan-y" }}
              >
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
        <StatusBar />
        <Breadcrumb />
        <main
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 pb-24 sm:pb-4 md:p-6 md:pb-6"
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
      </div>

      {/* Floating Action Button (mobile) */}
      <FloatingActionButton />

      {/* Bottom mobile nav — Home | Apps | Game Hub | Pods | Menu */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-[#2a2a2a] bg-[#141414]/95 backdrop-blur sm:hidden landscape-hide pb-safe"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}
      >
        {mobileNavItems.map(item => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => { if (typeof navigator !== "undefined") navigator.vibrate?.(10); setMoreOpen(false); }}
              className={cn(
                "flex-1 flex min-h-[56px] flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] transition-colors touch-manipulation",
                isActive ? "text-[#0078D4]" : "text-[#666] hover:text-[#9e9e9e]"
              )}
            >
              <item.icon className="h-5 w-5 min-[380px]:h-4 min-[380px]:w-4" />
              <span className="hidden min-[380px]:block">{item.label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => { if (typeof navigator !== "undefined") navigator.vibrate?.(10); setMoreOpen(true); }}
          className={cn(
            "flex-1 flex min-h-[56px] flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] transition-colors touch-manipulation",
            moreOpen ? "text-[#0078D4]" : "text-[#666] hover:text-[#9e9e9e]"
          )}
        >
          <MoreHorizontal className="h-5 w-5 min-[380px]:h-4 min-[380px]:w-4" />
          <span className="hidden min-[380px]:block">More</span>
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
              className="fixed inset-0 z-[200] bg-black/70 sm:hidden"
              style={{ touchAction: "pan-y" }}
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
              className="fixed inset-0 z-[201] bg-[#111] sm:hidden flex flex-col overflow-hidden shadow-2xl"
              style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)", touchAction: "pan-y" }}
            >
              <div className="flex-shrink-0 pt-[calc(env(safe-area-inset-top,0px)+8px)]" />

              {/* Header row */}
              <div className="flex-shrink-0 flex items-center justify-between px-4 pt-1 pb-2.5">
                <div>
                  <h2 className="text-base font-semibold text-white leading-tight">Menu</h2>
                  <p className="text-[10px] text-[#555] mt-0.5">{filteredNavGroups.reduce((n, g) => n + g.items.length, 0)} pages grouped for quick access</p>
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

              <div className="flex-shrink-0 px-4 pb-3">
                <div className="rounded-2xl border border-[#222] bg-[#0d0d0d] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-[#f2f2f2]">Customize Navigation</h3>
                      <p className="mt-1 text-[11px] text-[#666]">
                        Choose up to {MAX_NAV_FAVORITES} favorites for the bottom bar.
                      </p>
                    </div>
                    <span className="rounded-full border border-[#2a2a2a] bg-[#111] px-2 py-1 text-[10px] text-[#888]">
                      {mobileFavorites.length}/{MAX_NAV_FAVORITES}
                    </span>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {favoriteNavItems.map((item) => {
                      const favoriteIndex = mobileFavorites.indexOf(item.href);
                      const isFavorite = favoriteIndex !== -1;
                      const disableAdd = !isFavorite && mobileFavorites.length >= MAX_NAV_FAVORITES;
                      return (
                        <div
                          key={item.href}
                          className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-[#141414]"
                        >
                          <input
                            type="checkbox"
                            checked={isFavorite}
                            disabled={disableAdd}
                            onChange={() => toggleMobileFavorite(item.href)}
                            className="h-4 w-4 rounded border border-[#333] bg-[#111] text-[#0078D4] disabled:opacity-40"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <item.icon className="h-4 w-4 flex-shrink-0 text-[#666]" />
                              <span className="truncate text-sm text-[#f2f2f2]">{item.label}</span>
                              {isFavorite && (
                                <span className="rounded-full border border-[#2a2a2a] bg-[#111] px-1.5 py-0.5 text-[10px] text-[#888]">
                                  #{favoriteIndex + 1}
                                </span>
                              )}
                            </div>
                            <span className="block truncate text-[11px] text-[#555]">{item.href}</span>
                          </div>
                          {isFavorite && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => moveMobileFavorite(item.href, -1)}
                                disabled={favoriteIndex === 0}
                                className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#111] text-[#888] transition-colors hover:text-white disabled:opacity-40"
                                aria-label={`Move ${item.label} up`}
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => moveMobileFavorite(item.href, 1)}
                                disabled={favoriteIndex === mobileFavorites.length - 1}
                                className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#111] text-[#888] transition-colors hover:text-white disabled:opacity-40"
                                aria-label={`Move ${item.label} down`}
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
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
              <div
                className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4 [-webkit-overflow-scrolling:touch]"
                onPointerDown={(e) => e.stopPropagation()}
                style={{ touchAction: "pan-y" }}
              >

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

              <div className="flex-shrink-0 border-t border-[#1e1e1e] px-4 pt-3 text-center">
                <p className="text-[10px] text-[#555]">InfraWeaver Console</p>
                <p className="mt-1 text-[10px] font-mono text-[#444]">
                  v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />

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
    </div>
    </SimpleModeProvider>
  );
}
