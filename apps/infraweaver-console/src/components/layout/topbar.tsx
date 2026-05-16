"use client";
import { Menu, Search, Plus, ExternalLink, Clock3, Command, ChevronDown } from "lucide-react";
import { NotificationCenter } from "@/components/ui/notification-center";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { titleForPathname } from "@/components/ui/breadcrumb";
import { ClusterSelector } from "@/components/layout/cluster-selector";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { springs } from "@/lib/spring";

const QUICK_CREATE_ITEMS = [
  { label: "Deploy from Catalog", href: "/catalog-install" },
  { label: "Community App", href: "/community-apps" },
  { label: "Add DNS Record", href: "/dns" },
  { label: "Add Port Route", href: "/gameservers" },
];

const PAGE_CONTEXT = [
  { match: (pathname: string) => pathname.startsWith("/home"), description: "Platform services, launchpads, and status at a glance.", badge: "Service hub" },
  { match: (pathname: string) => pathname.startsWith("/apps"), description: "Installed apps, catalog installs, and community deployments.", badge: "Apps workspace" },
  { match: (pathname: string) => pathname.startsWith("/cluster"), description: "Node health, autoscaling, and workload movement controls.", badge: "Cluster control" },
  { match: (pathname: string) => pathname.startsWith("/storage"), description: "Longhorn capacity, replica health, and hot-volume visibility.", badge: "Storage watch" },
  { match: (_pathname: string) => true, description: "Use search to jump anywhere and keep production changes moving.", badge: "Operator mode" },
] as const;

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function TopBar({ onMenuClick, onSearchClick }: { title?: string; onMenuClick?: () => void; onSearchClick?: () => void }) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const currentTitle = titleForPathname(pathname);
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const [quickOpen, setQuickOpen] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [showChangelogDot, setShowChangelogDot] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("infraweaver:last-seen-version") !== appVersion;
    } catch {
      return false;
    }
  });
  const dropRef = useRef<HTMLDivElement>(null);
  const pageContext = useMemo(
    () => PAGE_CONTEXT.find((item) => item.match(pathname)) ?? PAGE_CONTEXT[PAGE_CONTEXT.length - 1],
    [pathname],
  );

  useEffect(() => {
    const updateClock = () => setClock(new Date());
    updateClock();
    const interval = window.setInterval(updateClock, 60000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(event.target as Node)) {
        setQuickOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQuickOpen(false);
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setQuickOpen((value) => !value);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    setQuickOpen(false);
  }, [pathname]);

  return (
    <header className="flex min-h-16 flex-shrink-0 items-center justify-between gap-3 border-b border-white/5 bg-black/60 backdrop-blur-xl px-3 sm:min-h-14 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <motion.button
          type="button"
          onClick={onMenuClick}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          transition={springs.micro}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[#9e9e9e] transition-colors hover:bg-[#2a2a2a] hover:text-[#f2f2f2] md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </motion.button>

        <Link href="/home" className="flex items-center gap-2 md:shrink-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0078D4] text-xs font-bold text-white shadow-[0_0_0_1px_rgba(255,255,255,0.06)]">
            IW
          </div>
          <div className="min-w-0 md:hidden">
            <p className="truncate text-xs font-semibold text-[#f2f2f2]">InfraWeaver</p>
            <p className="truncate text-[10px] text-[#666]">{currentTitle}</p>
          </div>
        </Link>

        <div className="hidden min-w-0 md:block">
          <div className="flex items-center gap-2">
            <motion.p
              key={currentTitle}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={springs.gentle}
              className="truncate text-sm font-semibold text-[#f2f2f2]"
            >
              {currentTitle}
            </motion.p>
            <span className="rounded-full border border-[#2a2a2a] bg-[#0f0f0f] px-2 py-0.5 text-[10px] font-mono text-[#666]">
              v{appVersion}
            </span>
          </div>
          <p className="truncate text-xs text-[#666]">{pageContext.description}</p>
        </div>

        <button
          type="button"
          onClick={onSearchClick}
          className="hidden max-w-xl flex-1 items-center gap-3 rounded-xl border border-[#333] bg-[#0f0f0f] px-3 py-2 text-sm text-[#666] transition-colors hover:border-[#555] hover:text-[#9e9e9e] md:flex"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search resources, pages, and commands…</span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#151515] px-2 py-1 text-[10px] font-mono text-[#888]">
            <Command className="h-3 w-3" />K
          </span>
        </button>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2">
        <div className="hidden xl:flex items-center gap-2 rounded-xl border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-xs text-[#888]">
          <Clock3 className="h-3.5 w-3.5 text-[#0078D4]" />
          <span className="font-medium text-[#f2f2f2]">
            {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
          </span>
          <span className="h-1 w-1 rounded-full bg-[#2a2a2a]" />
          <span>{pageContext.badge}</span>
        </div>

        <motion.button
          type="button"
          onClick={onSearchClick}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          transition={springs.micro}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[#9e9e9e] transition-colors hover:bg-[#2a2a2a] hover:text-[#f2f2f2] md:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </motion.button>

        <div className="relative hidden md:block" ref={dropRef}>
          <button
            type="button"
            onClick={() => setQuickOpen((value) => !value)}
            className="inline-flex items-center gap-2 rounded-xl bg-[#0078D4] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[#1a86d9]"
            aria-expanded={quickOpen}
            aria-haspopup="menu"
            title="Quick create"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New</span>
            <span className="rounded-md bg-black/15 px-1.5 py-0.5 text-[10px] font-mono text-white/80">⇧N</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${quickOpen ? "rotate-180" : ""}`} />
          </button>
          <AnimatePresence>
            {quickOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -4 }}
                transition={springs.snappy}
                className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-[#333] bg-[#1a1a1a] shadow-xl"
              >
                <div className="border-b border-[#2a2a2a] px-3 py-2">
                  <p className="text-xs font-semibold text-white">Quick create</p>
                  <p className="mt-1 text-[11px] text-[#666]">Jump into common operator workflows.</p>
                </div>
                <div className="py-1">
                  {QUICK_CREATE_ITEMS.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setQuickOpen(false)}
                      className="flex items-center gap-2 px-3 py-2.5 text-sm text-[#f2f2f2] transition-colors hover:bg-[#2a2a2a]"
                    >
                      <ExternalLink className="h-3.5 w-3.5 text-[#555]" />
                      {item.label}
                    </Link>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="hidden md:block">
          <ThemeToggle compact />
        </div>
        <div className="hidden md:block">
          <ClusterSelector />
        </div>
        <NotificationCenter />
        <Link
          href="/changelog"
          onClick={() => {
            try {
              localStorage.setItem("infraweaver:last-seen-version", appVersion);
            } catch {
              // ignore storage access errors
            }
            setShowChangelogDot(false);
          }}
          className="hidden items-center gap-3 border-l border-[#2a2a2a] pl-3 lg:flex"
          title="What’s new"
        >
          <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-[#0078D4] text-xs font-bold text-white">
            {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
            {showChangelogDot ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-[#141414]" /> : null}
          </div>
          <div className="min-w-0">
            <span className="block truncate text-xs text-[#9e9e9e]">{session?.user?.name ?? "Operator"}</span>
            <span className="block text-[10px] text-[#555]">What’s new</span>
          </div>
        </Link>
      </div>
    </header>
  );
}
