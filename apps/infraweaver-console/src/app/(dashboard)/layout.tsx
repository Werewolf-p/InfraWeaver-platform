"use client";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { FloatingActionButton } from "@/components/floating-action-button";
// Feedback now integrated into FloatingActionButton
import { ErrorBoundary } from "@/components/error-boundary";
import { Breadcrumb, titleForPathname } from "@/components/ui/breadcrumb";
import { useSession, signOut } from "next-auth/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import {
  X, AlertTriangle, MoreHorizontal, Search, Clock,
  ChevronDown, ChevronRight, Settings, LogOut, Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { SimpleModeProvider } from "@/contexts/simple-mode-context";
import { NAV_GROUPS } from "@/lib/nav-config";
import { OfflineIndicator } from "@/components/ui/offline-indicator";
import { KeyboardShortcutsProvider } from "@/components/ui/keyboard-shortcuts-modal";
import { GlobalSearch } from "@/components/search/global-search";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useAddons } from "@/hooks/use-addons";
import { useRBAC } from "@/hooks/use-rbac";
import { filterNavGroupsByAddons } from "@/lib/addons";
import { filterNavGroupsByPermissions } from "@/lib/navigation-rbac";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { useCluster } from "@/contexts/cluster-context";
import { ClusterSelector } from "@/components/layout/cluster-selector";

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

