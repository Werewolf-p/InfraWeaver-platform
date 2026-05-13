"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Fuse from "fuse.js";
import { ArrowRight, FileSearch, Search, X } from "lucide-react";

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

function buildSnippet(content: string, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return content.slice(0, 140);

  const index = content.toLowerCase().indexOf(normalized);
  if (index === -1) return content.slice(0, 140);

  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + normalized.length + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

export function WikiSearch({ documents }: { documents: WikiSearchDocument[] }) {
  const [query, setQuery] = useState("");
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    if (query.trim()) setHasStarted(true);
  }, [query]);

  const searchEngine = useMemo(
    () =>
      hasStarted
        ? new Fuse(documents, {
            includeScore: true,
            ignoreLocation: true,
            threshold: 0.34,
            minMatchCharLength: 2,
            keys: [
              { name: "title", weight: 0.35 },
              { name: "sectionTitle", weight: 0.2 },
              { name: "description", weight: 0.15 },
              { name: "keywords", weight: 0.15 },
              { name: "content", weight: 0.15 },
            ],
          })
        : null,
    [documents, hasStarted],
  );

  const results = useMemo(() => {
    if (!query.trim() || !searchEngine) return [];
    return searchEngine.search(query.trim()).slice(0, 8);
  }, [query, searchEngine]);

  return (
    <div className="relative w-full min-w-0 lg:w-[28rem]">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the wiki"
          className="w-full rounded-xl border border-white/10 bg-[#0d1117] py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-slate-500 focus:border-blue-500/60 focus:outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-white"
            aria-label="Clear wiki search"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {query.trim() ? (
        <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f14] shadow-2xl">
          {results.length > 0 ? (
            <div className="divide-y divide-white/10">
              {results.map(({ item }) => (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setQuery("")}
                  className="block px-4 py-3 transition hover:bg-white/[0.04]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">{item.title}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-blue-300">{item.sectionTitle}</p>
                      <p className="mt-2 line-clamp-2 text-sm text-slate-300">{buildSnippet(item.content, query)}</p>
                    </div>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-500" />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-6 text-sm text-slate-400">
              <FileSearch className="h-4 w-4" />
              No wiki pages matched “{query.trim()}”.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
