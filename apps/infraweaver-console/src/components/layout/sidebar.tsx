"use client";
import { motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ChevronDown, Search, Star, Clock, Grid3X3, X, LogOut } from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";
import { useSession, signOut } from "next-auth/react";
import { useFavorites } from "@/hooks/use-favorites";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { NAV_GROUPS, ALL_NAV_ITEMS, type NavItem } from "@/lib/nav-config";

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-[rgba(0,120,212,0.2)] text-[#0078D4] border-[rgba(0,120,212,0.3)]",
  operator: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  viewer: "bg-[#2a2a2a] text-[#9e9e9e] border-[#333]",
  unknown: "bg-[#2a2a2a] text-[#666] border-[#333]",
};

function ClusterHealthDot() {
  const { data } = useQuery({
    queryKey: ["health", "cluster"],
    queryFn: async () => {
      const res = await fetch("/api/health/cluster");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ status: string }>;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const colors: Record<string, string> = {
    healthy: "bg-green-500",
    degraded: "bg-red-500",
    progressing: "bg-yellow-500 animate-pulse",
    unknown: "bg-[#555]",
  };
  return <span className={cn("absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[#141414]", colors[data?.status ?? "unknown"])} />;
}

function NavItemRow({ item, isActive, collapsed }: { item: NavItem; isActive: boolean; collapsed: boolean }) {
  const { isFavorite, toggleFavorite } = useFavorites();
  const fav = isFavorite(item.href);

  return (
    <div className="group relative flex items-center">
      <Link
        href={item.href}
        title={collapsed ? item.label : undefined}
        className={cn(
          "flex items-center gap-2.5 rounded text-sm transition-all w-full",
          collapsed ? "justify-center px-2 py-2" : "px-3 py-1.5",
          isActive
            ? collapsed
              ? "bg-[rgba(0,120,212,0.15)] text-[#0078D4]"
              : "bg-[rgba(0,120,212,0.15)] text-[#0078D4] border-l-2 border-[#0078D4] pl-[10px] font-medium"
            : "text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#2a2a2a]"
        )}
      >
        <item.icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-[#0078D4]" : "text-[#666] group-hover:text-[#9e9e9e]")} />
        {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
        {!collapsed && item.shortcut && (
          <kbd className="hidden xl:flex text-[10px] text-[#555] font-mono">{item.shortcut}</kbd>
        )}
      </Link>
      {!collapsed && (
        <button
          onClick={(e) => { e.stopPropagation(); toggleFavorite({ id: item.href, href: item.href, label: item.label, iconName: item.label }); }}
          className={cn(
            "absolute right-8 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity",
            fav ? "opacity-100 text-yellow-400" : "text-[#555] hover:text-yellow-400"
          )}
          title={fav ? "Unpin" : "Pin to favorites"}
        >
          <Star className={cn("w-3 h-3", fav && "fill-yellow-400")} />
        </button>
      )}
    </div>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return { overview: true, apps: true, compute: false, infrastructure: false, operations: false, monitoring: false, services: false, tools: false };
    try {
      const stored = localStorage.getItem("infraweaver_nav_sections");
      if (stored) return JSON.parse(stored) as Record<string, boolean>;
    } catch { /* ignore */ }
    return { overview: true, apps: true, compute: false, infrastructure: false, operations: false, monitoring: false, services: false, tools: false };
  });
  const pathname = usePathname();
  const { role } = useRBAC();
  const { data: session } = useSession();
  const { favorites } = useFavorites();
  const { recentPages, addRecentPage } = useRecentPages();
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

  const toggleSection = (id: string) => {
    setOpenSections(prev => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem("infraweaver_nav_sections", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  useEffect(() => {
    const match = ALL_NAV_ITEMS.find(item =>
      item.href === "/" ? pathname === "/" : item.href !== "/" && pathname.startsWith(item.href)
    );
    if (match) addRecentPage(match.href, match.label);
  }, [pathname, addRecentPage]);

  const filteredItems = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    return ALL_NAV_ITEMS.filter(item =>
      item.label.toLowerCase().includes(q) || item.description?.toLowerCase().includes(q)
    );
  }, [search]);

  const favItems = ALL_NAV_ITEMS.filter(item => favorites.some(f => f.href === item.href));
  const recentItems = ALL_NAV_ITEMS.filter(item =>
    recentPages.some((r: { href: string }) => r.href === item.href) && !favorites.some(f => f.href === item.href)
  ).slice(0, 3);

  const userName = session?.user?.name ?? session?.user?.email ?? "User";
  const userInitial = userName.charAt(0).toUpperCase();

  return (
    <motion.aside
      animate={{ width: collapsed ? 48 : 220 }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
      className="relative flex flex-col h-screen bg-[#141414] border-r border-[#2a2a2a] flex-shrink-0 overflow-hidden z-20 hidden md:flex"
    >
      {/* Logo / Header */}
      <div className={cn("flex items-center px-3 py-3 border-b border-[#2a2a2a] flex-shrink-0", collapsed ? "justify-center" : "gap-2 justify-between")}>
        {!collapsed && (
          <Link href="/" className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded bg-[#0078D4] flex items-center justify-center flex-shrink-0 relative">
              <span className="text-white text-xs font-bold">IW</span>
              <ClusterHealthDot />
            </div>
            <span className="font-bold text-[#f2f2f2] text-sm truncate">InfraWeaver</span>
          </Link>
        )}
        {collapsed && (
          <div className="w-7 h-7 rounded bg-[#0078D4] flex items-center justify-center relative">
            <span className="text-white text-xs font-bold">IW</span>
            <ClusterHealthDot />
          </div>
        )}
        <button
          onClick={() => setCollapsed(c => !c)}
          className={cn("p-1 rounded text-[#666] hover:text-[#f2f2f2] hover:bg-[#2a2a2a] transition-colors flex-shrink-0", collapsed && "mx-auto mt-2")}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* Search (expanded only) */}
      {!collapsed && (
        <div className="px-2 pt-3 pb-1 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter..."
              className="w-full bg-[#0f0f0f] border border-[#333] rounded pl-8 pr-3 py-1.5 text-xs text-[#f2f2f2] placeholder:text-[#555] focus:outline-none focus:border-[#0078D4]/50"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                <X className="w-3 h-3 text-[#555] hover:text-[#f2f2f2]" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Nav content - scrollable */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-2 px-2 scrollbar-none">

        {/* Search results */}
        {filteredItems !== null && !collapsed && (
          <div className="mb-3">
            <p className="px-2 py-1 text-[10px] text-[#555] uppercase tracking-wider">{filteredItems.length} results</p>
            <div className="space-y-0.5">
              {filteredItems.map(item => {
                const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return <NavItemRow key={item.href} item={item} isActive={isActive} collapsed={false} />;
              })}
              {filteredItems.length === 0 && (
                <p className="px-3 py-2 text-xs text-[#555]">No pages match &ldquo;{search}&rdquo;</p>
              )}
            </div>
          </div>
        )}

        {/* Favorites */}
        {!collapsed && filteredItems === null && favItems.length > 0 && (
          <div className="mb-3">
            <div className="px-3 py-1 flex items-center gap-1.5">
              <Star className="w-3 h-3 text-yellow-500/60" />
              <span className="text-[10px] font-semibold text-[#555] uppercase tracking-wider">Pinned</span>
            </div>
            <div className="space-y-0.5">
              {favItems.map(item => {
                const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return <NavItemRow key={item.href} item={item} isActive={isActive} collapsed={false} />;
              })}
            </div>
          </div>
        )}

        {/* Recent */}
        {!collapsed && filteredItems === null && recentItems.length > 0 && (
          <div className="mb-3">
            <div className="px-3 py-1 flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-[#555]" />
              <span className="text-[10px] font-semibold text-[#555] uppercase tracking-wider">Recent</span>
            </div>
            <div className="space-y-0.5">
              {recentItems.map(item => {
                const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return <NavItemRow key={item.href} item={item} isActive={isActive} collapsed={false} />;
              })}
            </div>
          </div>
        )}

        {/* Group separator */}
        {!collapsed && filteredItems === null && (favItems.length > 0 || recentItems.length > 0) && (
          <div className="mx-2 border-b border-[#2a2a2a] my-2" />
        )}

        {/* Main nav groups - COLLAPSIBLE accordion */}
        {filteredItems === null && NAV_GROUPS.filter(g => g.id !== "settings").map(group => {
          if (collapsed) {
            return (
              <div key={group.id} className="py-0.5">
                {group.items.map(item => {
                  const isActive = item.href === "/" ? pathname === "/" : item.href !== "/" && pathname.startsWith(item.href);
                  return (
                    <Link key={item.href} href={item.href} title={item.label}
                      className={cn("w-8 h-8 mx-auto flex items-center justify-center rounded transition-all",
                        isActive ? "bg-[rgba(0,120,212,0.15)] text-[#0078D4]" : "text-[#666] hover:text-[#f2f2f2] hover:bg-[#2a2a2a]"
                      )}>
                      <item.icon className="w-4 h-4" />
                    </Link>
                  );
                })}
                <div className="mx-2 border-b border-[#2a2a2a] my-1.5" />
              </div>
            );
          }
          const isOpen = openSections[group.id] !== false;
          return (
            <div key={group.id} className="mb-0.5">
              <button
                onClick={() => toggleSection(group.id)}
                className="w-full flex items-center gap-1.5 px-3 py-1 mt-1.5 mb-0.5 text-[10px] text-[#666] uppercase tracking-widest hover:text-[#9e9e9e] transition-colors select-none"
              >
                <span className="flex-1 text-left">{group.label}</span>
                <ChevronDown className={cn("w-3 h-3 transition-transform", isOpen && "rotate-180")} />
              </button>
              {isOpen && (
                <div className="space-y-0.5">
                  {group.items.map(item => {
                    const isActive = item.href === "/" ? pathname === "/" : item.href !== "/" && pathname.startsWith(item.href);
                    return <NavItemRow key={item.href} item={item} isActive={isActive} collapsed={false} />;
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* All Services link */}
        {!collapsed && filteredItems === null && (
          <div className="pt-1">
            <Link
              href="/all-services"
              className={cn(
                "flex items-center gap-2.5 px-3 py-1.5 rounded text-sm transition-all w-full",
                pathname === "/all-services"
                  ? "bg-[rgba(0,120,212,0.15)] text-[#0078D4] border-l-2 border-[#0078D4] pl-[10px] font-medium"
                  : "text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#2a2a2a]"
              )}
            >
              <Grid3X3 className="w-4 h-4 flex-shrink-0" />
              <span>All Services</span>
            </Link>
          </div>
        )}
      </div>

      {/* Settings group (always at bottom) */}
      {!collapsed && (
        <div className="px-2 py-2 border-t border-[#2a2a2a] flex-shrink-0 space-y-0.5">
          {NAV_GROUPS.find(g => g.id === "settings")?.items.map(item => {
            const isActive = pathname === item.href;
            return <NavItemRow key={item.href} item={item} isActive={isActive} collapsed={false} />;
          })}
        </div>
      )}

      {/* User footer */}
      <div className={cn("px-2 py-3 border-t border-[#2a2a2a] flex-shrink-0", collapsed ? "flex justify-center" : "flex items-center gap-2")}>
        <div className="relative flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-[#0078D4] flex items-center justify-center text-white text-xs font-bold">
            {userInitial}
          </div>
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium text-[#f2f2f2] truncate">{userName}</p>
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border capitalize font-medium", ROLE_COLORS[role] ?? ROLE_COLORS.unknown)}>
                {role}
              </span>
            </div>
            <p className="text-[10px] text-[#555] font-mono">v{appVersion}</p>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={() => signOut()}
            className="p-1 rounded text-[#555] hover:text-[#f2f2f2] hover:bg-[#2a2a2a] transition-colors flex-shrink-0"
            title="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </motion.aside>
  );
}
