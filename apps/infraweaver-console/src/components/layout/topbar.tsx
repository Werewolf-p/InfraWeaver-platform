"use client";
import { Menu, Search, Plus, ExternalLink } from "lucide-react";
import { NotificationCenter } from "@/components/ui/notification-center";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { titleForPathname } from "@/components/ui/breadcrumb";
import { ClusterSelector } from "@/components/layout/cluster-selector";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";

const QUICK_CREATE_ITEMS = [
  { label: "Deploy from Catalog", href: "/catalog-install" },
  { label: "Community App", href: "/community-apps" },
  { label: "Add DNS Record", href: "/dns" },
  { label: "Add Port Route", href: "/gameservers" },
];

export function TopBar({ onMenuClick, onSearchClick }: { title?: string; onMenuClick?: () => void; onSearchClick?: () => void }) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const currentTitle = titleForPathname(pathname);
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const [quickOpen, setQuickOpen] = useState(false);
  const [showChangelogDot, setShowChangelogDot] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("infraweaver:last-seen-version") !== appVersion;
    } catch {
      return false;
    }
  });
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setQuickOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <header className="flex min-h-14 flex-shrink-0 items-center justify-between gap-2 border-b border-[#2a2a2a] bg-[#141414] px-3 sm:min-h-12 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <button
          onClick={onMenuClick}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[#9e9e9e] transition-colors hover:bg-[#2a2a2a] hover:text-[#f2f2f2] md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>
        <Link href="/home" className="flex min-w-0 flex-1 items-center gap-2 md:hidden">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#0078D4] text-xs font-bold text-white">
            IW
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-[#f2f2f2]">InfraWeaver</p>
            <p className="truncate text-[10px] text-[#666]">{currentTitle}</p>
          </div>
        </Link>
        <button
          onClick={onSearchClick}
          className="hidden max-w-md flex-1 items-center gap-2 rounded border border-[#333] bg-[#0f0f0f] px-3 py-1.5 text-sm text-[#666] transition-colors hover:border-[#555] hover:text-[#9e9e9e] md:flex"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search resources...</span>
          <span className="ml-auto text-xs font-mono opacity-60">⌘K</span>
        </button>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2">
        <button
          onClick={onSearchClick}
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[#9e9e9e] transition-colors hover:bg-[#2a2a2a] hover:text-[#f2f2f2] md:hidden"
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
        <div className="relative hidden md:block" ref={dropRef}>
          <button
            onClick={() => setQuickOpen((v) => !v)}
            className="flex items-center gap-1 rounded bg-[#0078D4] px-2 py-1.5 text-xs text-white transition-colors hover:bg-[#1a86d9]"
            title="Quick create"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {quickOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-[#333] bg-[#1a1a1a] py-1 shadow-xl">
              {QUICK_CREATE_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setQuickOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-[#f2f2f2] transition-colors hover:bg-[#2a2a2a]"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-[#555]" />
                  {item.label}
                </Link>
              ))}
            </div>
          )}
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
            try { localStorage.setItem("infraweaver:last-seen-version", appVersion); } catch {}
            setShowChangelogDot(false);
          }}
          className="hidden items-center gap-2 border-l border-[#2a2a2a] pl-3 md:flex"
          title="What’s new"
        >
          <div className="relative flex h-7 w-7 items-center justify-center rounded-full bg-[#0078D4] text-xs font-bold text-white">
            {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
            {showChangelogDot ? <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-[#141414]" /> : null}
          </div>
          <div>
            <span className="block text-xs text-[#9e9e9e]">{session?.user?.name}</span>
            <span className="block text-[10px] text-[#555]">What’s new</span>
          </div>
        </Link>
      </div>
    </header>
  );
}
