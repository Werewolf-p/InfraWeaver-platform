"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Search, Star, ArrowRight, Grid3X3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, type NavItem } from "@/lib/nav-config";
import { useAddons } from "@/hooks/use-addons";
import { useFavorites } from "@/hooks/use-favorites";
import { useRBAC } from "@/hooks/use-rbac";
import { PageHeader } from "@/components/ui/page-header";
import { filterNavGroupsByAddons } from "@/lib/addons";
import { filterNavGroupsByPermissions } from "@/lib/navigation-rbac";

export default function AllServicesPage() {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { addons } = useAddons();
  const { permissions, assignments } = useRBAC();
  const { isFavorite, toggleFavorite } = useFavorites();

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const visibleNavGroups = useMemo(
    () => filterNavGroupsByAddons(filterNavGroupsByPermissions(NAV_GROUPS, permissions, assignments), addons),
    [addons, assignments, permissions],
  );

  const filteredGroups = useMemo(() => {
    if (!query.trim()) return visibleNavGroups;
    const q = query.toLowerCase();
    return visibleNavGroups.map(group => ({
      ...group,
      items: group.items.filter(item =>
        item.label.toLowerCase().includes(q) ||
        item.description?.toLowerCase().includes(q)
      ),
    })).filter(g => g.items.length > 0);
  }, [query, visibleNavGroups]);

  const totalShown = filteredGroups.reduce((s, g) => s + g.items.length, 0);
  const totalItems = visibleNavGroups.flatMap(g => g.items).length;

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-4 duration-300 p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader icon={Grid3X3} title="All Services" />
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-slate-500 text-xs mb-2">
          <Grid3X3 className="w-3.5 h-3.5" />
          <span>All Services</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">All Services</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Browse and search all {totalItems} pages and tools</p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search services..."
          className="w-full bg-slate-800/60 border border-gray-200 dark:border-white/10 rounded-xl pl-10 pr-4 py-3 text-gray-900 dark:text-white text-sm placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
        />
        {query && (
          <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-500">{totalShown} results</span>
        )}
      </div>

      {/* Groups */}
      <div className="space-y-8">
        {filteredGroups.map(group => (
          <div key={group.id}>
            <div className="flex items-center gap-2 mb-3">
              <group.icon className="w-4 h-4 text-slate-500" />
              <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{group.label}</h2>
              <span className="text-xs text-slate-600">{group.items.length}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {group.items.map(item => (
                <ServiceCard
                  key={item.href}
                  item={item}
                  isFav={isFavorite(item.href)}
                  onToggleFav={() => toggleFavorite({ id: item.href, href: item.href, label: item.label, iconName: item.label })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {filteredGroups.length === 0 && (
        <div className="text-center py-16">
          <Search className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">No services match &ldquo;{query}&rdquo;</p>
          <button onClick={() => setQuery("")} className="mt-2 text-xs text-indigo-400 hover:text-indigo-300">Clear search</button>
        </div>
      )}
    </div>
  );
}

function ServiceCard({ item, isFav, onToggleFav }: { item: NavItem; isFav: boolean; onToggleFav: () => void }) {
  return (
    <motion.div
      whileHover={{ scale: 1.01 }}
      className="group relative"
    >
      <Link
        href={item.href}
        className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/40 border border-gray-200 dark:border-white/5 hover:bg-slate-800/70 hover:border-indigo-500/30 transition-all"
      >
        <div className="w-8 h-8 rounded-lg bg-slate-700/60 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-500/20 transition-colors">
          <item.icon className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-indigo-400 transition-colors" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200 group-hover:text-white transition-colors truncate">{item.label}</span>
            {item.badge && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-medium">{item.badge}</span>}
          </div>
          {item.description && <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{item.description}</p>}
        </div>
        <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-indigo-400 transition-colors flex-shrink-0 mt-1" />
      </Link>
      <button
        onClick={(e) => { e.preventDefault(); onToggleFav(); }}
        className={cn(
          "absolute top-2.5 right-8 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-all",
          isFav ? "opacity-100 text-yellow-400" : "text-slate-500 hover:text-yellow-400"
        )}
        title={isFav ? "Remove from favorites" : "Add to favorites"}
      >
        <Star className={cn("w-3 h-3", isFav && "fill-yellow-400")} />
      </button>
    </motion.div>
  );
}