const GOTO_SHORTCUTS: Record<string, string> = {
  h: "/home",
  a: "/apps",
  p: "/pods",
  c: "/cluster",
  s: "/security",
  l: "/logs",
};

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

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
    <div className="hidden flex-wrap items-center justify-between gap-3 border-b border-gray-200 dark:border-white/5 bg-white/80 dark:bg-[#0f172a]/70 px-4 py-2 text-xs text-slate-600 dark:text-slate-400 backdrop-blur-sm sm:flex">
      <div className="flex items-center gap-3">
        <div className={cn(
          "h-2 w-2 rounded-full",
          issueCount === 0 ? "bg-emerald-500 dark:bg-emerald-400 live-dot" : "bg-amber-500 dark:bg-amber-400"
        )} />
        <span className={cn("font-medium", issueCount === 0 ? "text-emerald-600 dark:text-emerald-300" : "text-amber-600 dark:text-amber-200")}>
          {issueCount === 0 ? "All systems operational" : `⚠ ${issueCount} issue${issueCount === 1 ? "" : "s"} detected`}
        </span>
        {totalPods > 0 ? <span className="text-slate-600 dark:text-slate-500">{runningPods}/{totalPods} pods running</span> : null}
      </div>
      <div className="flex items-center gap-4 text-slate-600 dark:text-slate-500">
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
  const { activeId, activeCluster, clusters } = useCluster();
  const gotoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingGotoRef = useRef(false);

  const accessibleNavGroups = useMemo(
    () => filterNavGroupsByPermissions(NAV_GROUPS, permissions, assignments),
    [assignments, permissions],
  );
  const filteredNavGroups = useMemo(
    () => filterNavGroupsByAddons(accessibleNavGroups, addons),
    [accessibleNavGroups, addons],
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
      setOpenGroups(prev => {
        if (prev[activeGroupId]) return prev; // bail out — avoid creating a new object when nothing changes
        return { ...prev, [activeGroupId]: true };
      });
    }
  }, [pathname, filteredNavGroups]);
  const [sessionWarning, setSessionWarning] = useState(false);
  const [countdown, setCountdown] = useState(300);
  const [searchOpen, setSearchOpen] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const handlePullToRefresh = async () => {
    router.refresh();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 400);
    });
  };
  const { recentPages } = useRecentPages();
  const flatNavItems = useMemo(
    () => filteredNavGroups.flatMap((group) => group.items),
    [filteredNavGroups],
  );
  const mobilePrimaryNavItems = useMemo(
    () =>
      ["/home", "/game-hub", "/apps", "/cluster"]
        .map((href) => flatNavItems.find((item) => item.href === href))
        .filter((item): item is (typeof flatNavItems)[number] => Boolean(item)),
    [flatNavItems],
  );
  const mobilePrimaryNavHrefs = useMemo(
    () => new Set(mobilePrimaryNavItems.map((item) => item.href)),
    [mobilePrimaryNavItems],
  );
  const moreNavGroups = useMemo(
    () =>
      filteredNavGroups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => !mobilePrimaryNavHrefs.has(item.href)),
        }))
        .filter((group) => group.items.length > 0),
    [filteredNavGroups, mobilePrimaryNavHrefs],
  );

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
    return () => {
      if (gotoTimeoutRef.current) {
        clearTimeout(gotoTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const resetGotoShortcut = () => {
      pendingGotoRef.current = false;
      if (gotoTimeoutRef.current) {
        clearTimeout(gotoTimeoutRef.current);
        gotoTimeoutRef.current = null;
      }
    };

    const armGotoShortcut = () => {
      resetGotoShortcut();
      pendingGotoRef.current = true;
      gotoTimeoutRef.current = setTimeout(() => {
        pendingGotoRef.current = false;
        gotoTimeoutRef.current = null;
      }, 1200);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const typingTarget = isTypingTarget(event.target);
      const key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        resetGotoShortcut();
        setSearchOpen(true);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === "r" && !typingTarget) {
        event.preventDefault();
        resetGotoShortcut();
        router.refresh();
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "/" && !typingTarget) {
        event.preventDefault();
        resetGotoShortcut();
        setSearchOpen(true);
        return;
      }

      if (event.key === "Escape") {
        resetGotoShortcut();
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (moreOpen) {
          setMoreOpen(false);
          setMoreSearch("");
          setMoreCategory("all");
          return;
        }
        if (mobileOpen) {
          setMobileOpen(false);
          setDrawerSearch("");
        }
        return;
      }

      if (typingTarget || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (pendingGotoRef.current) {
        const destination = GOTO_SHORTCUTS[key];
        resetGotoShortcut();
        if (destination) {
          event.preventDefault();
          router.push(destination);
        }
        return;
      }

      if (!event.shiftKey && key === "g") {
        event.preventDefault();
        armGotoShortcut();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen, moreOpen, router, searchOpen]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    if (mobileOpen || moreOpen || searchOpen) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileOpen, moreOpen, searchOpen]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    // Scroll listener kept for potential future use (pull-to-refresh, etc.)
  }, [pathname]);

  if (status === "loading") {
    return (
      <div className="flex h-screen bg-white dark:bg-[#0f0f0f]">
        <div className="hidden w-[220px] flex-shrink-0 border-r border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] md:block" />
        <div className="flex-1 space-y-4 px-4 py-4 sm:p-6">
          <div className="h-12 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />
          <div className="h-9 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
            <div className="h-32 rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />
            <div className="h-32 rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />
            <div className="h-32 rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />
          </div>
          <div className="h-[320px] rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <SimpleModeProvider>
    <a
      href="#dashboard-main"
      className="sr-only fixed left-4 top-4 z-[9999] rounded-lg bg-[#0078D4] px-3 py-2 text-sm font-medium text-white focus:not-sr-only"
    >
      Skip to content
    </a>
    <div className="flex h-[100dvh] w-full overflow-hidden overflow-x-hidden bg-white dark:bg-[#0f0f0f]">
      <OfflineIndicator />
      {/* Desktop Sidebar */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

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
              className="fixed left-0 top-0 bottom-0 z-50 flex w-[min(86vw,320px)] flex-col overflow-hidden border-r border-gray-200 dark:border-[#222] bg-white dark:bg-[#111] md:hidden"
              style={{ touchAction: "pan-y" }}
            >
              {/* ── ITER 1: Header with branding + cluster health dot ── */}
              <div className="flex-shrink-0 flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+14px)] pb-3 border-b border-gray-200 dark:border-[#222]">
                <div className="flex items-center gap-2.5">
                  <div className="relative w-7 h-7 rounded-lg bg-[#0078D4] flex items-center justify-center flex-shrink-0">
                    <span className="text-gray-900 dark:text-white text-[10px] font-bold">IW</span>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#111]" />
                  </div>
                  <div>
                    <div className="text-base font-semibold leading-tight text-gray-900 dark:text-white">InfraWeaver</div>
                    <div className="text-sm leading-tight text-gray-500 dark:text-[#777]">Management Console</div>
                  </div>
                </div>
                <button
                  onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 dark:text-[#666] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] hover:text-gray-900 dark:hover:text-white touch-manipulation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* ── ITER 1: Search ── */}
              <div className="flex-shrink-0 px-3 py-2.5 border-b border-gray-200 dark:border-[#1e1e1e]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
                  <input
                    value={drawerSearch}
                    onChange={e => setDrawerSearch(e.target.value)}
                    placeholder="Search pages…"
                    className="w-full bg-white dark:bg-[#0d0d0d] border border-gray-200 dark:border-[#2a2a2a] rounded-xl pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50"
                  />
                  {drawerSearch && (
                    <button onClick={() => setDrawerSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 touch-manipulation">
                      <X className="w-3.5 h-3.5 text-gray-400 dark:text-[#555] hover:text-gray-900 dark:hover:text-white" />
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
                  <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-[#444] mb-1.5 px-1">Recent</p>
                  <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" style={{ touchAction: "pan-x" }}>
                    {recentPages.slice(0, 4).map((page: { href: string; title: string }) => (
                      <Link key={page.href} href={page.href} onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}>
                        <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white dark:bg-[#1a1a1a] border border-[#252525] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white hover:border-[#333] transition-colors whitespace-nowrap touch-manipulation">
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
                    {moreNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(drawerSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(drawerSearch.toLowerCase())
                    ).map(item => {
                      const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                      return (
                        <Link key={item.href} href={item.href} onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}>
                          <div className={cn(
                            "flex items-center gap-3 px-3 py-3 rounded-xl transition-all min-h-[52px] touch-manipulation mb-0.5",
                            isActive ? "bg-[rgba(0,120,212,0.15)]" : "hover:bg-gray-100 dark:hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                          )}>
                            <div className={cn(
                              "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0",
                              isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-white dark:bg-[#1a1a1a]"
                            )}>
                              <item.icon className={cn("w-[18px] h-[18px]", isActive ? "text-[#0078D4]" : "text-gray-500 dark:text-[#777]")} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={cn("text-sm font-medium truncate", isActive ? "text-[#0078D4]" : "text-gray-600 dark:text-[#ccc]")}>{item.label}</div>
                              {item.description && <div className="text-[10px] text-gray-400 dark:text-[#555] truncate">{item.description}</div>}
                            </div>
                            {isActive && <div className="w-1.5 h-1.5 rounded-full bg-[#0078D4] flex-shrink-0" />}
                          </div>
                        </Link>
                      );
                    })}
                    {moreNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(drawerSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(drawerSearch.toLowerCase())
                    ).length === 0 && (
                      <div className="py-8 text-center text-gray-400 dark:text-[#444] text-sm">No results for &ldquo;{drawerSearch}&rdquo;</div>
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
                          hasActiveItem ? "text-gray-900 dark:text-white" : "text-gray-500 dark:text-[#777] hover:text-gray-700 dark:hover:text-[#bbb] hover:bg-gray-100 dark:hover:bg-[#161616]"
                        )}
                        style={{ width: "calc(100% - 8px)" }}
                      >
                        {/* Colored accent dot */}
                        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", accent)} />
                        <group.icon className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className={cn("text-[11px] font-semibold uppercase tracking-wider flex-1 text-left", hasActiveItem && "text-gray-900 dark:text-white")}>
                          {group.label}
                        </span>
                        {/* Item count badge */}
                        <span className="text-[9px] font-mono bg-gray-50 dark:bg-[#1e1e1e] border border-gray-200 dark:border-[#2a2a2a] px-1.5 py-0.5 rounded-full text-gray-400 dark:text-[#555]">
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
                            <div className="ml-4 pl-4 border-l border-gray-200 dark:border-[#1e1e1e] space-y-0.5 pb-1.5 pr-2">
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
                                          : "hover:bg-gray-100 dark:hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                                      )}>
                                        <div className={cn(
                                          "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors",
                                          isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#181818]"
                                        )}>
                                          <item.icon className={cn("w-4 h-4", isActive ? "text-[#0078D4]" : "text-gray-400 dark:text-[#666]")} />
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
              <div className="flex-shrink-0 border-t border-gray-200 dark:border-[#1e1e1e]" style={{ paddingBottom: "calc(env(safe-area-inset-bottom,0px) + 6px)" }}>
                <div className="px-4 pt-3 pb-1">
                  <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-[#444] mb-1.5">Active Cluster</p>
                  <ClusterSelector popupDirection="up" />
                </div>
                {/* User row */}
                <Link href="/profile" onClick={() => { setMobileOpen(false); setDrawerSearch(""); }}>
                  <div className="flex items-center gap-3 px-4 py-3 hover:bg-[#181818] transition-colors touch-manipulation">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#0078D4]/30 to-[#0078D4]/10 border border-[#0078D4]/25 flex items-center justify-center flex-shrink-0">
                      <span className="text-[#0078D4] text-sm font-bold">
                        {(session?.user?.name ?? session?.user?.email ?? "U").slice(0, 1).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-gray-700 dark:text-[#d4d4d4] truncate leading-tight">
                        {session?.user?.name ?? "User"}
                      </div>
                      <div className="text-[10px] text-gray-400 dark:text-[#444] truncate leading-tight mt-0.5">
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
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-gray-400 dark:text-[#555] hover:text-[#999] hover:bg-[#181818] transition-colors touch-manipulation text-[11px]"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span>Settings</span>
                  </Link>
                  <button
                    onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-gray-400 dark:text-[#555] hover:text-red-400 hover:bg-[#1a1010] transition-colors touch-manipulation text-[11px]"
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

      <div className="relative z-10 flex min-w-0 w-full flex-1 flex-col overflow-hidden overflow-x-hidden">
        <TopBar onMenuClick={() => setMobileOpen(true)} onSearchClick={() => setSearchOpen(true)} />
        <StatusBar />
        <Breadcrumb className="hidden sm:flex" />
        {/* Cluster context banner — only shown when a non-primary cluster is active or "all" mode */}
        {(activeId === "all" || (clusters.length > 1 && activeCluster)) && (
          <div className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-xs border-b",
            activeId === "all"
              ? "border-blue-500/20 bg-blue-500/8 text-blue-300"
              : "border-amber-500/20 bg-amber-500/8 text-amber-300",
          )}>
            <Server className="h-3 w-3 flex-shrink-0" />
            {activeId === "all" ? (
              <span>Viewing <strong>all {clusters.length} clusters</strong> — select a cluster from the top bar to manage it</span>
            ) : (
              <span>Managing cluster: <strong>{activeCluster!.name}</strong>{activeCluster!.description ? ` — ${activeCluster!.description}` : ""}</span>
            )}
          </div>
        )}
        <div className="hidden xl:flex items-center justify-between gap-3 border-b border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#101010] px-6 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gray-400 dark:text-[#555]">Recent</span>
            {recentPages.length > 0 ? (
              recentPages.slice(0, 4).map((page) => (
                <Link
                  key={`${page.href}-${page.visitedAt}`}
                  href={page.href}
                  className="truncate rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] px-3 py-1 text-xs text-gray-500 dark:text-[#9e9e9e] transition-colors hover:border-[#0078D4]/40 hover:text-gray-900 dark:hover:text-white"
                >
                  {page.title}
                </Link>
              ))
            ) : (
              <span className="text-xs text-gray-400 dark:text-[#666]">Use quick search to jump between dashboards and operator tools.</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] px-3 py-1.5 text-xs text-gray-500 dark:text-[#9e9e9e] transition-colors hover:border-[#0078D4]/40 hover:text-gray-900 dark:hover:text-white"
          >
            Quick search
            <span className="rounded-md border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-1.5 py-0.5 font-mono text-[10px] text-gray-400 dark:text-[#666]">/</span>
          </button>
        </div>
        <main
          id="dashboard-main"
          ref={mainRef}
          className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 pb-28 sm:px-4 sm:py-4 sm:pb-4 md:p-6 md:pb-6"
        >
          <PullToRefresh onRefresh={handlePullToRefresh} className="min-h-full">
            <AnimatePresence mode="wait">
              <motion.div
                key={pathname}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ type: "spring", stiffness: 260, damping: 24, mass: 1 }}
                className="min-w-0"
              >
                <ErrorBoundary>
                  {children}
                </ErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </PullToRefresh>
        </main>
      </div>

      {/* Unified Floating Action Button (includes feedback + back-to-top) */}
      <FloatingActionButton />

      {/* Bottom mobile nav — Home | Game Hub | Apps | Cluster | More */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 flex gap-1 border-t border-gray-200 dark:border-[#2a2a2a] bg-[#141414]/95 px-2 pt-2 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}
      >
        {mobilePrimaryNavItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => { if (typeof navigator !== "undefined") navigator.vibrate?.(10); setMoreOpen(false); }}
              className={cn(
                "relative flex min-h-[58px] flex-1 flex-col items-center justify-center rounded-2xl px-2 py-2 text-[10px] transition-colors touch-manipulation",
                isActive ? "bg-[#0078D4]/10 text-[#4db3ff]" : "text-gray-400 dark:text-[#666] hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-700 dark:hover:text-[#9e9e9e]",
              )}
            >
              {isActive ? <span className="absolute top-2 h-1.5 w-1.5 rounded-full bg-[#0078D4]" /> : null}
              <item.icon className="h-4 w-4" />
              <span className="mt-1 truncate">{item.label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => { if (typeof navigator !== "undefined") navigator.vibrate?.(10); setMoreOpen(true); }}
          className={cn(
            "relative flex min-h-[58px] flex-1 flex-col items-center justify-center rounded-2xl px-2 py-2 text-[10px] transition-colors touch-manipulation",
            moreOpen ? "bg-[#0078D4]/10 text-[#4db3ff]" : "text-gray-400 dark:text-[#666] hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-700 dark:hover:text-[#9e9e9e]",
          )}
        >
          {moreOpen ? <span className="absolute top-2 h-1.5 w-1.5 rounded-full bg-[#0078D4]" /> : null}
          <MoreHorizontal className="h-4 w-4" />
          <span className="mt-1">More</span>
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
              className="fixed inset-x-0 bottom-0 z-[201] flex max-h-[85vh] flex-col overflow-hidden rounded-t-[28px] border border-gray-200 dark:border-[#222] bg-white dark:bg-[#111] shadow-2xl sm:hidden"
              style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)", touchAction: "pan-y" }}
            >
              <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-gray-100 dark:bg-[#2a2a2a]" />

              {/* Header row */}
              <div className="flex-shrink-0 flex items-center justify-between px-4 pt-1 pb-2.5">
                <div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white leading-tight">Menu</h2>
                  <p className="text-[10px] text-gray-400 dark:text-[#555] mt-0.5">{moreNavGroups.reduce((n, g) => n + g.items.length, 0)} pages grouped for quick access</p>
                </div>
                <button
                  onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-50 dark:bg-[#1e1e1e] text-gray-400 dark:text-[#666] transition-colors hover:bg-gray-100 dark:hover:bg-[#2a2a2a] hover:text-gray-900 dark:hover:text-white touch-manipulation"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Search */}
              <div className="flex-shrink-0 px-4 pb-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
                  <input
                    value={moreSearch}
                    onChange={e => { setMoreSearch(e.target.value); setMoreCategory("all"); }}
                    placeholder="Search all pages…"
                    className="w-full bg-white dark:bg-[#0d0d0d] border border-gray-200 dark:border-[#2a2a2a] rounded-xl pl-9 pr-3 py-2.5 text-sm text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#444] focus:outline-none focus:border-[#0078D4]/50"
                  />
                  {moreSearch && (
                    <button onClick={() => setMoreSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 touch-manipulation">
                      <X className="w-3.5 h-3.5 text-gray-400 dark:text-[#555] hover:text-gray-900 dark:hover:text-white" />
                    </button>
                  )}
                </div>
              </div>

              {/* Content — grid when category selected, list when searching */}
              <div
                className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4 [-webkit-overflow-scrolling:touch]"
                onPointerDown={(e) => e.stopPropagation()}
                style={{ touchAction: "pan-y" }}
              >

                {/* Recent pages (all + no search) */}
                {recentPages.length > 0 && !moreSearch && moreCategory === "all" && (
                  <div className="mb-4">
                    <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 dark:text-[#444] px-2 mb-2">Recently visited</p>
                    <div
                      className="flex gap-2 overflow-x-auto pb-1 scrollbar-none"
                      onPointerDown={e => e.stopPropagation()}
                      style={{ touchAction: "pan-x" }}
                    >
                      {recentPages.slice(0, 5).map((page: { href: string; title: string }) => (
                        <Link key={page.href} href={page.href} onClick={() => { setMoreOpen(false); setMoreCategory("all"); }}>
                          <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white dark:bg-[#1a1a1a] border border-[#232323] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white hover:border-[#333] transition-colors whitespace-nowrap touch-manipulation min-h-[36px]">
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
                    {moreNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(moreSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(moreSearch.toLowerCase())
                    ).map(item => {
                      const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                      return (
                        <Link key={item.href} href={item.href} onClick={() => { setMoreOpen(false); setMoreSearch(""); setMoreCategory("all"); }}>
                          <div className={cn(
                            "flex items-center gap-3 px-3 py-3 rounded-xl transition-colors min-h-[52px] touch-manipulation",
                            isActive ? "bg-[rgba(0,120,212,0.15)]" : "hover:bg-gray-100 dark:hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                          )}>
                            <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0", isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-white dark:bg-[#1a1a1a]")}>
                              <item.icon className={cn("w-[18px] h-[18px]", isActive ? "text-[#0078D4]" : "text-gray-500 dark:text-[#777]")} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={cn("text-sm font-medium truncate", isActive ? "text-[#4db3ff]" : "text-gray-600 dark:text-[#ccc]")}>{item.label}</div>
                              {item.description && <div className="text-[11px] text-gray-400 dark:text-[#555] truncate">{item.description}</div>}
                            </div>
                            {isActive && <div className="w-1.5 h-1.5 rounded-full bg-[#0078D4] flex-shrink-0" />}
                          </div>
                        </Link>
                      );
                    })}
                    {moreNavGroups.flatMap(g => g.items).filter(i =>
                      i.label.toLowerCase().includes(moreSearch.toLowerCase()) ||
                      (i.description ?? "").toLowerCase().includes(moreSearch.toLowerCase())
                    ).length === 0 && (
                      <div className="text-center py-10 text-gray-400 dark:text-[#444] text-sm">No results for &ldquo;{moreSearch}&rdquo;</div>
                    )}
                  </div>
                )}

                {/* Category/All mode: section groups with 2-col grid */}
                {!moreSearch && moreNavGroups.filter(g => moreCategory === "all" || g.id === moreCategory).map(group => {
                  const accent = GROUP_ACCENT[group.id] ?? "bg-[#555]";
                  return (
                    <div key={group.id} className="mb-5">
                      {/* Section header */}
                      <div className="flex items-center gap-2 px-1 mb-2.5">
                        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", accent)} />
                        <group.icon className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-[#555]">{group.label}</p>
                        <span className="text-[9px] font-mono text-gray-400 dark:text-[#444] bg-white dark:bg-[#1a1a1a] px-1.5 py-0.5 rounded-full">{group.items.length}</span>
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
                                  : "bg-gray-50 dark:bg-[#161616] border border-gray-200 dark:border-[#1e1e1e] hover:border-[#2a2a2a] hover:bg-gray-100 dark:hover:bg-[#1a1a1a] active:bg-[#1e1e1e]"
                              )}>
                                <div className={cn(
                                  "w-8 h-8 rounded-lg flex items-center justify-center",
                                  isActive ? "bg-[rgba(0,120,212,0.2)]" : "bg-[#202020]"
                                )}>
                                  <item.icon className={cn("w-4 h-4", isActive ? "text-[#4db3ff]" : "text-gray-400 dark:text-[#666]")} />
                                </div>
                                <div className="min-w-0">
                                  <div className={cn("text-[12px] font-medium leading-tight truncate", isActive ? "text-[#4db3ff]" : "text-gray-600 dark:text-[#ccc]")}>{item.label}</div>
                                  {item.description && (
                                    <div className="text-[9px] text-gray-400 dark:text-[#444] leading-tight mt-0.5 line-clamp-2">{item.description}</div>
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

              <div className="flex-shrink-0 border-t border-gray-200 dark:border-[#1e1e1e] px-4 pt-3 text-center">
                <p className="text-[10px] text-gray-400 dark:text-[#555]">InfraWeaver Console</p>
                <p className="mt-1 text-[10px] font-mono text-gray-400 dark:text-[#444]">
                  v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />

      {/* Session timeout warning modal */}
      <AnimatePresence>
        {sessionWarning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-end justify-center px-0 sm:items-center sm:px-4"
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.15 }}
              className="relative w-full rounded-t-2xl border border-gray-200 dark:border-[#333] bg-white dark:bg-[#1a1a1a] px-5 pt-5 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] text-center shadow-2xl sm:max-w-sm sm:rounded-xl sm:p-6"
            >
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-yellow-500/20 bg-yellow-500/10">
                <AlertTriangle className="h-6 w-6 text-yellow-400" />
              </div>
              <h2 className="mb-1 text-lg font-semibold text-gray-900 dark:text-white">Session expiring soon</h2>
              <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
                Your session will expire in{" "}
                <span className="font-mono text-yellow-400">
                  {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
                </span>
              </p>
              <div className="mb-6 flex justify-center">
                <div className="relative h-16 w-16">
                  <svg className="h-16 w-16 -rotate-90" viewBox="0 0 64 64">
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
              <div className="flex flex-col-reverse gap-3 sm:flex-row">
                <button
                  onClick={() => signOut({ callbackUrl: "/auth/signin" })}
                  className="inline-flex h-11 flex-1 items-center justify-center rounded-lg border border-gray-200 dark:border-[#333] bg-gray-100 dark:bg-[#2a2a2a] px-4 text-sm font-medium text-gray-500 dark:text-[#9e9e9e] transition-colors hover:bg-[#333]"
                >
                  Sign Out
                </button>
                <button
                  onClick={async () => {
                    await fetch("/api/auth/session");
                    setSessionWarning(false);
                  }}
                  className="inline-flex h-11 flex-1 items-center justify-center rounded-lg bg-[#0078D4] px-4 text-sm font-medium text-white transition-colors hover:bg-[#1a86d9]"
                >
                  Extend Session
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <KeyboardShortcutsProvider />
    </div>
    </SimpleModeProvider>
  );
}
