"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronDown, ExternalLink, Menu } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { WikiSearch } from "@/components/wiki/WikiSearch";
import { cn } from "@/lib/utils";

interface WikiPageMeta {
  slug: string;
  title: string;
  description: string;
}

interface WikiSectionMeta {
  id: string;
  title: string;
  description: string;
  pages: WikiPageMeta[];
}

interface WikiHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

interface WikiSearchDocument {
  id: string;
  title: string;
  description: string;
  sectionId: string;
  sectionTitle: string;
  href: string;
  content: string;
  keywords: string[];
}

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface WikiLayoutProps {
  title: string;
  description: string;
  breadcrumb: BreadcrumbItem[];
  sections: WikiSectionMeta[];
  toc: WikiHeading[];
  searchDocuments: WikiSearchDocument[];
  currentHref: string;
  currentSectionId?: string;
  editUrl?: string;
  children: React.ReactNode;
}

function TableOfContents({ toc }: { toc: WikiHeading[] }) {
  const [activeId, setActiveId] = useState<string | null>(toc[0]?.id ?? null);

  useEffect(() => {
    if (toc.length === 0) return;

    const headings = toc
      .map((item) => document.getElementById(item.id))
      .filter((element): element is HTMLElement => Boolean(element));

    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);

        if (visible[0]?.target.id) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: "0px 0px -70% 0px",
        threshold: [0.1, 0.5, 1],
      },
    );

    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [toc]);

  if (toc.length === 0) return null;

  return (
    <aside className="sticky top-6 hidden w-64 self-start xl:block">
      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-[#0b0f14] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">On this page</p>
        <nav className="mt-4 space-y-1.5">
          {toc.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={cn(
                "block rounded-lg px-3 py-2 text-sm transition",
                item.level === 3 ? "ml-4" : "",
                activeId === item.id
                  ? "bg-blue-500/15 text-blue-200"
                  : "text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white",
              )}
            >
              {item.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

function WikiSidebar({
  sections,
  currentHref,
  currentSectionId,
  onNavigate,
}: {
  sections: WikiSectionMeta[];
  currentHref: string;
  currentSectionId?: string;
  onNavigate?: () => void;
}) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((section) => [section.id, section.id === currentSectionId])),
  );

  useEffect(() => {
    if (!currentSectionId) return;
    setOpenSections((previous) => ({ ...previous, [currentSectionId]: true }));
  }, [currentSectionId]);

  return (
    <div className="space-y-2">
      <Link
        href="/wiki"
        onClick={onNavigate}
        className={cn(
          "block rounded-xl border px-4 py-3 transition",
          currentHref === "/wiki"
            ? "border-blue-500/40 bg-blue-500/10 text-blue-100"
            : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/[0.03] text-slate-800 dark:text-slate-200 hover:bg-gray-100 dark:hover:bg-white/[0.06]",
        )}
      >
        <p className="text-sm font-semibold">Wiki home</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Browse manuals, runbooks, and developer notes.</p>
      </Link>

      {sections.map((section) => {
        const isOpen = openSections[section.id] ?? false;

        return (
          <div key={section.id} className="overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-[#0b0f14]">
            <button
              type="button"
              onClick={() => setOpenSections((previous) => ({ ...previous, [section.id]: !isOpen }))}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{section.title}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{section.description}</p>
              </div>
              <ChevronDown className={cn("h-4 w-4 text-slate-500 transition", isOpen && "rotate-180")} />
            </button>
            {isOpen ? (
              <div className="border-t border-gray-200 dark:border-white/10 px-2 py-2">
                {section.pages.map((page) => {
                  const href = `/wiki/${section.id}/${page.slug}`;
                  const isActive = currentHref === href;

                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onNavigate}
                      className={cn(
                        "block rounded-xl px-3 py-2.5 text-sm transition",
                        isActive
                          ? "bg-blue-500/15 text-blue-100"
                          : "text-slate-700 dark:text-slate-300 hover:bg-white/[0.05] hover:text-gray-900 dark:hover:text-white",
                      )}
                    >
                      <span className="font-medium">{page.title}</span>
                      <span className="mt-1 block text-xs text-slate-500">{page.description}</span>
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function WikiLayout({
  title,
  description,
  breadcrumb,
  sections,
  toc,
  searchDocuments,
  currentHref,
  currentSectionId,
  editUrl,
  children,
}: WikiLayoutProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const resolvedHref = pathname ?? currentHref;

  const actions = useMemo(
    () => (
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        <WikiSearch documents={searchDocuments} />
        {editUrl ? (
          <a
            href={editUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm font-medium text-blue-100 transition hover:bg-blue-500/20"
          >
            Edit on GitHub
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}
      </div>
    ),
    [editUrl, searchDocuments],
  );

  return (
    <>
      <div className="flex gap-6 xl:gap-8">
        <aside className="hidden w-80 shrink-0 lg:block">
          <div className="sticky top-6">
            <WikiSidebar sections={sections} currentHref={resolvedHref} currentSectionId={currentSectionId} />
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/[0.03] px-3 py-2 text-sm text-slate-800 dark:text-slate-200 transition hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            >
              <Menu className="h-4 w-4" />
              Browse pages
            </button>
          </div>

          <PageHeader icon={BookOpen} title={title} subtitle={description} breadcrumb={breadcrumb} actions={actions} />

          <div className="rounded-3xl border border-gray-200 dark:border-white/10 bg-[#0b0f14] p-5 sm:p-6 lg:p-8">
            {children}
          </div>
        </div>

        <TableOfContents toc={toc} />
      </div>

      <BottomSheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Wiki pages">
        <div className="p-4">
          <WikiSidebar
            sections={sections}
            currentHref={resolvedHref}
            currentSectionId={currentSectionId}
            onNavigate={() => setMobileOpen(false)}
          />
        </div>
      </BottomSheet>
    </>
  );
}
